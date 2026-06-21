/**
 * §10 boundary: object-format negotiation + the zero-want case. pggit is SHA-1
 * only (the charter). A SHA-256 client must get a CLEAN rejection — not a
 * mid-parse failure from 40-hex/20-byte width assumptions hitting 64-hex OIDs.
 * A zero-want fetch, by contrast, is NOT malformed: git treats it as a no-op, so
 * we match the oracle (empty pack) rather than rejecting.
 */
import { describe, expect, it } from "vitest"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { GitProtocolError } from "@/protocol/errors"
import { handleReceivePack, type ReceiveBackend } from "@/protocol/receive-pack"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { assertSupportedObjectFormat } from "@/protocol/v2"
import { sidebandDemux } from "@/testing/pkt-oracle"

const A = "a".repeat(40)
const Z = "0".repeat(40)

const untouchedUpload = new Proxy({} as RepoBackend, {
	get() {
		throw new Error("upload backend must not be reached on a format rejection")
	},
})
const untouchedReceive = new Proxy({} as ReceiveBackend, {
	get() {
		throw new Error("receive backend must not be reached on a format rejection")
	},
})

describe("assertSupportedObjectFormat", () => {
	it("accepts sha1 or an absent object-format cap", () => {
		expect(() =>
			assertSupportedObjectFormat(["object-format=sha1", "agent=x"]),
		).not.toThrow()
		expect(() => assertSupportedObjectFormat([])).not.toThrow()
	})

	it("rejects a non-sha1 object-format", () => {
		expect(() => assertSupportedObjectFormat(["object-format=sha256"])).toThrow(
			GitProtocolError,
		)
	})
})

describe("upload-pack rejects a SHA-256 client cleanly", () => {
	it("throws GitProtocolError before touching the backend", async () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from("command=fetch\n")),
			encodePktLine(Buffer.from("object-format=sha256\n")),
			encodePkt({ type: "delim" }),
			encodePktLine(Buffer.from(`want ${A}\n`)),
			encodePkt({ type: "flush" }),
		])
		await expect(handleUploadPack(body, untouchedUpload)).rejects.toThrow(
			GitProtocolError,
		)
	})
})

describe("receive-pack rejects a SHA-256 client cleanly", () => {
	it("throws GitProtocolError before touching the backend", async () => {
		const body = Buffer.concat([
			encodePktLine(
				Buffer.from(`${Z} ${A} refs/heads/main\0report-status object-format=sha256`),
			),
			encodePkt({ type: "flush" }),
		])
		await expect(handleReceivePack(body, untouchedReceive)).rejects.toThrow(
			GitProtocolError,
		)
	})
})

describe("fetch with zero wants is a no-op (matches git's oracle)", () => {
	it("returns an empty packfile rather than erroring", async () => {
		// git's upload-pack treats a wantless fetch as a no-op (upload-pack.c:
		// "they didn't want anything") and returns an empty pack — pggit must NOT
		// diverge from the oracle by rejecting it.
		const backend: RepoBackend = {
			getObject: async () => null,
			getSymref: async () => null,
			listRefs: async () => [],
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
