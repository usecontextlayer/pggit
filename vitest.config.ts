import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig } from "vitest/config"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

// Test taxonomy (inlined from the monorepo's vitest.shared.ts):
//   *.test.ts                      → unit             → `test`
//   *.node.integration.test.ts     → hermetic node    → (add a script when needed)
// Unit runs exclude every integration variant (shared `.integration.test.` infix).
const unitTestInclude = ["**/*.test.ts"]
const unitTestExclude = [...configDefaults.exclude, "**/*.integration.test.ts"]

export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		exclude: unitTestExclude,
		include: unitTestInclude,
		name: "@usecontextlayer/pggit",
		root: projectRoot,
		// The oracle rig spins up real `git` + a real Postgres and round-trips
		// packfiles; under parallel load a single round-trip easily exceeds the 5s
		// default, so give each integration test ample headroom.
		testTimeout: 60_000,
	},
})
