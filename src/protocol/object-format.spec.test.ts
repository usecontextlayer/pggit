/**
 * §10 boundary: object-format negotiation + the zero-want case. pggit is SHA-1
 * only (the charter). A SHA-256 client must get a CLEAN rejection — not a
 * mid-parse failure from 40-hex/20-byte width assumptions hitting 64-hex OIDs.
 * A zero-want fetch, by contrast, is NOT malformed: git treats it as a no-op, so
 * we match the oracle (empty pack) rather than rejecting.
 */
import { describe, expect, it } from "vitest"
import { writePack } from "@/pack/write-pack"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { GitProtocolError } from "@/protocol/errors"
import { handleReceivePack, type ReceiveBackend } from "@/protocol/receive-pack"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { sidebandDemux } from "@/testing/pkt-oracle"

const A = "a".repeat(40)
const Z = "0".repeat(40)

/** A benign read-only upload backend (no mutating methods to guard). */
const stubUpload: RepoBackend = {
	buildPack: async () => writePack([]),
	commonHaves: async () => [],
	getObject: async () => null,
	getSymref: async () => null,
	listRefs: async () => [],
	readyToGiveUp: async () => false,
}

/** A receive backend that records whether its MUTATING methods ran, so the test
 * can assert the real safety contract: a sha256 push must reject before ingesting
 * (ingesting a pack of 64-hex OIDs would corrupt the sha1 store). */
function recordingReceive() {
	const calls = { applyRefUpdates: 0, ingest: 0, isConnected: 0 }
	const backend: ReceiveBackend = {
		applyRefUpdates: async (cmds) => {
			calls.applyRefUpdates++
			return cmds.map(() => true)
		},
		ingest: async () => {
			calls.ingest++
		},
		isConnected: async () => {
			calls.isConnected++
			return true
		},
	}
	return { backend, calls }
}

describe("upload-pack rejects a SHA-256 client cleanly", () => {
	it("throws GitProtocolError (a clean rejection, not a mid-parse width failure)", async () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from("command=fetch\n")),
			encodePktLine(Buffer.from("object-format=sha256\n")),
			encodePkt({ type: "delim" }),
			encodePktLine(Buffer.from(`want ${A}\n`)),
			encodePkt({ type: "flush" }),
		])
		await expect(handleUploadPack(body, stubUpload)).rejects.toThrow(GitProtocolError)
	})
})

describe("receive-pack rejects a SHA-256 client cleanly", () => {
	it("throws GitProtocolError and never ingests the pack", async () => {
		const body = Buffer.concat([
			encodePktLine(
				Buffer.from(`${Z} ${A} refs/heads/main\0report-status object-format=sha256`),
			),
			encodePkt({ type: "flush" }),
		])
		const { backend, calls } = recordingReceive()
		await expect(handleReceivePack(body, backend)).rejects.toThrow(GitProtocolError)
		// The real contract: no side effect — the pack is never ingested, no ref touched.
		expect(calls.ingest).toBe(0)
		expect(calls.applyRefUpdates).toBe(0)
	})
})

describe("fetch with zero wants is a no-op (matches git's oracle)", () => {
	it("returns an empty packfile rather than erroring", async () => {
		// git's upload-pack treats a wantless fetch as a no-op (upload-pack.c:
		// "they didn't want anything") and returns an empty pack — pggit must NOT
		// diverge from the oracle by rejecting it.
		const backend: RepoBackend = {
			buildPack: async () => writePack([]),
			commonHaves: async () => [],
			getObject: async () => null,
			getSymref: async () => null,
			listRefs: async () => [],
			readyToGiveUp: async () => false,
		}
		const body = Buffer.concat([
			encodePktLine(Buffer.from("command=fetch\n")),
			encodePkt({ type: "delim" }),
			encodePktLine(Buffer.from("done\n")),
			encodePkt({ type: "flush" }),
		])
		const out = await handleUploadPack(body, backend)
		// An empty but valid pack rides band 1 (PACK magic, zero objects).
		expect(sidebandDemux(out).band1.subarray(0, 4).toString("latin1")).toBe("PACK")
	})
})
