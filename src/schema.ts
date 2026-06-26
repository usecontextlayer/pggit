/**
 * pggit's public READ contract
 * (docs/2026-06-26-read-surface-sharpening-design.md §6): the table shapes a consumer
 * types its direct-SQL reads against. pggit's reads are plain SQL on `repo_file ⋈
 * git_object` (joined on `oid = blob_oid`), resolving the wire repo name via `repos` —
 * there is NO read-API library, so these generated row types ARE the read surface. Bind
 * a Kysely instance to `PggitSchema`, or use the narrower row types directly; the table
 * and column names are the contract. Re-exported from Kanel's generated models so a
 * consumer never reaches into pggit internals.
 */
export type { default as PggitSchema } from "@/database/models/Database"
export type {
	default as GitObjectTable,
	GitObject,
} from "@/database/models/public/GitObject"
export type {
	default as RepoFileTable,
	RepoFile,
} from "@/database/models/public/RepoFile"
export type {
	default as ReposTable,
	Repos,
	ReposId,
} from "@/database/models/public/Repos"
