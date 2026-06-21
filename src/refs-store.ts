import type { Sql } from "postgres"

const DDL = `
create table if not exists refs (
	repo_id text not null,
	name text not null,
	oid text,
	symref_target text,
	primary key (repo_id, name),
	-- a ref is exactly one of: direct (oid) or symbolic (symref_target)
	constraint refs_oid_xor_symref check ((oid is null) != (symref_target is null))
);
`

export type RefRow = { name: string; oid: string }

export type RefStore = ReturnType<typeof createRefStore>

/**
 * Postgres-backed git refs: direct refs (name → oid) and symbolic refs
 * (HEAD → refs/heads/...). Per-op CAS for atomic push lands with M2; M0 needs
 * only set + list for the ls-refs advertisement.
 */
export function createRefStore(sql: Sql) {
	return {
		async getSymref(repoId: string, name: string): Promise<string | null> {
			const [row] = await sql`
				select symref_target from refs
				where repo_id = ${repoId} and name = ${name}
			`
			return row?.symref_target ?? null
		},

		/** Direct refs (name → oid), sorted by name. Excludes symbolic refs. */
		async listRefs(repoId: string): Promise<RefRow[]> {
			const rows = await sql`
				select name, oid from refs
				where repo_id = ${repoId} and oid is not null
				order by name
			`
			return rows.map((r) => ({ name: r.name, oid: r.oid }))
		},
		async migrate(): Promise<void> {
			await sql.unsafe(DDL)
		},

		async setRef(repoId: string, name: string, oid: string): Promise<void> {
			await sql`
				insert into refs ${sql({ name, oid, repo_id: repoId })}
				on conflict (repo_id, name)
				do update set oid = excluded.oid, symref_target = null
			`
		},

		async setSymref(repoId: string, name: string, target: string): Promise<void> {
			await sql`
				insert into refs ${sql({ name, repo_id: repoId, symref_target: target })}
				on conflict (repo_id, name)
				do update set symref_target = excluded.symref_target, oid = null
			`
		},
	}
}
