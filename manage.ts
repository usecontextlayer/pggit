import { execSync } from "node:child_process"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { Command } from "commander"
import type { Kysely } from "kysely"
import postgres from "postgres"
import { createMigrator, migrateToLatest } from "./src/database/migrate"
import { initKysely } from "./src/postgres"

// Schema/codegen ops CLI, mirroring web/manage.ts. One difference: `codegen`
// here is testcontainer-driven (boots a throwaway Postgres, migrates it, points
// Kanel at it) so local type generation needs no standing database. The migrate
// actions (latest/up/down/downup/reset/drop) operate on a real DB via
// DATABASE_URL from the environment. Run: `pnpm run db.manage <action>`.

const MODELS_FOLDER = "./src/database/models"
const CODEGEN_IMAGE = "postgres:18-alpine"

// biome-ignore lint/suspicious/noExplicitAny: actions run schema-agnostic DDL
type DbAction = (db: Kysely<any>) => Promise<void>

async function latest(db: Parameters<DbAction>[0]): Promise<void> {
	await migrateToLatest(db)
}

async function up(db: Parameters<DbAction>[0]): Promise<void> {
	const { error, results } = await createMigrator(db).migrateUp()
	console.log(results)
	if (error) throw error
}

async function down(db: Parameters<DbAction>[0]): Promise<void> {
	const { error, results } = await createMigrator(db).migrateDown()
	console.log(results)
	if (error) throw error
}

async function downup(db: Parameters<DbAction>[0]): Promise<void> {
	await down(db)
	await up(db)
}

async function drop(db: Parameters<DbAction>[0]): Promise<void> {
	await db.schema.dropSchema("public").ifExists().cascade().execute()
	await db.schema.createSchema("public").execute()
}

async function reset(db: Parameters<DbAction>[0]): Promise<void> {
	await drop(db)
	await latest(db)
}

const DB_ACTIONS: Record<string, DbAction> = { down, downup, drop, latest, reset, up }

/** Build a Kysely over the real DATABASE_URL, run one action, tear it down. */
async function runDbAction(name: string): Promise<void> {
	const url = process.env.DATABASE_URL
	if (!url) throw new Error(`manage: DATABASE_URL is required for "${name}"`)
	const run = DB_ACTIONS[name]
	if (!run) throw new Error(`manage: unknown action "${name}"`)
	const db = initKysely(postgres(url))
	try {
		await run(db)
	} finally {
		await db.destroy()
	}
}

/** Boot a throwaway Postgres, migrate it, run Kanel against it, tear it down. */
async function codegen(): Promise<void> {
	const container = await new PostgreSqlContainer(CODEGEN_IMAGE).start()
	try {
		const url = container.getConnectionUri()
		const db = initKysely(postgres(url))
		await migrateToLatest(db)
		await db.destroy()
		// Kanel reads DATABASE_URL from env (see kanel.config.cjs).
		execSync("./node_modules/.bin/kanel -c ./kanel.config.cjs", {
			env: { ...process.env, DATABASE_URL: url },
			stdio: "inherit",
		})
	} finally {
		await container.stop()
	}
}

function biome(): void {
	execSync(`./node_modules/.bin/biome check --write ${MODELS_FOLDER}`, {
		stdio: "inherit",
	})
}

async function run(): Promise<void> {
	const program = new Command()
		.argument("<action>")
		.option("--sub <string>")
		.option("--no-auto-codegen")
		.option("--no-auto-biome")
		.option("--ci")
		.parse()

	const action = program.args[0]
	const { autoCodegen, autoBiome, ci } = program.opts()

	// A migrate action regenerates + reformats models afterward (unless --ci).
	const queue = [action]
	if (!ci) {
		if (autoCodegen) queue.push("codegen")
		if (autoBiome) queue.push("biome")
	}
	const ordered = [...new Set(queue.reverse())].reverse()

	for (const a of ordered) {
		if (a === "codegen") await codegen()
		else if (a === "biome") biome()
		else await runDbAction(a)
	}
	process.exit(0)
}

run()
