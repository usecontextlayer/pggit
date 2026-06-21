import { Hono } from "hono"
import { cors } from "hono/cors"
import type { ObjectStore } from "@/object-store"
import { encodePkt, encodePktLine } from "@/pkt-line"
import {
	encodeReceivePackAdvertisement,
	handleReceivePack,
	type ReceiveBackend,
} from "@/protocol/receive-pack"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { encodeAdvertisement } from "@/protocol/v2"
import type { RefStore } from "@/refs-store"

export type GitAppDeps = {
	objects: ObjectStore
	refs: RefStore
}

// Smart-HTTP info/refs body: the `# service` preamble + flush, then the v2
// capability advertisement.
const UPLOAD_PACK_ADVERTISEMENT = Buffer.concat([
	encodePktLine(Buffer.from("# service=git-upload-pack\n")),
	encodePkt({ type: "flush" }),
	encodeAdvertisement(),
])

// Hono's body types want an ArrayBuffer, not a Node Buffer (a Uint8Array view).
function toArrayBuffer(buf: Buffer): ArrayBuffer {
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

const ADVERTISEMENT_BODY = toArrayBuffer(UPLOAD_PACK_ADVERTISEMENT)

function backendFor(deps: GitAppDeps, repoId: string): RepoBackend {
	return {
		getObject: (oid) => deps.objects.getObject(repoId, oid),
		getSymref: (name) => deps.refs.getSymref(repoId, name),
		listRefs: () => deps.refs.listRefs(repoId),
	}
}

function receiveBackendFor(deps: GitAppDeps, repoId: string): ReceiveBackend {
	return {
		createRef: (name, newOid) => deps.refs.createRef(repoId, name, newOid),
		ingest: async (pack) => {
			await deps.objects.ingestPack(repoId, pack)
		},
	}
}

/** v0 receive-pack ref advertisement body: the `# service` preamble + ref list. */
async function receivePackAdvertBody(deps: GitAppDeps, repoId: string): Promise<Buffer> {
	const refs = await deps.refs.listRefs(repoId)
	return Buffer.concat([
		encodePktLine(Buffer.from("# service=git-receive-pack\n")),
		encodePkt({ type: "flush" }),
		encodeReceivePackAdvertisement(refs),
	])
}

/**
 * Build the git-remote Hono app (smart-HTTP, protocol v2 fetch). Mountable into
 * a host app via `host.route("/git", createGitApp(deps))`; the host owns the
 * Postgres lifecycle behind `deps`.
 */
export function createGitApp(deps: GitAppDeps): Hono {
	const app = new Hono()
	app.use(cors())

	app.get("/health", (c) => c.text("ok"))

	app.get("/:repo/info/refs", async (c) => {
		const service = c.req.query("service")
		if (service === "git-upload-pack") {
			return c.body(ADVERTISEMENT_BODY, 200, {
				"Cache-Control": "no-cache",
				"Content-Type": "application/x-git-upload-pack-advertisement",
			})
		}
		if (service === "git-receive-pack") {
			const body = await receivePackAdvertBody(deps, c.req.param("repo"))
			return c.body(toArrayBuffer(body), 200, {
				"Cache-Control": "no-cache",
				"Content-Type": "application/x-git-receive-pack-advertisement",
			})
		}
		return c.text(`unsupported service ${JSON.stringify(service)}`, 403)
	})

	app.post("/:repo/git-upload-pack", async (c) => {
		const body = Buffer.from(await c.req.arrayBuffer())
		const out = await handleUploadPack(body, backendFor(deps, c.req.param("repo")))
		return c.body(toArrayBuffer(out), 200, {
			"Cache-Control": "no-cache",
			"Content-Type": "application/x-git-upload-pack-result",
		})
	})

	app.post("/:repo/git-receive-pack", async (c) => {
		const body = Buffer.from(await c.req.arrayBuffer())
		const out = await handleReceivePack(
			body,
			receiveBackendFor(deps, c.req.param("repo")),
		)
		return c.body(toArrayBuffer(out), 200, {
			"Cache-Control": "no-cache",
			"Content-Type": "application/x-git-receive-pack-result",
		})
	})

	return app
}
