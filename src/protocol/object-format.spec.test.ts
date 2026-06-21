/**
 * §10 boundary: object-format negotiation + the no-want guard. pggit is SHA-1
 * only (the charter). A SHA-256 client must get a CLEAN rejection — not a
 * mid-parse failure from 40-hex/20-byte width assumptions hitting 64-hex OIDs.
 * Likewise a fetch with zero wants is malformed and must fail loud rather than
 * silently serving a valid empty pack.
 */
import { describe, expect, it } from "vitest"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { GitProtocolError } from "@/protocol/errors"
import { handleReceivePack, type ReceiveBackend } from "@/protocol/receive-pack"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { assertSupportedObjectFormat } from "@/protocol/v2"

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

describe("fetch with zero wants fails loud", () => {
	it("throws GitProtocolError instead of serving an empty pack", async () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from("command=fetch\n")),
			encodePkt({ type: "delim" }),
			encodePktLine(Buffer.from("done\n")),
			encodePkt({ type: "flush" }),
		])
		await expect(handleUploadPack(body, untouchedUpload)).rejects.toThrow(
			GitProtocolError,
		)
	})
})
