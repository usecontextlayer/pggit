/**
 * §10 mid-serve failure contract. The spec reserves side-band band-3 for an error
 * that arises AFTER the packfile section has started streaming. pggit's serve path
 * MATERIALIZES the whole pack (`buildDeltaPack` returns a complete Buffer) BEFORE
 * `encodePackfileResponse` frames the first byte — so a read failure throws before
 * any response byte exists. There is no mid-stream window, hence no band-3 to emit;
 * the failure must surface as a clean rejection (→ the HTTP boundary's 500), never
 * a truncated band-1 stream. These tests pin that contract (band-3 stays deferred
 * until serving becomes streaming — see the gap analysis).
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
		await expect(handleUploadPack(cloneFetch(), backend)).rejects.toThrow(/not found/)
	})
})
