import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function createScratchArena(): {
	cleanup: () => void
	make: (tag: string) => string
	own: (directory: string) => void
} {
	const directories: string[] = []

	return {
		cleanup() {
			for (const directory of directories) {
				rmSync(directory, { force: true, recursive: true })
			}
		},
		make(tag) {
			const directory = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
			directories.push(directory)
			return directory
		},
		own(directory) {
			directories.push(directory)
		},
	}
}
