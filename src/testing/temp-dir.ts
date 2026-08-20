import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function withTempDir<T>(
	prefix: string,
	fn: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	try {
		return await fn(dir)
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}
