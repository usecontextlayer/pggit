/**
 * §8.1 in-process pkt-line oracle — RECEIVE-PACK (push, protocol v0) wire goldens.
 *
 * SPEC-SUITE (`*.spec.test.ts`): the executable spec of the desired push wire
 * output, authored before the implementation was made to conform (spec §3), now on
 * the default gate (`pnpm run check`).
 *
 * The expected capability set/order is authored INDEPENDENTLY here (spec §4.6 —
 * "the test owns the canonical spec"); we deliberately do NOT import the handler's
 * `RECEIVE_CAPS` (it is module-private anyway), so the golden is a real check, not
 * "the handler agrees with itself." AGENT is the one imported input.
 */
import { describe, expect, it } from "vitest"
import { AGENT } from "@/protocol/capabilities"
import {
	type CommandResult,
	encodeReceivePackAdvertisement,
	encodeReportStatus,
} from "@/protocol/receive-pack"
import {
	framedLine,
	framedPktLines,
	renderRefAdvertV0,
	sidebandDemux,
	ZERO_OID,
} from "@/testing/pkt-oracle"

const A = "a".repeat(40)
const B = "b".repeat(40)

// The push caps we expect to be advertised, in canonical order (authored here,
// independent of the handler). AGENT is an external input → imported.
const EXPECTED_RECEIVE_CAPS = [
	"report-status",
	"delete-refs",
	"side-band-64k",
	"atomic",
	"object-format=sha1",
	`agent=${AGENT}`,
]

describe("§8.1 receive-pack wire — surface 6: v0 ref advertisement", () => {
	it("empty repo → synthetic `0{40} capabilities^{}` line carrying the caps, then flush", () => {
		expect(renderRefAdvertV0(encodeReceivePackAdvertisement([]))).toEqual({
			endsWithFlush: true,
			refs: [{ caps: EXPECTED_RECEIVE_CAPS, name: "capabilities^{}", oid: ZERO_OID }],
		})
	})

	it("single ref → caps carried after the NUL on that ref line", () => {
		const out = encodeReceivePackAdvertisement([{ name: "refs/heads/main", oid: A }])
		expect(renderRefAdvertV0(out)).toEqual({
			endsWithFlush: true,
			refs: [{ caps: EXPECTED_RECEIVE_CAPS, name: "refs/heads/main", oid: A }],
		})
	})

	it("multiple refs → caps on the FIRST ref only; later refs are plain (NUL on first line only)", () => {
		const out = encodeReceivePackAdvertisement([
			{ name: "refs/heads/main", oid: A },
			{ name: "refs/heads/dev", oid: B },
		])
		expect(renderRefAdvertV0(out)).toEqual({
			endsWithFlush: true,
			refs: [
				{ caps: EXPECTED_RECEIVE_CAPS, name: "refs/heads/main", oid: A },
				{ name: "refs/heads/dev", oid: B },
			],
		})
	})
})

describe("§8.1 receive-pack wire — surface 7: report-status", () => {
	it("all-ok → `unpack ok` then one `ok <ref>` per command, then flush (raw, length-prefixed)", () => {
		const results: CommandResult[] = [
			{ ok: true, ref: "refs/heads/main" },
			{ ok: true, ref: "refs/heads/dev" },
		]
		expect(framedPktLines(encodeReportStatus("ok", results, false))).toBe(
			framedLine("unpack ok") +
				framedLine("ok refs/heads/main") +
				framedLine("ok refs/heads/dev") +
				"0000",
		)
	})

	it("mixed → `ok` and `ng <ref> <reason>` per command, in order", () => {
		const results: CommandResult[] = [
			{ ok: true, ref: "refs/heads/main" },
			{ ok: false, reason: "stale ref (compare-and-swap failed)", ref: "refs/heads/dev" },
		]
		expect(framedPktLines(encodeReportStatus("ok", results, false))).toBe(
			framedLine("unpack ok") +
				framedLine("ok refs/heads/main") +
				framedLine("ng refs/heads/dev stale ref (compare-and-swap failed)") +
				"0000",
		)
	})

	it("a rejected command with no reason defaults to `failed`", () => {
		expect(
			framedPktLines(
				encodeReportStatus("ok", [{ ok: false, ref: "refs/heads/x" }], false),
			),
		).toBe(`${framedLine("unpack ok") + framedLine("ng refs/heads/x failed")}0000`)
	})

	it("unpack failure → `unpack <error>` then every command `ng`", () => {
		const results: CommandResult[] = [
			{ ok: false, reason: "unpacker error", ref: "refs/heads/main" },
		]
		expect(framedPktLines(encodeReportStatus("index-pack failed", results, false))).toBe(
			framedLine("unpack index-pack failed") +
				framedLine("ng refs/heads/main unpacker error") +
				"0000",
		)
	})

	it("delete-only push → `ok <ref>` for the deleted ref", () => {
		expect(
			framedPktLines(
				encodeReportStatus("ok", [{ ok: true, ref: "refs/heads/gone" }], false),
			),
		).toBe(`${framedLine("unpack ok") + framedLine("ok refs/heads/gone")}0000`)
	})

	it("sideband form → the whole report rides band 1; demux recovers the identical raw report", () => {
		const results: CommandResult[] = [{ ok: true, ref: "refs/heads/main" }]
		const wrapped = encodeReportStatus("ok", results, true)
		const raw = sidebandDemux(wrapped).band1
		expect(framedPktLines(raw)).toBe(
			`${framedLine("unpack ok") + framedLine("ok refs/heads/main")}0000`,
		)
		// The raw (non-sideband) form is byte-identical to what band 1 carried.
		expect(raw).toEqual(encodeReportStatus("ok", results, false))
	})
})
