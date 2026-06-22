/**
 * §10 mid-serve failure contract. The spec reserves side-band band-3 for an error
 * that arises AFTER the packfile section has started streaming. pggit's serve path
 * MATERIALIZES the whole pack (`handleFetch` returns `encodePackfileResponse(await
 * buildDeltaPack(...))` — a complete Buffer) BEFORE the HTTP layer sends a byte, so
 * the no-partial-stream property is structural (the `Promise<Buffer>` return type),
 * not something a test can observe directly. What these tests DO assert is the
 * observable consequence: a mid-serve read failure REJECTS (no Buffer is returned)
 * rather than being swallowed into an empty/partial pack — so it reaches the HTTP
 * boundary's 500. (band-3 stays deferred until serving becomes streaming — see the
 * gap analysis; there is no mid-stream window to signal on today.)
 */
import { describe, expect, it } from "vitest"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"

const WANT = "a".repeat(40)

function cloneFetch(): Buffer {
	return Buffer.concat([
		encodePktLine(Buffer.from("command=fetch\n")),
		encodePkt({ type: "delim" }),
		encodePktLine(Buffer.from(`want ${WANT}\n`)),
		encodePktLine(Buffer.from("done\n")),
		encodePkt({ type: "flush" }),
	])
}

describe("fetch — a mid-serve read failure rejects before any pack byte", () => {
	it("propagates a thrown getObject error (no partial packfile is produced)", async () => {
		const backend: RepoBackend = {
			getObject: async () => {
				throw new Error("simulated mid-serve read failure")
			},
			getSymref: async () => null,
			listRefs: async () => [],
		}
		await expect(handleUploadPack(cloneFetch(), backend)).rejects.toThrow(
			/mid-serve read failure/,
		)
	})

	it("rejects loud when a wanted object is missing from the store", async () => {
		const backend: RepoBackend = {
			getObject: async () => null, // the want resolves to nothing
			getSymref: async () => null,
			listRefs: async () => [],
		}
		// The contract is "rejects rather than returning a partial/empty pack"; the
		// message is an internal-invariant string (free to reword). The fully-
		// controlled backend means the missing want is the only rejection path.
		await expect(handleUploadPack(cloneFetch(), backend)).rejects.toThrow()
	})
})
