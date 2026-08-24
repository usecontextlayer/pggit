/**
 * UTILITY, not a test — it asserts nothing and measures nothing.
 *
 * Teardown for the real-repo differential run: drop ONLY the isolated schemas this
 * exercise created. Attribution is by repo NAME, not by schema name or timestamp —
 * every schema here is `t_<uuid>` and the Postgres instance is shared with other
 * sessions, so the only safe key is a `repos.name` prefix no other session uses
 * (`realrepo/`, `races/`, `border/`, `warm/`, `sizecheck/` — the repo-id prefixes the
 * five harnesses in this directory push under).
 *
 * A harness that finishes normally drops its own schema in its `finally`; this exists
 * for the runs that did not — a killed process, a harness that threw past its
 * teardown, a `--phases` run abandoned mid-way.
 *
 *   npx tsx perf/probes/realrepo/cleanup.ts               # report only
 *   npx tsx perf/probes/realrepo/cleanup.ts --drop=true   # drop the attributed schemas
 */

import { parseArgs, pgUrlArg } from "@perf/args"
import postgres from "postgres"
import { z } from "zod"

const args = parseArgs(
	z
		.object({
			drop: z.stringbool().default(false),
			pg: pgUrlArg,
		})
		.strict(),
)
const HARNESS_REPO_PREFIXES = ["realrepo/", "races/", "border/", "warm/", "sizecheck/"]

async function main(): Promise<void> {
	const sql = postgres(args.pg, { max: 1, onnotice: () => {} })
	try {
		const schemas = await sql<{ nspname: string }[]>`
			select nspname from pg_namespace where nspname like 't\\_%' order by nspname`
		const attributed: { schema: string; repos: string[] }[] = []
		let unattributed = 0
		for (const { nspname } of schemas) {
			const [has] = await sql<{ n: number }[]>`
				select count(*)::int as n from pg_class c
				join pg_namespace n on n.oid = c.relnamespace
				where n.nspname = ${nspname} and c.relname = 'repos'`
			if (!has || has.n === 0) {
				unattributed++
				continue
			}
			const rows = await sql<{ name: string }[]>`select name from ${sql(nspname)}.repos`
			const names = rows.map((r) => r.name)
			if (
				names.length > 0 &&
				names.every((name) =>
					HARNESS_REPO_PREFIXES.some((prefix) => name.startsWith(prefix)),
				)
			) {
				attributed.push({ repos: names, schema: nspname })
			} else {
				unattributed++
			}
		}
		console.log(
			`${schemas.length} t_* schemas; ${attributed.length} attributable to this exercise, ${unattributed} unattributed (left alone)`,
		)
		for (const entry of attributed) {
			console.log(`  ${entry.schema}  repos: ${entry.repos.join(", ")}`)
		}
		if (args.drop) {
			for (const entry of attributed) {
				await sql`drop schema ${sql(entry.schema)} cascade`
				console.log(`  dropped ${entry.schema}`)
			}
		} else if (attributed.length > 0) {
			console.log(`\nre-run with --drop=true to remove them`)
		}
	} finally {
		await sql.end()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
