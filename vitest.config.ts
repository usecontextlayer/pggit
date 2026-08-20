import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig } from "vitest/config"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

// Test taxonomy (inlined from the monorepo's vitest.shared.ts):
//   *.test.ts                      → unit             → `test`
//   *.node.integration.test.ts     → hermetic node    → (add a script when needed)
// Unit runs exclude every integration variant (shared `.integration.test.` infix).
const unitTestExclude = [...configDefaults.exclude, "**/*.integration.test.ts"]

// Suites that must run with the machine to themselves, as the LAST phase:
//   - the gc-scheduler family drives interval/grace timing that CPU contention
//     flakes;
//   - the watcher-aimed fault suites target sub-second statement windows
//     (`pg_cancel_backend` at a specific sweep batch, a ~200 ms COPY) that a
//     loaded box makes unhittable — measured: green solo, red under three
//     parallel workers;
//   - the negative sweep is the longest single file and its per-shape timings
//     feed its own verdicts.
const soloTests = [
	"**/gc-scheduler*.test.ts",
	"**/shapes--negative-sweep.test.ts",
	"**/pg-txn--gc-repack-fault-sweep.test.ts",
	"**/pg-txn--copy-cancel-hangs-push-forever.test.ts",
]

export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		// Shared by both projects (`extends: true`): one Postgres container per
		// project phase via globalSetup, exposed as `pgBaseUrl` — every test
		// carves an isolated `t_<uuid>` schema out of it, so a bounded number of
		// concurrent files share one server safely. Tests that deliberately start
		// their own container ignore it.
		globalSetup: ["./src/testing/pg-global-setup.ts"],
		projects: [
			{
				extends: true,
				test: {
					exclude: [...unitTestExclude, ...soloTests],
					include: ["**/*.test.ts"],
					// THE concurrency cap is load-bearing: with the default worker
					// count (~one per core) the container-backed suites produce false
					// 600 s timeouts and wedged workers — observed repeatedly on this
					// suite (a 13 s file timing out purely from parallel load). Three
					// concurrent files is the measured-safe envelope; raise it only
					// with a full-suite A/B against solo timings.
					maxWorkers: 3,
					name: "pggit",
					sequence: { groupOrder: 0 },
				},
			},
			{
				extends: true,
				test: {
					exclude: unitTestExclude,
					fileParallelism: false,
					include: soloTests,
					name: "pggit:solo",
					sequence: { groupOrder: 1 },
				},
			},
		],
		root: projectRoot,
		// The oracle rig spins up real `git` + a real Postgres and round-trips
		// packfiles; a generative property runs many such candidates per `it`, so
		// give each ample headroom (matches the old spec-suite ceiling).
		testTimeout: 600_000,
	},
})
