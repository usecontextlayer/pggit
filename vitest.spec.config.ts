import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig } from "vitest/config"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

// The Phase-1/2 SPEC-SUITE config (spec §3, §5, §7). The `*.spec.test.ts` files
// are the executable specification of desired behavior, authored BEFORE the
// implementation is made to satisfy them — so they are EXPECTED to be red until
// Phase 3. The default gate (vitest.config.ts) excludes them; this config runs
// ONLY them, via `pnpm run test.spec`, so we can watch them fail and track the
// red set. Phase 3 folds them into the default gate and deletes this split.
//
// Phase 2 will add a `globalSetup` here (one shared Postgres container for the
// generative differential) — the default gate stays free of it.
export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		exclude: [...configDefaults.exclude],
		include: ["**/*.spec.test.ts"],
		name: "@usecontextlayer/pggit:spec",
		root: projectRoot,
		testTimeout: 60_000,
	},
})
