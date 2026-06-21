import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { runScenario } from "./harness"
import { printSummary, writeReport } from "./report"
import { SCENARIOS } from "./scenarios"

/** Read `--key=value` from argv. */
function arg(name: string): string | undefined {
	const prefix = `--${name}=`
	const found = process.argv.find((a) => a.startsWith(prefix))
	return found?.slice(prefix.length)
}

async function main(): Promise<void> {
	const name = arg("scenario") ?? "markdown"
	const base = SCENARIOS[name]
	if (!base) {
		throw new Error(
			`unknown scenario ${JSON.stringify(name)}; known: ${Object.keys(SCENARIOS).join(", ")}`,
		)
	}
	const scenario = {
		...base,
		blobCount: Number(arg("blobs") ?? base.blobCount),
		churn: Number(arg("churn") ?? base.churn),
		historyLen: Number(arg("history") ?? base.historyLen),
	}
	const seed = Number(arg("seed") ?? 1)
	const repeat = Number(arg("repeat") ?? 1)
	const rttArg = arg("rtt")
	const rttMs = rttArg !== undefined ? Number(rttArg) : null
	const stamp = new Date().toISOString().replace(/[:.]/g, "-")
	const outDir = join("perf", "runs", `${name}-${stamp}`)
	mkdirSync(outDir, { recursive: true })

	console.log(
		`[perf] scenario=${name} blobs=${scenario.blobCount} history=${scenario.historyLen} churn=${scenario.churn} repeat=${repeat} rtt=${rttMs ?? "off"}`,
	)
	console.log(`[perf] out=${outDir}`)
	const report = await runScenario({ outDir, repeat, rttMs, scenario, seed })
	await writeReport(report)
	printSummary(report)
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err)
		process.exit(1)
	},
)
