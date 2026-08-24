/**
 * §8.4 generative — readPack over git's ENCODER PARAMETER SPACE.
 *
 * `readPack` is the one component fed attacker-controlled bytes, and every
 * git-produced pack the suite feeds it comes from a default `push` / `repack`
 * invocation. So the parser is measured against ONE point of git's encoder space —
 * and the wide COPY forms in `applyDelta` that our own encoder cannot emit (it
 * splits every copy at 0xFFFF) are exercised by nothing.
 *
 * This property varies the encoder instead of hand-building the bytes those
 * branches need: `--depth`, `--window`, `--delta-base-offset` (the OFS/REF wire
 * form) and `--no-reuse-delta` are generated, `git pack-objects` produces the pack,
 * and the parsed `{oid, type, content}` set must equal what git itself reports for
 * the same repo. A hand-built vector would be a GUESS about git's encoder; this is
 * a measurement of it.
 *
 * THE COVERAGE BARRIER is what makes the generator honest. A corpus that never
 * produced a delta would pass every assertion above, so each property fails unless
 * its packs actually contained the forms it exists to cover: an OFS_DELTA, a
 * REF_DELTA and a COPY of a full 64 KiB run here, and a COPY whose offset needs a
 * fourth byte (≥ 16 MiB) in the large-object property below.
 *
 * WHAT THE BARRIER MEASURED, and it is not what the parser's branch list suggests:
 * canonical git CAPS every COPY at 0x10000 bytes and writes that size as a literal
 * ZERO (the encoding `applyDelta` maps back to 0x10000), so git's own encoder never
 * sets the 3-byte size present bit `op & 0x40` — no repo shape and no encoder
 * setting in this corpus produced one, and the log line below reports the count so
 * the claim stays measured rather than remembered. The 4-byte OFFSET bit `op & 0x08`
 * IS ordinary git output (a large base with a late change reaches it), and this
 * property covers it. That asymmetry is why the wide-SIZE branch needs the hand
 * vectors in `delta.test.ts` and the wide-OFFSET branch does not: a hostile pack
 * can set either bit, but only one of them has a canonical-git witness.
 *
 * WHY THE PACK IS RE-WALKED HERE: those barriers are claims about the delta
 * PROGRAMS inside the pack, which `readPack` resolves and does not expose, and
 * which `verify-pack -v` does not describe (it renders OFS and REF identically and
 * reports a delta entry's own size, not its target's). `scanPack` below therefore
 * walks the entries a second time for their programs alone. It is not a second
 * parser on trust: every scan is ANCHORED — its entry count and its delta-entry OID
 * set must match `readPack`'s output and canonical `git verify-pack -v`, and each
 * program's decoded output length must equal the object `readPack` produced. If the
 * scanner were wrong, those anchors fail before any barrier is reported.
 *
 * SPEC-SUITE (executable spec, on the default gate — `pnpm run check`, pinned seed).
 * HERMETIC: no Postgres, no server — real `git` plus in-process `readPack`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateSync } from "node:zlib"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { decodeObjectHeader, PACK_OBJ_TYPE } from "@/pack/object-header"
import { readPack } from "@/pack/read-pack"
import {
	allObjectOids,
	loadAllObjects,
	parseVerifyPackObjects,
	requiredAt,
	requireGitOid,
} from "@/testing/git-fixtures"
import { spawnGit } from "@/testing/spawn-git"

/** The largest COPY the wire can express in two size bytes, plus one: a size at or
 * above it needs the third byte (`op & 0x40`), and it is also the value a size
 * field of 0 stands for. */
const WIDE_COPY_SIZE = 0x10000
/** A COPY reading from at or beyond here needs the fourth offset byte (`op & 0x08`). */
const WIDE_COPY_OFFSET = 2 ** 24

/**
 * One pack entry as it sits on the wire, plus which PRESENT BITS its delta program
 * actually set. The bits are the point: the branches under test in `applyDelta` are
 * selected by them, so counting the widths a copy's VALUE happens to reach would
 * report coverage the parser never executed.
 */
type ScannedEntry = {
	form: "base" | "ofs" | "ref"
	maxCopyOffset: number
	/** Bytes the program produces (copies + inserts) — must equal the object. */
	produced: number
	/** COPYs whose offset needed a fourth byte (`op & 0x08`). */
	wideOffsetOps: number
	/** COPYs whose size needed a third byte (`op & 0x40`). */
	wideSizeOps: number
	/** COPYs whose size field is 0 — the wire's encoding of a full 0x10000 run,
	 * and the one ≥ 64 KiB copy form git's own encoder emits. */
	zeroSizeOps: number
}

/** Decode a delta program's instruction stream: which COPY present bits it sets,
 * how far into the base it reads, and how many bytes it produces in total. */
function summarizeDelta(program: Buffer): Omit<ScannedEntry, "form"> {
	let pos = 0
	const varint = (): number => {
		let result = 0
		let shift = 0
		let byte: number
		do {
			byte = program.readUInt8(pos)
			pos += 1
			result += (byte & 0x7f) * 2 ** shift
			shift += 7
		} while (byte & 0x80)
		return result
	}
	varint() // source size
	varint() // target size
	let maxCopyOffset = 0
	let produced = 0
	let wideOffsetOps = 0
	let wideSizeOps = 0
	let zeroSizeOps = 0
	while (pos < program.length) {
		const op = program.readUInt8(pos)
		pos += 1
		if (op & 0x80) {
			let copyOffset = 0
			if (op & 0x01) copyOffset += program.readUInt8(pos++)
			if (op & 0x02) copyOffset += program.readUInt8(pos++) * 2 ** 8
			if (op & 0x04) copyOffset += program.readUInt8(pos++) * 2 ** 16
			if (op & 0x08) copyOffset += program.readUInt8(pos++) * 2 ** 24
			let copySize = 0
			if (op & 0x10) copySize += program.readUInt8(pos++)
			if (op & 0x20) copySize += program.readUInt8(pos++) * 2 ** 8
			if (op & 0x40) copySize += program.readUInt8(pos++) * 2 ** 16
			if (op & 0x08) wideOffsetOps += 1
			if (op & 0x40) wideSizeOps += 1
			if (copySize === 0) {
				copySize = WIDE_COPY_SIZE
				zeroSizeOps += 1
			}
			maxCopyOffset = Math.max(maxCopyOffset, copyOffset)
			produced += copySize
		} else if (op !== 0) {
			pos += op
			produced += op
		} else {
			throw new Error("delta program carries the reserved opcode 0x00")
		}
	}
	return { maxCopyOffset, produced, wideOffsetOps, wideSizeOps, zeroSizeOps }
}

/** Node's sync zlib returns `{buffer, engine}` under `info: true`, where the engine
 * reports how many COMPRESSED bytes the stream consumed — the only way to step to
 * the next pack entry. `@types/node` carries no overload for that shape. */
type InflateInfo = { buffer: Buffer; engine: { bytesWritten: number } }

const inflateInfoSchema = z
	.object({
		buffer: z.instanceof(Buffer),
		engine: z.object({ bytesWritten: z.number() }).passthrough(),
	})
	.passthrough()

function inflateEntry(pack: Buffer, offset: number): InflateInfo {
	return inflateInfoSchema.parse(inflateSync(pack.subarray(offset), { info: true }))
}

/** The OFS_DELTA back-offset varint's LENGTH (its value is `readPack`'s business;
 * the scan only needs to step over it). */
function offsetVarintLength(pack: Buffer, offset: number): number {
	let length = 1
	while (pack.readUInt8(offset + length - 1) & 0x80) length += 1
	return length
}

/**
 * Walk a v2 pack's entries in wire order, reporting each one's delta form and the
 * shape of its program. Anchored by the caller against `readPack` and canonical
 * `git verify-pack -v` — see the file header.
 */
function scanPack(pack: Buffer): ScannedEntry[] {
	const entries: ScannedEntry[] = []
	const count = pack.readUInt32BE(8)
	let offset = 12
	for (let i = 0; i < count; i++) {
		const { type, bytesRead } = decodeObjectHeader(pack, offset)
		offset += bytesRead
		let form: ScannedEntry["form"] = "base"
		if (type === PACK_OBJ_TYPE.OFS_DELTA) {
			form = "ofs"
			offset += offsetVarintLength(pack, offset)
		} else if (type === PACK_OBJ_TYPE.REF_DELTA) {
			form = "ref"
			offset += 20
		}
		const { buffer, engine } = inflateEntry(pack, offset)
		offset += engine.bytesWritten
		entries.push(
			form === "base"
				? {
						form,
						maxCopyOffset: 0,
						produced: buffer.length,
						wideOffsetOps: 0,
						wideSizeOps: 0,
						zeroSizeOps: 0,
					}
				: { ...summarizeDelta(buffer), form },
		)
	}
	return entries
}

/** Where `git pack-objects` wrote one pack, and the bytes it wrote. */
type ProducedPack = { bytes: Buffer; idxPath: string }

type EncoderOptions = {
	deltaBaseOffset: boolean
	depth: number
	noReuseDelta: boolean
	window: number
}

const encoderArb: fc.Arbitrary<EncoderOptions> = fc.record({
	// OFF is what makes git emit REF_DELTA instead of OFS_DELTA — the wire form our
	// own writer never produces and a real client's thin push always does.
	deltaBaseOffset: fc.boolean(),
	depth: fc.integer({ max: 50, min: 1 }),
	noReuseDelta: fc.boolean(),
	// 0 disables delta compression outright — a legitimate encoder point that feeds
	// readPack a pack of nothing but base entries.
	window: fc.integer({ max: 250, min: 0 }),
})

async function packRepo(
	dir: string,
	outDir: string,
	options: EncoderOptions,
): Promise<ProducedPack> {
	const prefix = join(outDir, "p")
	const out = await spawnGit(
		[
			"pack-objects",
			"--revs",
			"--all",
			"-q",
			`--depth=${options.depth}`,
			`--window=${options.window}`,
			...(options.deltaBaseOffset ? ["--delta-base-offset"] : []),
			...(options.noReuseDelta ? ["--no-reuse-delta"] : []),
			prefix,
		],
		{ cwd: dir },
	)
	const hash = requireGitOid(out.stdout.trim(), "git pack-objects output")
	return {
		bytes: readFileSync(`${prefix}-${hash}.pack`),
		idxPath: `${prefix}-${hash}.idx`,
	}
}

/**
 * The differential: everything `readPack` recovered from `pack` must be exactly
 * what canonical git holds in `dir`. Returns the scanned entries so the caller can
 * tally coverage — the scan is anchored here, against both `readPack` and
 * `verify-pack -v`, before any caller reads it.
 */
async function expectPackMatchesGit(
	dir: string,
	pack: ProducedPack,
): Promise<ScannedEntry[]> {
	const parsed = await readPack(pack.bytes)

	expect(parsed.map((p) => p.oid).sort()).toEqual(await allObjectOids(dir))
	const byBytes = (
		a: { content: Buffer; type: string },
		b: { content: Buffer; type: string },
	): number => a.type.localeCompare(b.type) || Buffer.compare(a.content, b.content)
	const recovered = parsed
		.map((p) => ({ content: p.content, type: p.type }))
		.sort(byBytes)
	const canonical = (await loadAllObjects(dir))
		.map((o) => ({ content: o.content, type: o.type }))
		.sort(byBytes)
	expect(recovered.length).toBe(canonical.length)
	for (const [i, got] of recovered.entries()) {
		const want = requiredAt(canonical, i, "canonical object list")
		expect(got.type).toBe(want.type)
		expect(
			Buffer.compare(got.content, want.content),
			`object ${i} (${got.type}, ${got.content.length} bytes) differs from git's`,
		).toBe(0)
	}

	const entries = scanPack(pack.bytes)
	expect(entries.length).toBe(parsed.length)
	for (const [i, entry] of entries.entries()) {
		if (entry.form === "base") continue
		const object = requiredAt(parsed, i, "parsed pack")
		expect(
			entry.produced,
			`delta program ${i} produces ${entry.produced} bytes, the object is ${object.content.length}`,
		).toBe(object.content.length)
	}
	const verify = await spawnGit(["verify-pack", "-v", pack.idxPath], { cwd: dir })
	const gitDeltaOids = parseVerifyPackObjects(verify.stdout)
		.filter((o) => o.kind === "delta")
		.map((o) => o.oid)
		.sort()
	const scannedDeltaOids = parsed
		.filter((_, i) => requiredAt(entries, i, "scanned pack").form !== "base")
		.map((p) => p.oid)
		.sort()
	expect(scannedDeltaOids).toEqual(gitDeltaOids)
	return entries
}

/** What the corpus realized, across every candidate — the coverage barrier. */
type Coverage = {
	maxCopyOffset: number
	ofs: number
	ref: number
	wideOffsetOps: number
	wideSizeOps: number
	zeroSizeOps: number
}

function newCoverage(): Coverage {
	return {
		maxCopyOffset: 0,
		ofs: 0,
		ref: 0,
		wideOffsetOps: 0,
		wideSizeOps: 0,
		zeroSizeOps: 0,
	}
}

function tallyCoverage(coverage: Coverage, entries: ScannedEntry[]): void {
	for (const entry of entries) {
		if (entry.form === "ofs") coverage.ofs += 1
		if (entry.form === "ref") coverage.ref += 1
		coverage.maxCopyOffset = Math.max(coverage.maxCopyOffset, entry.maxCopyOffset)
		coverage.wideOffsetOps += entry.wideOffsetOps
		coverage.wideSizeOps += entry.wideSizeOps
		coverage.zeroSizeOps += entry.zeroSizeOps
	}
}

function reportCoverage(label: string, coverage: Coverage): string {
	return `[${label}] ofs=${coverage.ofs} ref=${coverage.ref} copies-of-0x10000=${coverage.zeroSizeOps} wide-offset-ops=${coverage.wideOffsetOps} wide-size-ops=${coverage.wideSizeOps} max-copy-offset=${coverage.maxCopyOffset}`
}

/** A deterministic line-oriented file: near-identical revisions of one of these is
 * what makes git's encoder emit long COPY runs. */
function baseLines(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${i} sedimentary aeolian quartzite bed`)
}

type FileSpec = { edits: number[][]; lineCount: number }

const shapeArb = fc.array(
	fc.record({
		// Each revision replaces 1-3 lines; ~38 bytes/line, so the unchanged runs
		// between edits are the ≥ 64 KiB copies the wide size field needs.
		edits: fc.array(fc.array(fc.nat({ max: 5999 }), { maxLength: 3, minLength: 1 }), {
			maxLength: 2,
		}),
		lineCount: fc.integer({ max: 6000, min: 2000 }),
	}),
	{ maxLength: 2, minLength: 1 },
)

/** Replay one shape into a real repo. Every write is committed before the next
 * one, so the object store holds nothing unreachable — which is what lets the pack
 * (`--revs --all`, reachable objects only) be compared against the whole store. */
async function buildRepo(dir: string, shape: FileSpec[]): Promise<void> {
	await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
	const contents = shape.map((f) => baseLines(f.lineCount))
	const flush = (i: number): void => {
		const content = requiredAt(contents, i, "generated file contents")
		writeFileSync(join(dir, `f${i}.txt`), `${content.join("\n")}\n`)
	}
	const commit = async (message: string): Promise<void> => {
		await spawnGit(["add", "."], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", message], { cwd: dir })
	}
	for (let i = 0; i < shape.length; i++) flush(i)
	await commit("v0")

	const rounds = Math.max(...shape.map((f) => f.edits.length))
	for (let round = 0; round < rounds; round++) {
		for (const [i, file] of shape.entries()) {
			const edit = file.edits[round]
			if (!edit) continue
			const content = requiredAt(contents, i, "generated file contents")
			for (const line of edit) {
				content[line % file.lineCount] = `mutated ${round} ${line}`
			}
			flush(i)
		}
		await commit(`v${round + 1}`)
	}
}

async function withTempDirPair<T>(
	fn: (dir: string, outDir: string) => Promise<T>,
): Promise<T> {
	const dirs = [
		mkdtempSync(join(tmpdir(), "pggit-pack-parse-")),
		mkdtempSync(join(tmpdir(), "pggit-pack-parse-")),
	] as const
	try {
		return await fn(dirs[0], dirs[1])
	} finally {
		for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
	}
}

describe("§8.4 generative — readPack vs git's encoder parameter space", () => {
	it("recovers every object git holds, across generated shapes and encoder options", async () => {
		const coverage = newCoverage()
		await fc.assert(
			fc.asyncProperty(shapeArb, encoderArb, async (shape, options) => {
				await withTempDirPair(async (dir, outDir) => {
					await buildRepo(dir, shape)
					const pack = await packRepo(dir, outDir, options)
					tallyCoverage(coverage, await expectPackMatchesGit(dir, pack))
				})
			}),
			{ numRuns: 25, seed: 424_242 },
		)
		console.log(reportCoverage("pack-parse corpus", coverage))
		expect(coverage.ofs, "no candidate pack carried an OFS_DELTA").toBeGreaterThan(0)
		expect(coverage.ref, "no candidate pack carried a REF_DELTA").toBeGreaterThan(0)
		expect(
			coverage.zeroSizeOps,
			"no COPY reached 64 KiB (the size-0 encoding applyDelta maps to 0x10000)",
		).toBeGreaterThan(0)
	}, 600_000)

	it("recovers a delta over a >16 MiB base, exercising the 4-byte COPY offset", async () => {
		// The wide OFFSET field needs a base ≥ 16 MiB with the change late in it, so
		// the copy that follows reads from an offset the low three bytes cannot hold.
		// One fixture pair covers it; the wire form is looped rather than generated
		// because OFS vs REF is a property of the ENTRY header, not of the program.
		const coverage = newCoverage()
		await withTempDirPair(async (dir, outDir) => {
			await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
			const lines = baseLines(520_000)
			writeFileSync(join(dir, "big.txt"), `${lines.join("\n")}\n`)
			lines[Math.floor(lines.length * 0.9)] = "mutated late in a very large file"
			writeFileSync(join(dir, "big2.txt"), `${lines.join("\n")}\n`)
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "large near-identical pair"], {
				cwd: dir,
			})

			for (const deltaBaseOffset of [true, false]) {
				const pack = await packRepo(dir, outDir, {
					deltaBaseOffset,
					depth: 50,
					noReuseDelta: true,
					window: 10,
				})
				tallyCoverage(coverage, await expectPackMatchesGit(dir, pack))
			}
		})
		console.log(reportCoverage("pack-parse wide", coverage))
		expect(coverage.ofs, "the OFS pass carried no OFS_DELTA").toBeGreaterThan(0)
		expect(coverage.ref, "the REF pass carried no REF_DELTA").toBeGreaterThan(0)
		expect(
			coverage.wideOffsetOps,
			"no COPY set the 4-byte offset present bit",
		).toBeGreaterThan(0)
		expect(coverage.maxCopyOffset).toBeGreaterThanOrEqual(WIDE_COPY_OFFSET)
	}, 600_000)
})
