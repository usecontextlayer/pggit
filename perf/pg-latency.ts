import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { ToxiProxyContainer } from "@testcontainers/toxiproxy"
import { Network } from "testcontainers"
import { startPostgres } from "@/testing/pg"

const PG_IMAGE = "postgres:18-alpine"
const TOXIPROXY_IMAGE = "ghcr.io/shopify/toxiproxy:2.12.0"

export type RttMode = { kind: "loopback" } | { kind: "sweep"; requestedMs: number }

export type RttSample = { rttMs: number; wallMs: number }

export type RttEvidence =
	| { kind: "loopback" }
	| { kind: "sweep"; requestedMs: number; samples: [RttSample, RttSample] }

type PgHandleBase = {
	baseUrl: string
	stop: () => Promise<void>
}

/** A direct loopback endpoint has no latency-injection operation. */
export type PlainPgHandle = PgHandleBase & { kind: "plain" }

/** A proxied endpoint can inject a per-response round-trip delay. */
export type LatencyPgHandle = PgHandleBase & {
	kind: "latency"
	setLatencyMs: (ms: number, jitter?: number) => Promise<void>
}

export type PgHandle = PlainPgHandle | LatencyPgHandle

/** Plain Postgres testcontainer — loopback, ~0ms latency, no proxy. */
export async function startPlainPg(): Promise<PlainPgHandle> {
	const container = await startPostgres()
	return {
		baseUrl: container.getConnectionUri(),
		kind: "plain",
		stop: async () => {
			await container.stop()
		},
	}
}

/**
 * Postgres behind a Toxiproxy on a shared Docker network. porsager connects
 * through the proxy, so a `latency` toxic adds RTT to every query — exposing the
 * per-object round-trip cost the loopback hides.
 */
export async function startLatencyPg(): Promise<LatencyPgHandle> {
	const network = await new Network().start()
	const pg = await new PostgreSqlContainer(PG_IMAGE)
		.withNetwork(network)
		.withNetworkAliases("postgres")
		.start()
	const toxi = await new ToxiProxyContainer(TOXIPROXY_IMAGE).withNetwork(network).start()
	const proxy = await toxi.createProxy({ name: "pg", upstream: "postgres:5432" })
	const baseUrl = `postgresql://${pg.getUsername()}:${pg.getPassword()}@${proxy.host}:${proxy.port}/${pg.getDatabase()}`

	let toxic: Awaited<ReturnType<typeof proxy.instance.addToxic>> | undefined
	return {
		baseUrl,
		kind: "latency",
		setLatencyMs: async (ms, jitter = 0) => {
			if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(jitter) || jitter < 0) {
				throw new Error(
					`latency and jitter must be finite nonnegative numbers: ${ms}/${jitter}`,
				)
			}
			if (toxic) {
				await toxic.remove()
				toxic = undefined
			}
			if (ms > 0) {
				toxic = await proxy.instance.addToxic({
					attributes: { jitter, latency: ms },
					name: "latency",
					stream: "downstream",
					toxicity: 1,
					type: "latency",
				})
			}
		},
		stop: async () => {
			await toxi.stop()
			await pg.stop()
			await network.stop()
		},
	}
}
