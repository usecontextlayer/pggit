import type { TestProject } from "vitest/node"
import { startPostgres } from "@/testing/pg"

/**
 * vitest `globalSetup` for the §8.4 generative spec-suite (spec §7.3): spin up
 * ONE Postgres container for the whole run and expose its connection URI as
 * `pgBaseUrl`. Each generative candidate then carves a fresh isolated schema out
 * of this single container (via `createIsolatedSchema`) and drops it afterward —
 * so the candidate count is decoupled from container-startup cost. Registered
 * only in `vitest.spec.config.ts`, so the default unit gate never pays for it.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	const container = await startPostgres()
	project.provide("pgBaseUrl", container.getConnectionUri())
	return async () => {
		await container.stop()
	}
}

declare module "vitest" {
	interface ProvidedContext {
		pgBaseUrl: string
	}
}
