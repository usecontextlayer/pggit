/**
 * UTILITY, not a test — it asserts nothing and measures nothing.
 *
 * Teardown for the real-repo differential run: drop ONLY the isolated schemas this
 * exercise created. Attribution is by repo NAME, not by schema name or timestamp —
 * every schema here is `t_<uuid>` and the Postgres instance is shared with other
 * sessions, so the only safe key is a `repos.name` prefix no other session uses
 * (`realrepo/`, `races/`, `border/`, `warm/`, `sizecheck/` — the repo-id prefixes the
 * five `realrepo--*` harnesses in this directory push under).
 *
 * A harness that finishes normally drops its own schema in its `finally`; this exists
 * for the runs that did not — a killed process, a harness that threw past its
 * teardown, a `--phases` run abandoned mid-way.
 *
 *   npx tsx perf/breakage/realrepo--cleanup.ts          # report only
 *   npx tsx perf/breakage/realrepo--cleanup.ts --drop   # drop the attributed schemas
 */
import postgres from "postgres"
import { DEFAULT_PG_URL, flag } from "./_realrepo-util"

const PG_URL = flag("pg", DEFAULT_PG_URL)
const DROP = process.argv.includes("--drop")
const MINE = ["realrepo/", "races/", "border/", "warm/", "sizecheck/"]

async function main(): Promise<void> {
	const sql = postgres(PG_URL, { max: 1, onnotice: () => {} })
	try {
		const schemas = await sql<{ nspname: string }[]>`
			select nspname from pg_namespace where nspname like 't\\_%' order by nspname`
		const mine: { schema: string; repos: string[] }[] = []
		let foreign = 0
		for (const { nspname } of schemas) {
			const [has] = await sql<{ n: number }[]>`
				select count(*)::int as n from pg_class c
				join pg_namespace n on n.oid = c.relnamespace
				where n.nspname = ${nspname} and c.relname = 'repos'`
			if (!has || has.n === 0) {
				foreign++
				continue
			}
			const rows = await sql<
				{ name: string }[]
			>`select name from ${sql(nspname)}.repos limit 200`
			const names = rows.map((r) => r.name)
			if (names.length > 0 && names.every((n) => MINE.some((p) => n.startsWith(p)))) {
				mine.push({ repos: names.slice(0, 3), schema: nspname })
			} else {
				foreign++
			}
		}
		console.log(
			`${schemas.length} t_* schemas; ${mine.length} attributable to this exercise, ${foreign} NOT mine (left alone)`,
		)
		for (const m of mine) console.log(`  ${m.schema}  repos: ${m.repos.join(", ")}`)
		if (DROP) {
			for (const m of mine) {
				await sql`drop schema ${sql(m.schema)} cascade`
				console.log(`  dropped ${m.schema}`)
			}
		} else if (mine.length > 0) {
			console.log(`\nre-run with --drop to remove them`)
		}
	} finally {
		await sql.end()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
