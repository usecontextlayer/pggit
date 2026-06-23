import { createHash } from "node:crypto"
import { createInflate } from "node:zlib"
import { count } from "@/instrument"
import { GitFormatError } from "@/object/format-error"
import { computeOid, type GitObjectType } from "@/object/object"
import { applyDelta } from "@/pack/delta"
import { decodeObjectHeader, PACK_OBJ_TYPE } from "@/pack/object-header"

export type ParsedObject = {
	type: GitObjectType
	content: Buffer
	oid: string
}

const CODE_TO_TYPE: Record<number, GitObjectType> = {
	[PACK_OBJ_TYPE.COMMIT]: "commit",
	[PACK_OBJ_TYPE.TREE]: "tree",
	[PACK_OBJ_TYPE.BLOB]: "blob",
	[PACK_OBJ_TYPE.TAG]: "tag",
}

type RawEntry =
	| { kind: "base"; type: GitObjectType; content: Buffer }
	| { kind: "ofs"; baseOffset: number; delta: Buffer }
	| { kind: "ref"; baseOid: string; delta: Buffer }

type Resolved = { type: GitObjectType; content: Buffer }

/**
 * Inflate exactly one zlib stream at the front of `buf`, returning the data and
 * how many COMPRESSED bytes it consumed — the seam for walking the back-to-back
 * zlib streams in a packfile. (`bytesWritten` = input consumed up to
 * Z_STREAM_END; trailing bytes untouched — verified empirically against
 * node:zlib.)
 */
function inflateOne(buf: Buffer): Promise<{ data: Buffer; compressedLength: number }> {
	return new Promise((resolve, reject) => {
		const inf = createInflate()
		const chunks: Buffer[] = []
		inf.on("data", (chunk: Buffer) => chunks.push(chunk))
		inf.on("end", () =>
			resolve({ compressedLength: inf.bytesWritten, data: Buffer.concat(chunks) }),
		)
		inf.on("error", (e) =>
			reject(
				new GitFormatError(
					"inflate-failed",
					`pack: zlib inflate failed: ${e instanceof Error ? e.message : String(e)}`,
				),
			),
		)
		inf.end(buf)
	})
}

/**
 * The pack OFS_DELTA "offset encoding" — NOT plain LEB128. Each continuation
 * adds 1 before shifting, so encodings are unambiguous. Arithmetic (not `<<`) so
 * offsets ≥ 2³¹ stay correct.
 */
function readOffsetVarint(
	buf: Buffer,
	offset: number,
): { value: number; bytesRead: number } {
	let b = buf.readUInt8(offset)
	let bytesRead = 1
	let value = b & 0x7f
	while (b & 0x80) {
		b = buf.readUInt8(offset + bytesRead)
		bytesRead += 1
		value = (value + 1) * 128 + (b & 0x7f)
	}
	return { bytesRead, value }
}

/**
 * Parse a v2 packfile into its objects, resolving OFS_DELTA and REF_DELTA
 * (including delta chains). Bases come from the same pack; a REF_DELTA whose base
 * is NOT in the pack — a thin pack, as `git push` sends by default — is resolved
 * via `resolveExternalBase` (the Postgres store on push ingest). Without a
 * resolver, an external base is a hard error.
 */
export async function readPack(
	pack: Buffer,
	resolveExternalBase?: (oid: string) => Promise<Resolved | null>,
): Promise<ParsedObject[]> {
	count("readPackCalls")
	if (pack.subarray(0, 4).toString("latin1") !== "PACK") {
		throw new GitFormatError("bad-magic", "pack: bad magic")
	}
	const version = pack.readUInt32BE(4)
	if (version !== 2) {
		throw new GitFormatError(
			"unsupported-version",
			`pack: unsupported version ${version}`,
		)
	}
	const objectCount = pack.readUInt32BE(8)

	const trailerOffset = pack.length - 20
	const actualTrailer = createHash("sha1")
		.update(pack.subarray(0, trailerOffset))
		.digest()
	if (!pack.subarray(trailerOffset).equals(actualTrailer)) {
		throw new GitFormatError("trailer-mismatch", "pack: trailer SHA-1 mismatch")
	}

	// Pass 1 — parse every entry's raw form, keyed by its start offset.
	const entries = new Map<number, RawEntry>()
	const order: number[] = []
	let offset = 12
	for (let i = 0; i < objectCount; i++) {
		const start = offset
		const { type, size, bytesRead } = decodeObjectHeader(pack, offset)
		offset += bytesRead

		if (type === PACK_OBJ_TYPE.OFS_DELTA) {
			const { value: negOffset, bytesRead: ob } = readOffsetVarint(pack, offset)
			offset += ob
			const { data, compressedLength } = await inflateOne(pack.subarray(offset))
			count("bytesInflated", data.length)
			offset += compressedLength
			entries.set(start, { baseOffset: start - negOffset, delta: data, kind: "ofs" })
		} else if (type === PACK_OBJ_TYPE.REF_DELTA) {
			const baseOid = pack.subarray(offset, offset + 20).toString("hex")
			offset += 20
			const { data, compressedLength } = await inflateOne(pack.subarray(offset))
			count("bytesInflated", data.length)
			offset += compressedLength
			entries.set(start, { baseOid, delta: data, kind: "ref" })
		} else {
			const typeName = CODE_TO_TYPE[type]
			if (!typeName) {
				throw new GitFormatError(
					"unknown-object-type",
					`pack: unknown object type ${type}`,
				)
			}
			const { data, compressedLength } = await inflateOne(pack.subarray(offset))
			count("bytesInflated", data.length)
			if (data.length !== size) {
				throw new GitFormatError(
					"size-mismatch",
					`pack: size mismatch (header ${size}, inflated ${data.length})`,
				)
			}
			offset += compressedLength
			entries.set(start, { content: data, kind: "base", type: typeName })
		}
		order.push(start)
	}
	if (offset !== trailerOffset) {
		throw new GitFormatError(
			"trailing-bytes",
			`pack: consumed ${offset} bytes, expected ${trailerOffset} before trailer`,
		)
	}

	// Pass 2 — resolve deltas by base availability (git's index-pack approach). Each
	// pass resolves every still-pending delta whose base is now known: by offset
	// (OFS_DELTA), by OID from an already-resolved pack object (REF_DELTA), or from
	// the external resolver (a thin pack's store-resident base, fetched once). A
	// REF_DELTA base may itself be another in-pack delta's OUTPUT, so we cannot index
	// OIDs up front — we iterate to a fixpoint instead, which also handles arbitrary
	// chains and pack orderings. A pass that resolves nothing while entries remain ⇒
	// a genuinely missing base or a cycle.
	const resolved = new Map<number, ParsedObject>()
	const byOid = new Map<string, ParsedObject>()
	const externalCache = new Map<string, Resolved | null>()

	const fetchExternal = async (oid: string): Promise<Resolved | null> => {
		const cached = externalCache.get(oid)
		if (cached !== undefined) return cached
		const fetched = resolveExternalBase ? await resolveExternalBase(oid) : null
		externalCache.set(oid, fetched)
		return fetched
	}

	const record = (off: number, type: GitObjectType, content: Buffer): void => {
		const obj: ParsedObject = { content, oid: computeOid(type, content), type }
		resolved.set(off, obj)
		byOid.set(obj.oid, obj)
	}

	for (const off of order) {
		const entry = entries.get(off)
		if (entry?.kind === "base") record(off, entry.type, entry.content)
	}

	let pending = order.filter((off) => !resolved.has(off))
	while (pending.length > 0) {
		const stillPending: number[] = []
		for (const off of pending) {
			const entry = entries.get(off)
			if (!entry || entry.kind === "base") continue
			const base: Resolved | null =
				entry.kind === "ofs"
					? (resolved.get(entry.baseOffset) ?? null)
					: (byOid.get(entry.baseOid) ?? (await fetchExternal(entry.baseOid)))
			if (!base) {
				stillPending.push(off)
				continue
			}
			record(off, base.type, applyDelta(base.content, entry.delta))
		}
		if (stillPending.length === pending.length) {
			const off = stillPending[0] as number
			const entry = entries.get(off)
			const base =
				entry?.kind === "ref"
					? entry.baseOid
					: `offset ${entry?.kind === "ofs" ? entry.baseOffset : "?"}`
			throw new GitFormatError(
				"unresolved-base",
				`pack: ref-delta base ${base} not found in pack or store`,
			)
		}
		pending = stillPending
	}

	return order.map((off) => resolved.get(off) as ParsedObject)
}
