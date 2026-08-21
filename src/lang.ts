/**
 * Language-level generics. Admission rule: zero domain imports, generic over T,
 * no knowledge of git or Postgres — a helper that knows about either belongs in
 * its own layer, not here.
 */

/** Make a closed union fail loudly if a new variant reaches an old dispatcher. */
export function assertNever(value: never): never {
	throw new Error(`unhandled variant: ${JSON.stringify(value)}`)
}

/** Split `items` into consecutive batches of at most `size`. */
export function batches<T>(items: T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
	return out
}
