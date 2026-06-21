import { Hono } from "hono"
import { cors } from "hono/cors"
import type { ObjectStore } from "@/object-store"
import { encodePkt, encodePktLine } from "@/pkt-line"
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

function backendFor(deps: GitAppDeps, repoId: string): RepoBackend {
	return {
		getObject: (oid) => deps.objects.getObject(repoId, oid),
		getSymref: (name) => deps.refs.getSymref(repoId, name),
		listRefs: () => deps.refs.listRefs(repoId),
	}
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

	app.get("/:repo/info/refs", (c) => {
		if (c.req.query("service") !== "git-upload-pack") {
			return c.text("only git-upload-pack is supported", 403)
		}
		return c.body(UPLOAD_PACK_ADVERTISEMENT, 200, {
			"Cache-Control": "no-cache",
			"Content-Type": "application/x-git-upload-pack-advertisement",
		})
	})

	app.post("/:repo/git-upload-pack", async (c) => {
		const body = Buffer.from(await c.req.arrayBuffer())
		const out = await handleUploadPack(body, backendFor(deps, c.req.param("repo")))
		return c.body(out, 200, {
			"Cache-Control": "no-cache",
			"Content-Type": "application/x-git-upload-pack-result",
		})
	})

	return app
}
