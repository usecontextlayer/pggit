import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

/** Total logical file bytes beneath a directory. */
export async function directoryBytes(dir: string): Promise<number> {
	let total = 0
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) total += await directoryBytes(path)
		else if (entry.isFile()) total += (await stat(path)).size
	}
	return total
}
