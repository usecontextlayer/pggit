/**
 * Refname policy at the receive boundary (adversarial-review fix, 2026-08-19):
 * git clients VALIDATE refnames before sending, so only a hostile or non-git
 * client ever ships a funny name — which is exactly why the server must not
 * trust the wire. A funny name that reached storage would poison every later
 * advertisement and status line a real git client parses. Rules mirror git's
 * `check_refname_format` as receive-pack applies it, plus the loose-ref
 * directory/file conflict (`refs/heads/a` vs `refs/heads/a/b`) checked in
 * git's sequential lock order.
 */
import { describe, expect, it } from "vitest"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import {
	handleReceivePack,
	type ReceiveBackend,
	refNameProblem,
} from "@/protocol/receive-pack"
import { pktLineUnpack } from "@/testing/pkt-oracle"

const A = "a".repeat(40)
const Z = "0".repeat(40)

describe("refNameProblem — git's check_refname_format for full ref names", () => {
	it("accepts well-formed full refs", () => {
		for (const ok of [
			"refs/heads/main",
			"refs/heads/feat/one-two.three",
			"refs/tags/v1.2.3",
			"refs/heads/@at",
			"refs/remotes/origin/HEAD",
		]) {
			expect(refNameProblem(ok), ok).toBeNull()
		}
	})

	it("rejects every check-ref-format violation", () => {
		for (const bad of [
			"main", // not under refs/
			"refs/heads/", // trailing slash
			"refs/heads/a.", // trailing dot
			"refs/heads/a..b", // double dot
			"refs/heads//x", // empty component
			"refs/heads/.hidden", // component starts with dot
			"refs/heads/x.lock", // component ends with .lock
			"refs/heads/a b", // space
			"refs/heads/a~b", // tilde
			"refs/heads/a^b", // caret
			"refs/heads/a:b", // colon
			"refs/heads/a?b", // question mark
			"refs/heads/a*b", // asterisk
			"refs/heads/a[b", // bracket
			"refs/heads/a\\b", // backslash
			"refs/heads/a\nb", // control byte
			"refs/heads/a\u007fb", // DEL
			"refs/heads/a@{b", // reflog syntax
		]) {
			expect(refNameProblem(bad), JSON.stringify(bad)).not.toBeNull()
		}
	})
})

/** A recording backend: the policy must reject BEFORE any mutation. */
function recordingReceive(existing: string[] = []) {
	const applied: string[][] = []
	const backend: ReceiveBackend = {
		applyRefUpdates: async (cmds) => {
			applied.push(cmds.map((c) => c.ref))
			return cmds.map(() => true)
		},
		ingest: async () => {},
		isAncestor: async () => true,
		isConnected: async () => true,
		listRefNames: async () => existing,
		objectType: async () => "commit",
	}
	return { applied, backend }
}

function push(...lines: string[]): Buffer {
	return Buffer.concat([
		...lines.map((l, i) =>
			encodePktLine(Buffer.from(i === 0 ? `${l}\0report-status` : l)),
		),
		encodePkt({ type: "flush" }),
	])
}

describe("handleReceivePack — funny names get per-ref ng, never a ref", () => {
	it("rejects a malformed name and applies nothing for it", async () => {
		const { applied, backend } = recordingReceive()
		const report = pktLineUnpack(
			await handleReceivePack(push(`${Z} ${A} refs/heads/a..b`), backend),
		)
		expect(report).toContain("ng refs/heads/a..b funny refname")
		expect(applied.flat()).toEqual([])
	})

	it("rejects a directory/file conflict against an EXISTING ref", async () => {
		const { applied, backend } = recordingReceive(["refs/heads/a"])
		const report = pktLineUnpack(
			await handleReceivePack(push(`${Z} ${A} refs/heads/a/b`), backend),
		)
		expect(report).toContain("ng refs/heads/a/b funny refname (directory/file conflict)")
		expect(applied.flat()).toEqual([])
	})

	it("within one batch, the EARLIER name wins the directory/file conflict", async () => {
		const { applied, backend } = recordingReceive()
		const report = pktLineUnpack(
			await handleReceivePack(
				push(`${Z} ${A} refs/heads/main`, `${Z} ${A} refs/heads/main/sub`),
				backend,
			),
		)
		expect(report).toContain("ok refs/heads/main")
		expect(report).toContain(
			"ng refs/heads/main/sub funny refname (directory/file conflict)",
		)
		expect(applied.flat()).toEqual(["refs/heads/main"])
	})
})
