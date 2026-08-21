import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig } from "vitest/config"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

// Test taxonomy (inlined from the monorepo's vitest.shared.ts):
//   *.test.ts                      → unit             → `test`
//   *.node.integration.test.ts     → hermetic node    → (add a script when needed)
// Unit runs exclude every integration variant (shared `.integration.test.` infix).
const unitTestExclude = [...configDefaults.exclude, "**/*.integration.test.ts"]

// Suites that must run with the machine to themselves, as the LAST phase. The bar is
// a timing-sensitive VERDICT, never file length:
//   - the gc-scheduler family drives interval/grace timing that CPU contention
//     flakes;
//   - the watcher-aimed fault suites target sub-second statement windows
//     (`pg_cancel_backend` at a specific sweep batch, a ~200 ms COPY) that a
//     loaded box makes unhittable — measured: green solo, red under three
//     parallel workers.
// The adversarial shape sweep is NOT here. It was, on the claim that its per-shape
// timings fed its own verdicts — and that claim was false: its only `Date.now()`
// feeds a `console.log`, while every verdict is an object-set equality, an
// `fsck --strict`, or a served-delta floor. It runs in the parallel pool instead,
// as the four `shapes--negative-sweep-*.test.ts` files.
const soloTests = [
	"**/gc-scheduler*.test.ts",
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
		// Hooks build the heavy half (schemas, containers, seeded fixtures), so they
		// get the same ceiling as tests — the 10 s default flakes under load.
		hookTimeout: 600_000,
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
					// concurrent files was the safe envelope while the race family swept
					// frozen millisecond delays; the calibrated fraction sweeps are what
					// made a denser pool safe. 6 is the measured ruling-7 A/B result
					// (2026-08-21): 169 files / 654 tests green in 854 s wall on a box
					// simultaneously carrying other sessions' load, zero flakes. Re-run
					// that A/B before raising it further.
					maxWorkers: 6,
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
