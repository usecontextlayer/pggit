/**
 * §8.3 byte-exact pkt-line FRAMING corpus. The ONLY gate on the literal 4-hex
 * length prefixes a real git client parses. Assertions compare encoder output to
 * fixed RAW BYTES — deliberately NOT routed through `framedPktLines` /
 * `pktLineUnpack`, which RECOMPUTE the prefix from the decoded payload
 * (pkt-oracle.ts says so verbatim) and would therefore pass a wrong-but-self-
 * consistent prefix. The corpus is the spec basis (empty `0004`, sizes near the
 * caps, the `0000`/`0001`/`0002` specials); the round-trip cross-checks our
 * framing against bytes captured from real git.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { decodePktStream, encodePkt, encodePktLine, WRITER_MAX_PAYLOAD } from "@/pkt-line"
import { spawnGit } from "@/testing/spawn-git"

/** Raw latin1 bytes (binary-safe) for asserting against literal hex frames. */
const bytes = (s: string) => Buffer.from(s, "latin1")

describe("§8.3 pkt-line framing — literal byte corpus", () => {
	it("frames a payload as <4-hex len><payload>, length INCLUSIVE of the prefix", () => {
		// "hello\n" = 6 bytes ⇒ 6 + 4 = 10 = 0x0a ⇒ "000a".
		expect(encodePktLine(bytes("hello\n"))).toEqual(bytes("000ahello\n"))
	})

	it("frames an empty payload as 0004 (NOT a flush)", () => {
		expect(encodePktLine(Buffer.alloc(0))).toEqual(bytes("0004"))
	})

	it("frames sizes near 1000 with correct hex width", () => {
		// payload 996 ⇒ 1000 = 0x3e8 ⇒ "03e8".
		const out = encodePktLine(Buffer.alloc(996, 0x61))
		expect(out.subarray(0, 4)).toEqual(bytes("03e8"))
		expect(out.length).toBe(1000)
	})

	it("frames the maximum writer payload as ffef and rejects one byte more", () => {
		// WRITER_MAX_PAYLOAD 65515 ⇒ 65519 = 0xffef ⇒ "ffef".
		const out = encodePktLine(Buffer.alloc(WRITER_MAX_PAYLOAD, 0x62))
		expect(out.subarray(0, 4)).toEqual(bytes("ffef"))
		expect(() => encodePktLine(Buffer.alloc(WRITER_MAX_PAYLOAD + 1))).toThrow(/exceeds/)
	})

	it("frames the three special zero-payload packets as their bare four hex digits", () => {
		expect(encodePkt({ type: "flush" })).toEqual(bytes("0000"))
		expect(encodePkt({ type: "delim" })).toEqual(bytes("0001"))
		expect(encodePkt({ type: "response-end" })).toEqual(bytes("0002"))
	})

	it("preserves NUL and high bytes in the payload (binary-safe framing)", () => {
		const payload = Buffer.from([0x61, 0x00, 0xff, 0x01])
		expect(encodePktLine(payload)).toEqual(Buffer.concat([bytes("0008"), payload]))
	})
})

describe("§8.3 pkt-line framing — round-trips real git's advertisement byte-for-byte", () => {
	it("re-frames `git upload-pack --advertise-refs` output identically", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pggit-framing-"))
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "a.txt"), "hi\n")
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "seed"], { cwd: dir })
			await spawnGit(["tag", "-a", "v1", "-m", "rel"], { cwd: dir })

			const advert = (await spawnGit(["upload-pack", "--advertise-refs", dir]))
				.stdoutBytes
			expect(advert.subarray(0, 4).toString("latin1")).toMatch(/^[0-9a-f]{4}$/)

			// Decode git's real wire bytes, then re-encode each packet through OUR
			// framer. A byte-identical result proves our 4-hex prefixes match git's.
			const { packets, rest } = decodePktStream(advert)
			expect(rest.length).toBe(0)
			expect(Buffer.concat(packets.map(encodePkt))).toEqual(advert)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})
