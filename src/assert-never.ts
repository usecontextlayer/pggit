/** Make a closed union fail loudly if a new variant reaches an old dispatcher. */
export function assertNever(value: never): never {
	throw new Error(`unhandled variant: ${JSON.stringify(value)}`)
}
