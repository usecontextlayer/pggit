import type { GitObjectType } from "@/object/object"
import { isOid, type Oid, ZERO_OID } from "@/object/oid"
import { AGENT, assertSupportedObjectFormat } from "@/protocol/capabilities"
import { GitProtocolError } from "@/protocol/errors"
import { decodePktStream, encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { encodeSidebandData } from "@/protocol/sideband"

/** A ref name longer than this (bytes) is rejected at the boundary: `git_ref`'s PK is
 * a btree on (repo_id, name) whose index entry overflows past ~2704 bytes, which
 * Postgres raises as an opaque storage error. The cap sits far above any real ref name
 * and safely under the btree limit, so a too-long name fails loud + in-band (`ng`),
 * never as an HTTP 500 that has already orphaned the ingested pack. */
const MAX_REF_NAME_BYTES = 2000

// The push capabilities we advertise (spec §4): report-status over side-band,
// ref deletion, atomic mode, sha1. `delete-refs` stays advertised even though
// the deny-non-FF policy refuses every delete — advertising keeps the refusal
// in-band (a per-ref `ng` with the policy reason) instead of a client-side
// "remote does not support deleting refs". We pick plain `report-status`
// (not `-v2`) — we do not emit its extra option lines.
const RECEIVE_CAPS = [
	"report-status",
	"delete-refs",
	"side-band-64k",
	"atomic",
	"object-format=sha1",
	`agent=${AGENT}`,
]

/** Command lines decode with `fatal: true`: a refname reaches Postgres as
 * `text`, so pggit requires valid UTF-8 (design D16 — a deliberate divergence
 * from git's bytes-are-bytes refnames). A lossy decode would U+FFFD-rename the
 * ref silently, and two distinct refnames can collide on one `git_ref` PK
 * value. A name whose bytes cannot decode also cannot be echoed truthfully in a
 * per-ref `ng`, so the rejection is protocol-level, like any malformed line. */
const UTF8_STRICT = new TextDecoder("utf8", { fatal: true })

export type RefCommand = { oldOid: Oid; newOid: Oid; ref: string }
export type ReceiveRequest = { commands: RefCommand[]; caps: string[]; pack: Buffer }
export type CommandResult =
	| { ref: string; ok: true }
	| { ref: string; ok: false; reason: string }

type CommandDecision = { kind: "apply" } | { kind: "reject"; reason: string }

/**
 * v0 ref advertisement for receive-pack (push). An empty repo — the dominant
 * first-push state — emits the synthetic `0{40} capabilities^{}` line so the
 * client has somewhere to read the push capabilities.
 */
export function encodeReceivePackAdvertisement(
	refs: { name: string; oid: string }[],
): Buffer {
	const capStr = RECEIVE_CAPS.join(" ")
	const lines: Buffer[] = []
	if (refs.length === 0) {
		lines.push(encodePktLine(Buffer.from(`${ZERO_OID} capabilities^{}\0${capStr}\n`)))
	} else {
		refs.forEach((r, i) => {
			const base = `${r.oid} ${r.name}`
			lines.push(
				encodePktLine(Buffer.from(i === 0 ? `${base}\0${capStr}\n` : `${base}\n`)),
			)
		})
	}
	lines.push(encodePkt({ type: "flush" }))
	return Buffer.concat(lines)
}

/**
 * Parse the receive-pack POST body: a pkt-line command list (`<old> <new> <ref>`,
 * caps after a NUL on the first line), a flush, then the raw packfile.
 */
export function parseReceivePack(body: Buffer): ReceiveRequest {
	const { packets, rest, flushed } = decodePktStream(body, { stopAtFlush: true })
	// A non-empty command list MUST be terminated by a flush before the pack. Without
	// it, decodePktStream falls off the end (a truncated/length-overrunning command
	// pkt-line) and hands the framing garbage back as `rest` — which would otherwise
	// be mis-fed to the pack reader. Reject the framing fault loudly. An empty body is
	// the legitimate zero-command no-op and is left alone.
	if (!flushed && body.length > 0) {
		throw new GitProtocolError(
			"receive-pack: command list not terminated by a flush (truncated or length-overrunning pkt-line)",
		)
	}
	const commands: RefCommand[] = []
	let caps: string[] = []
	for (const p of packets) {
		if (p.type !== "data") continue
		let line: string
		try {
			line = UTF8_STRICT.decode(p.payload).replace(/\n$/, "")
		} catch {
			throw new GitProtocolError(
				"receive-pack: command line is not valid UTF-8 (pggit refnames are UTF-8)",
			)
		}
		const nul = line.indexOf("\0")
		if (nul >= 0) {
			caps = line
				.slice(nul + 1)
				.split(" ")
				.filter(Boolean)
			line = line.slice(0, nul)
		}
		// Fail loud: a command line is exactly `<old> <new> <ref>`. Anything else is
		// malformed — reject it rather than silently drop it (which would apply a
		// partial command set with no diagnostic).
		const parts = line.split(" ")
		const [oldOid, newOid, ref] = parts
		if (parts.length !== 3 || !oldOid || !newOid || !ref) {
			throw new GitProtocolError(
				`receive-pack: malformed command line ${JSON.stringify(line)}`,
			)
		}
		// Both ids must be well-formed OIDs BEFORE anything trusts them: downstream
		// Buffer.from(oid, "hex") conversions (store CAS, connectivity/ancestry
		// walks) silently yield a short or empty buffer for garbage — the same
		// boundary rule as parseFetch's want check. The zero sentinel is shape-valid.
		if (!isOid(oldOid) || !isOid(newOid)) {
			throw new GitProtocolError(
				`receive-pack: malformed object id in command ${JSON.stringify(line)}`,
			)
		}
		commands.push({ newOid, oldOid, ref })
	}
	return { caps, commands, pack: rest }
}

/**
 * report-status: `unpack <status>` then `ok <ref>` / `ng <ref> <reason>` per
 * command, flush. When side-band-64k is negotiated the whole stream rides band 1.
 */
export function encodeReportStatus(
	unpack: string,
	results: CommandResult[],
	useSideband: boolean,
): Buffer {
	const lines: Buffer[] = [encodePktLine(Buffer.from(`unpack ${unpack}\n`))]
	for (const r of results) {
		const line = r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`
		lines.push(encodePktLine(Buffer.from(line)))
	}
	lines.push(encodePkt({ type: "flush" }))
	const report = Buffer.concat(lines)
	if (!useSideband) return report
	return Buffer.concat([encodeSidebandData(report), encodePkt({ type: "flush" })])
}

/**
 * git's `check_refname_format` for a full ref name, as receive-pack applies it
 * (builtin/receive-pack.c `update()`): the name must live under `refs/`, and no
 * component may be empty, start with `.`, end with `.lock`, or contain `..`,
 * `@{`, control bytes, space, or the `~^:?*[\` set; the name must not end with
 * `/` or `.`. Returns null when well-formed. Validated HERE, at the wire
 * boundary — a funny name that reached storage would poison every later
 * advertisement and status line a git client parses.
 */
export function refNameProblem(ref: string): string | null {
	if (!ref.startsWith("refs/")) return "funny refname (must be under refs/)"
	// Canonical receive-pack validates the part AFTER "refs/" WITHOUT
	// ALLOW_ONELEVEL: a bare one-level name ("refs/heads" itself) is funny — and
	// accepting it would D/F-poison the whole refs/heads/* namespace.
	if (ref.split("/").length < 3) return "funny refname (one-level name)"
	if (ref.endsWith("/") || ref.endsWith(".")) return "funny refname"
	if (ref.includes("..") || ref.includes("@{")) return "funny refname"
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the control-byte ban IS the rule
	if (/[\u0000-\u001f\u007f ~^:?*[\\]/.test(ref)) return "funny refname"
	for (const component of ref.split("/")) {
		if (component === "") return "funny refname (empty component)"
		if (component.startsWith(".")) return "funny refname"
		if (component.endsWith(".lock")) return "funny refname"
	}
	return null
}

/** Everything receive-pack needs from a single repo's storage. */
export type ReceiveBackend = {
	ingest: (pack: Buffer) => Promise<void>
	/** Apply ref CAS updates; `atomic` ⇒ all-or-nothing. Per-command success flags. */
	applyRefUpdates: (commands: RefCommand[], atomic: boolean) => Promise<boolean[]>
	/** Is every object reachable from `oid` present? (connectivity, spec §10). */
	isConnected: (oid: Oid) => Promise<boolean>
	/** Is `ancestor` in `descendant`'s history (or equal)? The fast-forward
	 * policy check — see the deny-non-FF rules on handleReceivePack. */
	isAncestor: (ancestor: Oid, descendant: Oid) => Promise<boolean>
	/** The repo's current ref NAMES — the directory/file conflict check's
	 * existing side (git: `refs/heads/a` and `refs/heads/a/b` cannot coexist). */
	listRefNames: () => Promise<string[]>
	/** The stored type of `oid`, or null when absent — the branch-tip policy
	 * (git: a new value under refs/heads/ must be a commit). */
	objectType: (oid: Oid) => Promise<GitObjectType | null>
	/** Synchronize the queryable file projection for a just-applied ref. Present only
	 * when the optional `repo_file` projection is wired; a plain remote omits it. */
	syncRefProjection?: (ref: string, newOid: Oid) => Promise<void>
}

/**
 * Handle a receive-pack POST: ingest the pack (if any), then apply the ref
 * commands under CAS — atomically when the client negotiated `atomic` — and
 * report status. A failed unpack fails every ref; an atomic failure ng's every
 * ref (none applied).
 *
 * DENY-NON-FF POLICY (workspace-writes model, 2026-07-05): a ref may only
 * ADVANCE. Updates must be fast-forward (old reachable from new — checked here
 * as server policy; the CAS in the store keeps guarding concurrency, not
 * ancestry), and deletions are denied outright (a delete is the ultimate
 * non-FF; nothing legitimate deletes branches). Creates skip the ancestry check,
 * while the branch-tip rule below still requires `refs/heads/*` to name commits.
 * This is the server-side backstop that makes a `push --force` from ANY client a
 * loud `ng` instead of a silent history overwrite — and since refs only move
 * forward, GC can never reclaim a commit that was rewound away. Note the pack
 * is ingested BEFORE policy runs (protocol order), so a denied push leaves
 * orphaned objects — ordinary GC food, not corruption.
 */
export async function handleReceivePack(
	body: Buffer,
	backend: ReceiveBackend,
): Promise<Buffer> {
	const { commands, caps, pack } = parseReceivePack(body)
	assertSupportedObjectFormat(caps)
	const useSideband = caps.includes("side-band-64k")
	const atomic = caps.includes("atomic")

	// A ref name too long to store, or malformed under git's
	// check-ref-format rules, is rejected BEFORE ingest — so an all-unstorable
	// push never ingests a pack (no orphaned objects), and the raw btree error
	// never escapes as a 500. (Directory/file conflicts are judged LATER, after
	// every other check — see the two-phase D/F block below.)
	const nameProblem = commands.map((c) =>
		Buffer.byteLength(c.ref, "utf8") > MAX_REF_NAME_BYTES
			? "funny refname (too long to store)"
			: refNameProblem(c.ref),
	)
	const anyApplicable =
		nameProblem.length === 0 || nameProblem.some((problem) => problem === null)

	let unpackStatus = "ok"
	if (pack.length > 0 && anyApplicable) {
		try {
			await backend.ingest(pack)
		} catch (e) {
			unpackStatus = (e instanceof Error ? e.message : "unpack failed").replace(
				/\n/g,
				" ",
			)
		}
	}

	if (unpackStatus !== "ok") {
		const failed = commands.map((c) => ({
			ok: false,
			reason: "unpacker error",
			ref: c.ref,
		}))
		return encodeReportStatus(unpackStatus, failed, useSideband)
	}

	// Connectivity (spec §10): a create/update must leave its new tip fully reachable
	// in the store; a delete (newOid zero) needs no objects. A too-long ref is already
	// disqualified, so it skips the closure walk.
	const connected = await Promise.all(
		commands.map((c, i) =>
			nameProblem[i] !== null || c.newOid === ZERO_OID
				? Promise.resolve(true)
				: backend.isConnected(c.newOid),
		),
	)
	// The deny-non-FF policy (see the handler docstring): an UPDATE (both oids
	// non-zero) must be a fast-forward. Checked against the client's asserted
	// old oid — if that assertion is stale the CAS rejects anyway, so a passing
	// ancestry check + a passing CAS TOGETHER guarantee the applied update
	// advanced the ref. Deletes never reach this check (denied below); creates
	// and already-disqualified commands skip it.
	const fastForward = await Promise.all(
		commands.map((c, i) =>
			nameProblem[i] !== null ||
			!connected[i] ||
			c.oldOid === ZERO_OID ||
			c.newOid === ZERO_OID
				? Promise.resolve(true)
				: backend.isAncestor(c.oldOid, c.newOid),
		),
	)
	// Branch-tip typing (git's rule, observed on canonical receive-pack): a new
	// value under refs/heads/ must be a COMMIT — a blob or tree tip is rejected
	// per-ref as "invalid new value provided" (git's wording). Other namespaces
	// (refs/tags/ especially) accept any object type.
	const validTip = await Promise.all(
		commands.map((c, i) =>
			nameProblem[i] !== null ||
			!connected[i] ||
			c.newOid === ZERO_OID ||
			!c.ref.startsWith("refs/heads/")
				? Promise.resolve(true)
				: backend.objectType(c.newOid).then((t) => t === "commit"),
		),
	)
	// Directory/file conflicts are judged last in two ordered phases: first disqualify names that conflict with the fixed existing namespace (including symrefs), then keep only the deepest name among the per-command survivors. A rejected command must not reserve the namespace against a valid sibling, so every per-command verdict, including fast-forward, participates in the survivor filter. One pass is sufficient because prefix transitivity lets the deepest survivor defeat every shallower name directly.
	const existingNames = await backend.listRefNames()
	for (const [i, c] of commands.entries()) {
		if (
			nameProblem[i] !== null ||
			!connected[i] ||
			!validTip[i] ||
			c.newOid === ZERO_OID
		) {
			continue
		}
		const clashesExisting = existingNames.some(
			(other) =>
				other !== c.ref &&
				(other.startsWith(`${c.ref}/`) || c.ref.startsWith(`${other}/`)),
		)
		if (clashesExisting) nameProblem[i] = "funny refname (directory/file conflict)"
	}
	const perCommandSurvivors = commands.map(
		(c, i) =>
			nameProblem[i] === null &&
			connected[i] === true &&
			validTip[i] === true &&
			fastForward[i] === true &&
			c.newOid !== ZERO_OID,
	)
	const perCommandSurvivorNames = commands
		.filter((_c, i) => perCommandSurvivors[i])
		.map((c) => c.ref)
	for (const [i, c] of commands.entries()) {
		if (!perCommandSurvivors[i]) continue
		if (perCommandSurvivorNames.some((other) => other.startsWith(`${c.ref}/`))) {
			nameProblem[i] = "funny refname (directory/file conflict)"
		}
	}
	// Per-command decision: a too-long name fails the storage boundary, a
	// disconnected tip fails connectivity, and the deny-non-FF policy fails
	// deletions + non-fast-forward updates. The discriminant carries whether the
	// command may reach storage; no null sentinel is left for consumers to decode.
	const evaluated = commands.map(
		(
			command,
			i,
		): {
			command: RefCommand
			decision: CommandDecision
		} => {
			const problem = nameProblem[i]
			let decision: CommandDecision
			if (typeof problem === "string") {
				decision = { kind: "reject", reason: problem }
			} else if (!connected[i]) {
				decision = { kind: "reject", reason: "missing necessary objects" }
			} else if (!validTip[i]) {
				decision = { kind: "reject", reason: "invalid new value provided" }
			} else if (command.newOid === ZERO_OID) {
				decision = { kind: "reject", reason: "deletion denied (refs only advance)" }
			} else if (!fastForward[i]) {
				decision = { kind: "reject", reason: "non-fast-forward (refs only advance)" }
			} else {
				decision = { kind: "apply" }
			}
			return { command, decision }
		},
	)
	if (atomic && evaluated.some(({ decision }) => decision.kind === "reject")) {
		const failed: CommandResult[] = evaluated.map(({ command, decision }) => ({
			ok: false,
			reason: decision.kind === "reject" ? decision.reason : "atomic transaction failed",
			ref: command.ref,
		}))
		return encodeReportStatus(unpackStatus, failed, useSideband)
	}

	// Apply only the applicable commands; a disqualified one never touches a ref.
	const oks = await backend.applyRefUpdates(
		evaluated
			.filter(({ decision }) => decision.kind === "apply")
			.map(({ command }) => command),
		atomic,
	)
	let applied = 0
	const outcomes = evaluated.map(
		({
			command,
			decision,
		}): {
			command: RefCommand
			result: CommandResult
		} => {
			if (decision.kind === "reject") {
				return {
					command,
					result: { ok: false, reason: decision.reason, ref: command.ref },
				}
			}
			const result: CommandResult = oks[applied++]
				? { ok: true, ref: command.ref }
				: {
						ok: false,
						reason: atomic
							? "atomic transaction failed"
							: "stale ref (compare-and-swap failed)",
						ref: command.ref,
					}
			return { command, result }
		},
	)
	const results = outcomes.map(({ result }) => result)

	// Post-commit: sync the queryable file projection for each applied ref. The
	// projection layer decides branch filtering and advance-vs-drop.
	for (const { command, result } of outcomes) {
		if (!result.ok) continue
		// The file index is DERIVED: a sync failure must never roll back or 500 an
		// already-applied push. Log it loudly; because rows and their recorded basis
		// advance together, the next push retries from the same basis.
		try {
			await backend.syncRefProjection?.(command.ref, command.newOid)
		} catch (err) {
			console.error(
				`pggit: file projection sync failed for ${command.ref} (the push is already applied):`,
				err,
			)
		}
	}
	return encodeReportStatus(unpackStatus, results, useSideband)
}
