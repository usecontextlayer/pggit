/**
 * Largest `bytea` value safe to read inline through porsager. Results arrive as
 * `\\x` + hex, doubling their byte length on the JS string heap; this leaves
 * headroom below V8's string limit. Larger object bodies use chunked reads, and
 * repack omits their optional encoding rows so every encoding can be read inline.
 */
export const MAX_INLINE_BYTEA_BYTES = 200_000_000
