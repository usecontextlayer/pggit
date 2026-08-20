/**
 * Refname policy at the receive boundary (adversarial-review fix, 2026-08-19):
 * git clients VALIDATE refnames before sending, so only a hostile or non-git
 * client ever ships a funny name — which is exactly why the server must not
 * trust the wire. A funny name that reached storage would poison every later
 * advertisement and status line a real git client parses. Rules mirror git's
 * `check_refname_format` as receive-pack applies it, plus the loose-ref
 * directory/file conflict (`refs/heads/a` vs `refs/heads/a/b`) checked in
 * git's sequential lock order.
 *
 * The two vector lists below are NAMED REGRESSIONS — each string is a rule someone
 * had to discover. The general agreement with canonical git is pinned generatively
 * against a spawned `git check-ref-format` in `src/generative/refname.spec.test.ts`;
 * a new rule learned the hard way still belongs here, by name.
 */
import { describe, expect, it } from "vitest"
import {
	handleReceivePack,
	type ReceiveBackend,
	refNameProblem,
} from "@/protocol/receive-pack"
import { pktLineUnpack } from "@/testing/pkt-oracle"
import { receivePackRequest } from "@/testing/wire-receive"

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
	const [first, ...rest] = lines
	if (first === undefined) throw new Error("push requires at least one command")
	return receivePackRequest([`${first}\0report-status`, ...rest])
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

	it("within one batch, the DEEPEST name wins the directory/file conflict", async () => {
		// Canonical git keeps the deepest conflicting new name and ngs every
		// shorter one, in any wire order (measured on git 2.55; the receive-pack
		// policy differential pins the agreement end-to-end).
		const { applied, backend } = recordingReceive()
		const report = pktLineUnpack(
			await handleReceivePack(
				push(`${Z} ${A} refs/heads/main`, `${Z} ${A} refs/heads/main/sub`),
				backend,
			),
		)
		expect(report).toContain("ng refs/heads/main funny refname (directory/file conflict)")
		expect(report).toContain("ok refs/heads/main/sub")
		expect(applied.flat()).toEqual(["refs/heads/main/sub"])
	})
})
