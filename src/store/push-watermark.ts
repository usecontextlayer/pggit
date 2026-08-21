import { type Kysely, sql } from "kysely"
import type { Database } from "@/database"
import type { ReposId } from "@/database/models/public/Repos"

/** Mark a repo as having new reclaim candidates after a push-side mutation. */
export async function stampRepoPush(
	exec: Kysely<Database>,
	repoId: ReposId,
): Promise<void> {
	await exec
		.updateTable("repos")
		.set({ last_pushed_at: sql`clock_timestamp()` })
		.where("id", "=", repoId)
		.execute()
}
