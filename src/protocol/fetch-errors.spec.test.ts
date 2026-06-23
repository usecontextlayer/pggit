/**
 * §10 serve-failure contract. pggit's serve path MATERIALIZES the whole pack
 * (`handleFetch` returns `encodePackfileResponse(await backend.buildPack(...))` — a
 * complete Buffer) BEFORE the HTTP layer sends a byte, so the no-partial-stream
 * property is structural (the `Promise<Buffer>` return type). The graph logic now
 * lives in the store's `buildPack` (set-based SQL over the row+edge model), so a
 * serve failure surfaces as a `buildPack` rejection. What this asserts is the
 * observable consequence: such a failure REJECTS (no Buffer is returned) rather
 * than being swallowed into an empty/partial pack — so it reaches the HTTP
 * boundary's 500. The store's own rejection of a missing want is pinned against a
 * real store in m1-multiround; here we pin that `handleFetch` propagates it. (band-3
 * stays deferred until serving becomes streaming — there is no mid-stream window to
 * signal on today.)
 */
import { describe, expect, it } from "vitest"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
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

/** A backend whose serve path fails — the graph logic lives in buildPack now. */
function failingServe(message: string): RepoBackend {
	return {
		buildPack: async () => {
			throw new Error(message)
		},
		commonHaves: async () => [],
		getSymref: async () => null,
		listRefs: async () => [],
		readyToGiveUp: async () => false,
	}
}

describe("fetch — a serve failure rejects before any pack byte", () => {
	it("propagates a buildPack failure rather than emitting a partial/empty pack", async () => {
		await expect(
			handleUploadPack(cloneFetch(), failingServe("simulated mid-serve read failure")),
		).rejects.toThrow(/mid-serve read failure/)
	})
})
