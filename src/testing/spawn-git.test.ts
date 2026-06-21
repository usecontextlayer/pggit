import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { spawnGit } from "@/testing/spawn-git"

describe("spawnGit", () => {
	it("runs git and captures stdout + exit code", async () => {
		const res = await spawnGit(["--version"])
		expect(res.code).toBe(0)
		expect(res.stdout).toContain("git version")
	})

	it("throws on non-zero exit, surfacing stderr", async () => {
		await expect(spawnGit(["totally-not-a-git-command"])).rejects.toThrow(
			/totally-not-a-git-command/,
		)
	})

	it("produces a byte-identical commit OID across isolated runs (pinned clock + identity)", async () => {
		const commitOnce = async () => {
			const dir = mkdtempSync(join(tmpdir(), "pggit-spawn-"))
			try {
				await spawnGit(["init", "-q"], { cwd: dir })
				writeFileSync(join(dir, "a.txt"), "hello\n")
				await spawnGit(["add", "a.txt"], { cwd: dir })
				await spawnGit(["commit", "-q", "-m", "seed"], { cwd: dir })
				const { stdout } = await spawnGit(["rev-parse", "HEAD"], { cwd: dir })
				return stdout.trim()
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		}

		const [oid1, oid2] = await Promise.all([commitOnce(), commitOnce()])
		expect(oid1).toBe(oid2)
		// Pinned literal — independently reproduced by a manual git invocation with
		// the same env. Locks the whole isolation block (identity, clock, config
		// scrub) under test: any drift changes this OID and fails loudly.
		expect(oid1).toBe("f9e04c8901355c29cbc098d23b165655c9aa107a")
	})
})
