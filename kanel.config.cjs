const { makePgTsGenerator, markAsGenerated } = require("kanel")
const { makeKyselyHook } = require("kanel-kysely")

// Kanel v4 config. `.cjs` (not `.js`) because the repo is `type: module` and
// kanel loads its `-c` config via CommonJS `require()`. Connection + output live
// here (v4 dropped the v3 -d/-o CLI flags). Kanel introspects a LIVE, migrated
// DB; `manage.ts codegen` provides one by booting a throwaway testcontainer,
// migrating it, and exporting its uri as DATABASE_URL before invoking kanel — so
// type generation needs no standing Postgres. Fail loud if that wiring is absent.
const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
	throw new Error(
		"kanel.config.cjs: DATABASE_URL is required — run via `pnpm run db.manage codegen`",
	)
}

/** @type {import('kanel').Config} */
module.exports = {
	connection: DATABASE_URL,
	generators: [
		makePgTsGenerator({
			customTypeMap: {
				// Pack bytes round-trip as Node Buffers through porsager.
				"pg_catalog.bytea": "Buffer",
				"pg_catalog.jsonb": "Record<string, unknown>",
			},
			// kanel-kysely's hook is a PgTs-scoped pre-render hook in v4, so it
			// belongs inside the generator, not in top-level preRenderHooks.
			preRenderHooks: [makeKyselyHook()],
		}),
	],
	outputPath: "./src/database/models",
	// Prepend the "// @generated" banner; manage.ts runs biome over the output
	// afterward to match repo style.
	postRenderHooks: [markAsGenerated],
	preDeleteOutputFolder: true,
	schemaNames: ["public"],
}
