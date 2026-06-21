/**
 * §8.1 ls-refs HANDLER behavior — ref-prefix filtering (testing #8) and the
 * `unborn` feature (functionality #3), driven through `handleUploadPack` against
 * an in-memory backend. The wire ENCODER goldens live in upload-pack-wire.spec;
 * here we pin what the HANDLER selects/emits, mirroring git's t5701 ls-refs cases
 * and `ls-refs.c` `send_possibly_unborn_head` (unborn HEAD requires BOTH the
 * `unborn` and `symrefs` args, exactly as git does).
 */
import { describe, expect, it } from "vitest"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { pktLineUnpack } from "@/testing/pkt-oracle"

const MAIN = "a".repeat(40)
const DEV = "b".repeat(40)
const V1 = "c".repeat(40)

/** A minimal in-memory ls-refs backend: a ref list + an optional HEAD symref. */
function backend(refs: { name: string; oid: string }[], head?: string): RepoBackend {
	return {
		getObject: async () => null,
		getSymref: async (name) => (name === "HEAD" && head ? head : null),
		listRefs: async () => refs,
	}
}

/** Build + drive an ls-refs request with the given argument lines. */
function lsRefs(b: RepoBackend, args: string[]): Promise<string> {
	const body = Buffer.concat([
		encodePktLine(Buffer.from("command=ls-refs\n")),
		encodePkt({ type: "delim" }),
		...args.map((a) => encodePktLine(Buffer.from(`${a}\n`))),
		encodePkt({ type: "flush" }),
	])
	return handleUploadPack(body, b).then(pktLineUnpack)
}

const POPULATED = backend(
	[
		{ name: "refs/heads/dev", oid: DEV },
		{ name: "refs/heads/main", oid: MAIN },
		{ name: "refs/tags/v1", oid: V1 },
	],
	"refs/heads/main",
)

describe("ls-refs handler — ref-prefix filtering", () => {
	it("returns every ref (and HEAD) when no prefix is given", async () => {
		expect(await lsRefs(POPULATED, ["symrefs"])).toBe(
			`${MAIN} HEAD symref-target:refs/heads/main\n` +
				`${DEV} refs/heads/dev\n${MAIN} refs/heads/main\n${V1} refs/tags/v1\n0000\n`,
		)
	})

	it("returns only matching refs and EXCLUDES HEAD when the prefix doesn't cover it", async () => {
		expect(await lsRefs(POPULATED, ["ref-prefix refs/tags/"])).toBe(
			`${V1} refs/tags/v1\n0000\n`,
		)
		expect(await lsRefs(POPULATED, ["ref-prefix refs/heads/"])).toBe(
			`${DEV} refs/heads/dev\n${MAIN} refs/heads/main\n0000\n`,
		)
	})
})

describe("ls-refs handler — unborn HEAD (empty repo)", () => {
	const EMPTY = backend([], "refs/heads/main")

	it("emits `unborn HEAD symref-target:<branch>` when both unborn+symrefs are requested", async () => {
		expect(await lsRefs(EMPTY, ["unborn", "symrefs"])).toBe(
			"unborn HEAD symref-target:refs/heads/main\n0000\n",
		)
	})

	it("emits nothing for HEAD when `unborn` is requested without `symrefs` (matches git)", async () => {
		expect(await lsRefs(EMPTY, ["unborn"])).toBe("0000\n")
	})

	it("emits just a flush for an empty repo when `unborn` is not requested", async () => {
		expect(await lsRefs(EMPTY, ["symrefs"])).toBe("0000\n")
	})

	it("suppresses the unborn HEAD when a ref-prefix excludes it (matches git's prefix filter)", async () => {
		// git runs HEAD through the same ref_match as any ref (ls-refs.c send_ref),
		// so an unborn HEAD under a non-covering prefix must NOT be emitted.
		expect(await lsRefs(EMPTY, ["unborn", "symrefs", "ref-prefix refs/tags/"])).toBe(
			"0000\n",
		)
	})

	it("a populated HEAD is a normal oid line even when unborn is requested", async () => {
		expect(await lsRefs(POPULATED, ["unborn", "symrefs"])).toBe(
			`${MAIN} HEAD symref-target:refs/heads/main\n` +
				`${DEV} refs/heads/dev\n${MAIN} refs/heads/main\n${V1} refs/tags/v1\n0000\n`,
		)
	})
})
