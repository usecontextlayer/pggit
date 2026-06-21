import { decodePktStream, encodePkt, encodePktLine } from "@/pkt-line"
import { AGENT } from "@/protocol/v2"

const ZERO_OID = "0".repeat(40)
const SIDEBAND_DATA = 0x01
// band byte + report data must fit the pkt-line writer cap (65515).
const MAX_BAND_DATA = 65514

// The push capabilities we advertise AND honor (spec §4): report-status over
// side-band, ref deletion, atomic mode, sha1. We pick plain `report-status`
// (not `-v2`) — we do not emit its extra option lines.
const RECEIVE_CAPS = [
	"report-status",
	"delete-refs",
	"side-band-64k",
	"atomic",
	"object-format=sha1",
	`agent=${AGENT}`,
]

export type RefCommand = { oldOid: string; newOid: string; ref: string }
export type ReceiveRequest = { commands: RefCommand[]; caps: string[]; pack: Buffer }
export type CommandResult = { ref: string; ok: boolean; reason?: string }

function isZero(oid: string): boolean {
	return /^0{40}$/.test(oid)
}

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
	const { packets, rest } = decodePktStream(body, { stopAtFlush: true })
	const commands: RefCommand[] = []
	let caps: string[] = []
	for (const p of packets) {
		if (p.type !== "data") continue
		let line = p.payload.toString("utf8").replace(/\n$/, "")
		const nul = line.indexOf("\0")
		if (nul >= 0) {
			caps = line
				.slice(nul + 1)
				.split(" ")
				.filter(Boolean)
			line = line.slice(0, nul)
		}
		const [oldOid, newOid, ref] = line.split(" ")
		if (oldOid && newOid && ref) commands.push({ newOid, oldOid, ref })
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

	const parts: Buffer[] = []
	for (let i = 0; i < report.length; i += MAX_BAND_DATA) {
		const chunk = report.subarray(i, i + MAX_BAND_DATA)
		parts.push(encodePktLine(Buffer.concat([Buffer.from([SIDEBAND_DATA]), chunk])))
	}
	parts.push(encodePkt({ type: "flush" }))
	return Buffer.concat(parts)
}

/** Everything receive-pack needs from a single repo's storage. */
export type ReceiveBackend = {
	ingest: (pack: Buffer) => Promise<void>
	createRef: (name: string, newOid: string) => Promise<boolean>
	updateRef: (name: string, oldOid: string, newOid: string) => Promise<boolean>
	deleteRef: (name: string, oldOid: string) => Promise<boolean>
}

/**
 * Apply one ref command via CAS against the client's advertised old oid: create
 * (zero→new), update (old→new), or delete (old→zero). Non-ff is accepted by
 * default — CAS guards concurrency, not ancestry (spec §3.6).
 */
async function applyCommand(
	backend: ReceiveBackend,
	cmd: RefCommand,
): Promise<CommandResult> {
	if (isZero(cmd.oldOid)) {
		const created = await backend.createRef(cmd.ref, cmd.newOid)
		return created
			? { ok: true, ref: cmd.ref }
			: { ok: false, reason: "ref already exists", ref: cmd.ref }
	}
	if (isZero(cmd.newOid)) {
		const deleted = await backend.deleteRef(cmd.ref, cmd.oldOid)
		return deleted
			? { ok: true, ref: cmd.ref }
			: { ok: false, reason: "stale ref (compare-and-swap failed)", ref: cmd.ref }
	}
	const updated = await backend.updateRef(cmd.ref, cmd.oldOid, cmd.newOid)
	return updated
		? { ok: true, ref: cmd.ref }
		: { ok: false, reason: "stale ref (compare-and-swap failed)", ref: cmd.ref }
}

/**
 * Handle a receive-pack POST: ingest the pack (if any), then apply each ref
 * command under CAS, and report status. A failed unpack fails every ref.
 */
export async function handleReceivePack(
	body: Buffer,
	backend: ReceiveBackend,
): Promise<Buffer> {
	const { commands, caps, pack } = parseReceivePack(body)
	const useSideband = caps.includes("side-band-64k")

	let unpackStatus = "ok"
	if (pack.length > 0) {
		try {
			await backend.ingest(pack)
		} catch (e) {
			unpackStatus = (e instanceof Error ? e.message : "unpack failed").replace(
				/\n/g,
				" ",
			)
		}
	}

	const results: CommandResult[] = []
	for (const cmd of commands) {
		if (unpackStatus !== "ok") {
			results.push({ ok: false, reason: "unpacker error", ref: cmd.ref })
			continue
		}
		results.push(await applyCommand(backend, cmd))
	}
	return encodeReportStatus(unpackStatus, results, useSideband)
}
