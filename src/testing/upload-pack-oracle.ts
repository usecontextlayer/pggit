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
import { assertNever } from "@/lang"
import { decodePktStream } from "@/protocol/pkt-line"
import {
	buildGitEnv,
	type NonZeroExitCode,
	parseNonZeroExitCode,
} from "@/testing/spawn-git"

type ExpectedUploadPackError = { code: NonZeroExitCode; out: Buffer }

type SpawnUploadPackOptions = { expectInBandError: true }

/**
 * Feed `request` (a v2 upload-pack POST body, e.g. from `fetchRequest`) to real
 * `git upload-pack --stateless-rpc <dir>` and return its raw response bytes —
 * the same byte stream a smart-HTTP client would read from git-http-backend.
 */
export function spawnUploadPack(dir: string, request: Buffer): Promise<Buffer>
export function spawnUploadPack(
	dir: string,
	request: Buffer,
	opts: SpawnUploadPackOptions,
): Promise<ExpectedUploadPackError>
export async function spawnUploadPack(
	dir: string,
	request: Buffer,
	opts?: SpawnUploadPackOptions,
): Promise<Buffer | ExpectedUploadPackError> {
	return new Promise<Buffer | ExpectedUploadPackError>((resolve, reject) => {
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
			const out = Buffer.concat(stdout)
			const err = Buffer.concat(stderr).toString("utf8")
			if (opts?.expectInBandError) {
				// Missing wants are canonical Git's exception to the usual subprocess
				// contract: upload-pack writes a complete in-band ERR pkt to stdout and
				// exits 128. Accept only that fully framed shape; every other nonzero
				// result remains an oracle failure.
				if (code === null || code === 0) {
					reject(
						new Error(
							`git upload-pack --stateless-rpc ${dir} expected an in-band error but exited ${code ?? `by ${signal}`}`,
						),
					)
					return
				}
				try {
					const decoded = decodePktStream(out)
					const lastData = decoded.packets
						.filter((packet) => packet.type === "data")
						.at(-1)
					// Probed (git 2.55): the ERR payload carries NO trailing newline —
					// packet_writer_error frames the bare message.
					if (
						decoded.rest.length > 0 ||
						lastData?.type !== "data" ||
						!/^ERR .+\n?$/.test(lastData.payload.toString("utf8"))
					) {
						throw new Error("stdout was not a complete in-band ERR response")
					}
				} catch (error) {
					reject(
						new Error(
							`git upload-pack --stateless-rpc ${dir} exited ${code} without a valid in-band ERR: ${String(error)}; stderr: ${err.trim()}`,
						),
					)
					return
				}
				resolve({ code: parseNonZeroExitCode(code), out })
				return
			}
			// By default, a signal death or non-zero exit means the oracle never
			// spoke: resolving partial output would launder a broken oracle into a
			// green differential.
			if (code !== 0) {
				reject(
					new Error(
						`git upload-pack --stateless-rpc ${dir} exited ${code ?? `by ${signal}`}: ${err.trim()}`,
					),
				)
				return
			}
			resolve(out)
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
	const { packets, rest } = decodePktStream(out)
	if (rest.length > 0) {
		throw new Error(`truncated upload-pack response (${rest.length} undecoded bytes)`)
	}
	const delim = packets.findIndex((p) => p.type === "delim")
	let end = delim
	if (delim < 0) {
		if (packets.at(-1)?.type !== "flush") {
			throw new Error("upload-pack acknowledgment response lacks a terminal flush")
		}
		end = packets.length - 1
	}
	let text = ""
	for (const packet of packets.slice(0, end)) {
		switch (packet.type) {
			case "data":
				text += packet.payload.toString("utf8")
				break
			case "flush":
				throw new Error("unexpected flush inside upload-pack acknowledgment section")
			case "delim":
				throw new Error(
					"unexpected second delimiter inside upload-pack acknowledgment section",
				)
			case "response-end":
				throw new Error(
					"unexpected response-end inside upload-pack acknowledgment section",
				)
			default:
				assertNever(packet)
		}
	}
	return text
}
