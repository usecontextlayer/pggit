import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { integerArg, nonemptyStringArg, parseArgs } from "./args"
import { runScenario } from "./harness"
import type { RttMode } from "./pg-latency"
import { printSummary, writeReport } from "./report"
import { SCENARIOS } from "./scenarios"

const argsSchema = z
	.object({
		blobs: integerArg.min(1).optional(),
		churn: integerArg.min(0).optional(),
		history: integerArg.min(1).optional(),
		repeat: integerArg.min(1).default(1),
		rtt: integerArg.min(1).optional(),
		scenario: nonemptyStringArg.default("markdown"),
		seed: integerArg.min(0).default(1),
	})
	.strict()

async function main(): Promise<void> {
	const args = parseArgs(argsSchema)
	const name = args.scenario
	const base = SCENARIOS[name]
	if (!base) {
		throw new Error(
			`unknown scenario ${JSON.stringify(name)}; known: ${Object.keys(SCENARIOS).join(", ")}`,
		)
	}
	const scenario = {
		...base,
		blobCount: args.blobs ?? base.blobCount,
		churn: args.churn ?? base.churn,
		historyLen: args.history ?? base.historyLen,
	}
	if (scenario.churn > scenario.blobCount) {
		throw new Error(
			`--churn (${scenario.churn}) cannot exceed --blobs (${scenario.blobCount})`,
		)
	}
	const rtt: RttMode =
		args.rtt === undefined
			? { kind: "loopback" }
			: { kind: "sweep", requestedMs: args.rtt }
	const stamp = new Date().toISOString().replace(/[:.]/g, "-")
	const outDir = join("perf", "runs", `${name}-${stamp}`)
	mkdirSync(outDir, { recursive: true })

	console.log(
		`[perf] scenario=${name} blobs=${scenario.blobCount} history=${scenario.historyLen} churn=${scenario.churn} repeat=${args.repeat} rtt=${rtt.kind === "loopback" ? "off" : rtt.requestedMs}`,
	)
	console.log(`[perf] out=${outDir}`)
	const report = await runScenario({
		outDir,
		repeat: args.repeat,
		rtt,
		scenario,
		seed: args.seed,
	})
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
