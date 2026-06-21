import { z } from "zod"

// Zod-validated process.env, parsed once at module load. Boundary layer:
// validate here, trust the typed `env` everywhere inside.
const EnvSchema = z.object({
	// porsager `postgres` is initialized DSN-only; lazily, per the server design.
	PGGIT_DATABASE_URL: z.string().min(1).optional(),
	PGGIT_PORT: z.coerce.number().int().positive().default(8080),
})

export const env = EnvSchema.parse(process.env)
