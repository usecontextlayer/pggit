import { z } from "zod"

// Zod-validated process.env, parsed once at module load. Boundary layer:
// validate here, trust the typed `env` everywhere inside.
const EnvSchema = z.object({
	// porsager `postgres` is initialized DSN-only; lazily, per the server design.
	PGGIT_DATABASE_URL: z.string().min(1).optional(),
	// Max repos drained at once per pass; also bounds concurrent repack memory.
	PGGIT_GC_CONCURRENCY: z.coerce.number().int().positive().default(4),

	// Self-scheduling GC (docs/2026-06-24-gc-scheduler-design.md §5). The standalone
	// server runs the background drain by default; a mounted host opts in. Disabling
	// only stops the loop — pushes still stamp `last_pushed_at` (cheap, harmless), so
	// enabling later just works. An unrecognized ENABLED value fails loud (no silent
	// fallback): only the listed tokens are accepted.
	PGGIT_GC_ENABLED: z
		.enum(["true", "false", "1", "0"])
		.default("true")
		.transform((v) => v === "true" || v === "1"),
	// Passed straight to gc(): the storage-overhang dial (minutes, not git's days).
	PGGIT_GC_GRACE_SECONDS: z.coerce.number().nonnegative().default(60),
	// Drain cadence — the debounce window a burst of turns coalesces into.
	PGGIT_GC_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
	// The drain's repack phase (docs/2026-08-25-drain-repack-wiring.md): nested
	// under the GC switch — when the drain is off, repack is off with it. Disabling
	// only skips the phase; pushes still stamp activity and a host can invoke
	// `repack()` directly, so enabling later just works. Same loud-failure tokens
	// as PGGIT_GC_ENABLED.
	PGGIT_GC_REPACK_ENABLED: z
		.enum(["true", "false", "1", "0"])
		.default("true")
		.transform((v) => v === "true" || v === "1"),
	PGGIT_PORT: z.coerce.number().int().positive().default(8080),
})

export const env = EnvSchema.parse(process.env)
