import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { attemptGit, spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

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

	it("returns named success and ordinary nonzero outcomes when failure is data", async () => {
		expect(await attemptGit(["--version"])).toEqual(
			expect.objectContaining({ code: 0, ok: true }),
		)
		const failed = await attemptGit(["totally-not-a-git-command"])
		expect(failed.ok).toBe(false)
		if (failed.ok) throw new Error("attemptGit unexpectedly succeeded")
		expect(failed.code).toBeGreaterThan(0)
		expect(failed.stderr).toContain("totally-not-a-git-command")
	})

	it("rejects when the git child is killed by a signal", async () => {
		// The alias shell signals its parent git process. Node reports that outcome as
		// `code === null`, which must never be laundered into the old exit-0 default.
		await expect(
			spawnGit(["-c", "alias.self-destruct=!kill -TERM $PPID", "self-destruct"]),
		).rejects.toThrow(/killed by SIGTERM/)
	})

	it("produces a byte-identical commit OID across isolated runs (pinned clock + identity)", async () => {
		const commitOnce = async () =>
			withTempDir("pggit-spawn-", async (dir) => {
				await spawnGit(["init", "-q"], { cwd: dir })
				writeFileSync(join(dir, "a.txt"), "hello\n")
				await spawnGit(["add", "a.txt"], { cwd: dir })
				await spawnGit(["commit", "-q", "-m", "seed"], { cwd: dir })
				const { stdout } = await spawnGit(["rev-parse", "HEAD"], { cwd: dir })
				return stdout.trim()
			})

		const [oid1, oid2] = await Promise.all([commitOnce(), commitOnce()])
		expect(oid1).toBe(oid2)
		// Pinned literal — independently reproduced by a manual git invocation with
		// the same env. Locks the whole isolation block (identity, clock, config
		// scrub) under test: any drift changes this OID and fails loudly.
		expect(oid1).toBe("f9e04c8901355c29cbc098d23b165655c9aa107a")
	})

	it("captures raw stdout bytes faithfully (binary-safe)", async () => {
		await withTempDir("pggit-spawn-bin-", async (dir) => {
			const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x0a, 0x7f])
			const file = join(dir, "bin")
			writeFileSync(file, binary)
			await spawnGit(["init", "-q"], { cwd: dir })
			const { stdout: oid } = await spawnGit(["hash-object", "-w", "-t", "blob", file], {
				cwd: dir,
			})
			const res = await spawnGit(["cat-file", "blob", oid.trim()], { cwd: dir })
			expect(res.stdoutBytes).toEqual(binary)
		})
	})
})
