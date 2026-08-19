import { describe, expect, it } from "vitest"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { ackSection } from "@/testing/upload-pack-oracle"

const data = (payload: string) => encodePktLine(Buffer.from(payload, "utf8"))

describe("ackSection", () => {
	it("renders the complete acknowledgments section before the delimiter", () => {
		const response = Buffer.concat([
			data("acknowledgments\n"),
			data("ready\n"),
			encodePkt({ type: "delim" }),
			data("packfile\n"),
			encodePkt({ type: "flush" }),
		])

		expect(ackSection(response)).toBe("acknowledgments\nready\n")
	})

	it("rejects a valid response followed by a truncated pkt-line", () => {
		const response = Buffer.concat([
			data("acknowledgments\n"),
			data("NAK\n"),
			encodePkt({ type: "flush" }),
			Buffer.from("0008abc", "ascii"),
		])

		expect(() => ackSection(response)).toThrow("7 undecoded bytes")
	})
})
