import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { integerFlag, optionalFlag } from "./args"
import { runScenario } from "./harness"
import { printSummary, writeReport } from "./report"
import { SCENARIOS } from "./scenarios"

/** Read `--key=value` from argv. */
async function main(): Promise<void> {
	const name = optionalFlag("scenario") ?? "markdown"
	const base = SCENARIOS[name]
	if (!base) {
		throw new Error(
			`unknown scenario ${JSON.stringify(name)}; known: ${Object.keys(SCENARIOS).join(", ")}`,
		)
	}
	const scenario = {
		...base,
		blobCount: integerFlag("blobs", base.blobCount, { min: 1 }),
		churn: integerFlag("churn", base.churn, { min: 0 }),
		historyLen: integerFlag("history", base.historyLen, { min: 1 }),
	}
	if (scenario.churn > scenario.blobCount) {
		throw new Error(
			`--churn (${scenario.churn}) cannot exceed --blobs (${scenario.blobCount})`,
		)
	}
	const seed = integerFlag("seed", 1, { min: 0 })
	const repeat = integerFlag("repeat", 1, { min: 1 })
	const rttArg = optionalFlag("rtt")
	const rttMs = rttArg === undefined ? null : integerFlag("rtt", 1, { min: 1 })
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
