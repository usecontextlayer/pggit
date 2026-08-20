import type { createGitApp } from "@/index"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"

/** Frame exact receive-pack command payloads, a terminal flush, and an optional pack. */
export function receivePackRequest(
	commandPayloads: readonly string[],
	pack: Buffer = Buffer.alloc(0),
): Buffer {
	return Buffer.concat([
		...commandPayloads.map((payload) => encodePktLine(Buffer.from(payload, "utf8"))),
		encodePkt({ type: "flush" }),
		pack,
	])
}

/** POST one receive-pack request while preserving the response as wire bytes. */
export async function postReceivePack(
	app: ReturnType<typeof createGitApp>,
	repo: string,
	body: Buffer,
): Promise<{ status: number; body: Buffer }> {
	const response = await app.request(`/${repo}/git-receive-pack`, {
		body: new Uint8Array(body),
		method: "POST",
	})
	return {
		body: Buffer.from(await response.arrayBuffer()),
		status: response.status,
	}
}
