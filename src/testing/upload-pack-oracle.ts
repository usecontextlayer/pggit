/**
 * The canonical-git negotiation oracle: run real `git upload-pack --stateless-rpc`
 * over a real repo with the SAME request bytes a test POSTs to pggit, and read its
 * raw response. Negotiation suites compare pggit's acknowledgments section and
 * served pack against this instead of against a transcribed literal, so a change
 * in git's `ok_to_give_up`/ACK rules fails the suite instead of aging out of a
 * comment nobody re-runs.
 *
 * The protocol version is carried by the `GIT_PROTOCOL` env var (exactly how
 * git-http-backend tells upload-pack which version the client asked for), so the
 * spawn is built on `buildGitEnv()` rather than `spawnGit` — the shared env
 * boundary stays the single source of the GIT_* scrub, pinned identity and clock.
 */
import { spawn } from "node:child_process"
import { decodePktStream } from "@/protocol/pkt-line"
import { buildGitEnv } from "@/testing/spawn-git"

/**
 * Feed `request` (a v2 upload-pack POST body, e.g. from `fetchRequest`) to real
 * `git upload-pack --stateless-rpc <dir>` and return its raw response bytes —
 * the same byte stream a smart-HTTP client would read from git-http-backend.
 */
export async function spawnUploadPack(dir: string, request: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["upload-pack", "--stateless-rpc", dir], {
			env: { ...buildGitEnv(), GIT_PROTOCOL: "version=2" },
		})
		// upload-pack may close stdin once it has the whole request; that EPIPE is
		// benign (the exit code below is the real outcome). Any other stdin error is
		// a genuine fault — reject loudly rather than resolving a partial response.
		child.stdin.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code !== "EPIPE" && err.code !== "ERR_STREAM_DESTROYED") reject(err)
		})
		child.stdin.write(request)
		child.stdin.end()

		const stdout: Buffer[] = []
		const stderr: Buffer[] = []
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
		child.on("error", reject)
		child.on("close", (code, signal) => {
			const err = Buffer.concat(stderr).toString("utf8")
			// A signal death or non-zero exit means the oracle never spoke: resolving
			// its truncated output would launder a broken oracle into a green diff.
			if (code !== 0) {
				reject(
					new Error(
						`git upload-pack --stateless-rpc ${dir} exited ${code ?? `by ${signal}`}: ${err.trim()}`,
					),
				)
				return
			}
			resolve(Buffer.concat(stdout))
		})
	})
}

/**
 * The data packets BEFORE the first delim rendered verbatim — the v2 fetch
 * response's acknowledgments section (`acknowledgments\n`, `ACK <oid>\n`…,
 * `NAK\n`, `ready\n`). Empty when the response carries no such section, which is
 * what both git and pggit answer to a request that already said `done`.
 */
export function ackSection(out: Buffer): string {
	const { packets } = decodePktStream(out)
	const delim = packets.findIndex((p) => p.type === "delim")
	const end = delim < 0 ? packets.length : delim
	return packets
		.slice(0, end)
		.map((p) => (p.type === "data" ? p.payload.toString("utf8") : ""))
		.join("")
}
