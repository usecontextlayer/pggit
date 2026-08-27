import { z } from "zod"

// Zod-validated process.env, parsed once at module load. Boundary layer:
// validate here, trust the typed `env` everywhere inside.
const EnvSchema = z.object({
	// porsager `postgres` is initialized DSN-only; lazily, per the server design.
	PGGIT_DATABASE_URL: z.string().min(1).optional(),
	// The four GC tunables below are OPTIONAL pass-through overrides: unset means
	// the scheduler options schema's own default (gc-scheduler.ts — the ONE
	// default site), so the values are deliberately not restated here.
	// Max repos drained at once per pass; also bounds concurrent repack memory.
	PGGIT_GC_CONCURRENCY: z.coerce.number().int().positive().optional(),

	// Self-scheduling GC (docs/2026-06-24-gc-scheduler-design.md §5; the repack
	// phase: docs/2026-08-25-drain-repack-wiring.md). The standalone server runs
	// the background drain by default; a mounted host opts in by constructing the
	// exported `createGcDrain`. ENABLED is host policy, not a scheduler tunable —
	// it gates whether the drain is constructed at all, so it keeps its default
	// here. Disabling only stops the loop — pushes still stamp `last_pushed_at`
	// (cheap, harmless), so enabling later just works. An unrecognized value
	// fails loud (no silent fallback): only the listed tokens are accepted.
	PGGIT_GC_ENABLED: z
		.enum(["true", "false", "1", "0"])
		.default("true")
		.transform((v) => v === "true" || v === "1"),
	// Passed straight to gc(): the storage-overhang dial (minutes, not git's days).
	PGGIT_GC_GRACE_SECONDS: z.coerce.number().nonnegative().optional(),
	// Drain cadence — the debounce window a burst of turns coalesces into.
	PGGIT_GC_INTERVAL_MS: z.coerce.number().int().positive().optional(),
	PGGIT_GC_REPACK_ENABLED: z
		.enum(["true", "false", "1", "0"])
		.transform((v) => v === "true" || v === "1")
		.optional(),
	PGGIT_PORT: z.coerce.number().int().positive().default(8080),
})

export const env = EnvSchema.parse(process.env)
