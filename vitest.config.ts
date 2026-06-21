import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig } from "vitest/config"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

// Test taxonomy (inlined from the monorepo's vitest.shared.ts):
//   *.test.ts                      → unit             → `test`
//   *.node.integration.test.ts     → hermetic node    → (add a script when needed)
// Unit runs exclude every integration variant (shared `.integration.test.` infix).
const unitTestInclude = ["**/*.test.ts"]
// `*.spec.test.ts` = the executable-spec suite (spec §3): the oracle wire goldens
// (§8.1) and the generative kernel differentials (§8.4). Authored test-first, they
// are now folded into the one gate (Phase 3 complete) — they match `**/*.test.ts`,
// so no special include is needed; their fast-check seeds are pinned for a
// deterministic gate. The shared `globalSetup` below gives them one Postgres
// container for the whole run (each candidate carves an isolated schema from it).
const unitTestExclude = [...configDefaults.exclude, "**/*.integration.test.ts"]

export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		exclude: unitTestExclude,
		// One shared Postgres container for the generative differentials (spec §7.3);
		// exposed as `pgBaseUrl`, ignored by tests that start their own container.
		globalSetup: ["./src/testing/pg-global-setup.ts"],
		include: unitTestInclude,
		name: "@usecontextlayer/pggit",
		root: projectRoot,
		// The oracle rig spins up real `git` + a real Postgres and round-trips
		// packfiles; a generative property runs many such candidates per `it`, so
		// give each ample headroom (matches the old spec-suite ceiling).
		testTimeout: 600_000,
	},
})
