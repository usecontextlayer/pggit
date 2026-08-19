import { isOid, type Oid, ZERO_OID } from "@/oid"
import { AGENT, assertSupportedObjectFormat } from "@/protocol/capabilities"
import { GitProtocolError } from "@/protocol/errors"
import { decodePktStream, encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { encodeSideband, SIDEBAND_DATA } from "@/protocol/sideband"

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
export type CommandResult = { ref: string; ok: boolean; reason?: string }

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
		const line = r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? "failed"}\n`
		lines.push(encodePktLine(Buffer.from(line)))
	}
	lines.push(encodePkt({ type: "flush" }))
	const report = Buffer.concat(lines)
	if (!useSideband) return report
	return Buffer.concat([
		encodeSideband(SIDEBAND_DATA, report),
		encodePkt({ type: "flush" }),
	])
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
	/** Refresh the queryable file projection for a just-applied ref. Present only
	 * when the (optional) queryable-view layer is wired; a plain remote omits it. */
	syncRefSnapshot?: (ref: string, newOid: Oid) => Promise<void>
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
 * non-FF; nothing legitimate deletes branches). Creates are unrestricted. This
 * is the server-side backstop that makes a `push --force` from ANY client a
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

	// rc3 boundary check: a ref name too long to store is rejected BEFORE ingest — so
	// an all-unstorable push never ingests a pack (no orphaned objects), and the raw
	// btree error never escapes as a 500.
	const nameTooLong = commands.map(
		(c) => Buffer.byteLength(c.ref, "utf8") > MAX_REF_NAME_BYTES,
	)
	const anyApplicable = nameTooLong.length === 0 || nameTooLong.some((t) => !t)

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
			nameTooLong[i] || c.newOid === ZERO_OID
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
			nameTooLong[i] || !connected[i] || c.oldOid === ZERO_OID || c.newOid === ZERO_OID
				? Promise.resolve(true)
				: backend.isAncestor(c.oldOid, c.newOid),
		),
	)
	// Per-command disqualification reason (null ⇒ applicable): a too-long name fails
	// the storage boundary, a disconnected tip fails connectivity, and the
	// deny-non-FF policy fails deletions + non-fast-forward updates. A
	// disqualified command never touches a ref.
	const reasons = commands.map((c, i) =>
		nameTooLong[i]
			? "funny refname (too long to store)"
			: !connected[i]
				? "missing necessary objects"
				: c.newOid === ZERO_OID
					? "deletion denied (refs only advance)"
					: fastForward[i]
						? null
						: "non-fast-forward (refs only advance)",
	)
	if (atomic && reasons.some((r) => r !== null)) {
		const failed = commands.map((c, i) => ({
			ok: false,
			reason: reasons[i] ?? "atomic transaction failed",
			ref: c.ref,
		}))
		return encodeReportStatus(unpackStatus, failed, useSideband)
	}

	// Apply only the applicable commands; a disqualified one never touches a ref.
	const oks = await backend.applyRefUpdates(
		commands.filter((_, i) => reasons[i] === null),
		atomic,
	)
	let applied = 0
	const results: CommandResult[] = commands.map((c, i) => {
		const reason = reasons[i]
		if (reason !== null) return { ok: false, reason, ref: c.ref }
		return oks[applied++]
			? { ok: true, ref: c.ref }
			: {
					ok: false,
					reason: atomic
						? "atomic transaction failed"
						: "stale ref (compare-and-swap failed)",
					ref: c.ref,
				}
	})

	// Post-commit: refresh the queryable file projection for each applied ref. The
	// view layer decides branch-filtering and build-vs-drop. Sequential — same-repo
	// rebuilds must not race the shared-blob reaper.
	for (const [i, c] of commands.entries()) {
		if (!results[i]?.ok) continue
		// rc2: the queryable view is a DERIVED projection — a rebuild failure (e.g. a
		// tip that is not a commit, which buildFileList cannot walk) must NEVER roll
		// back or 500 an already-applied push (rebuild.ts's standing contract). Absorb
		// it loudly to the log; the projection is rebuilt on the next push to the ref.
		try {
			await backend.syncRefSnapshot?.(c.ref, c.newOid)
		} catch (err) {
			console.error(
				`pggit: snapshot refresh failed for ${c.ref} (the push is already applied):`,
				err,
			)
		}
	}
	return encodeReportStatus(unpackStatus, results, useSideband)
}
