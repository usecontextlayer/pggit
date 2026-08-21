import { z } from "zod"

const DEFAULT_PG_URL = "postgres://postgres:postgres@localhost:6489/postgres"

const argPairSchema = z
	.string()
	.regex(/^--[a-z][a-z0-9-]*=[\s\S]*$/, "expected --name=value argument")
	.transform((arg) => {
		const separator = arg.indexOf("=")
		return {
			name: arg.slice(2, separator),
			value: arg.slice(separator + 1),
		}
	})

export const nonemptyStringArg = z.string().min(1)
export const integerArg = z.coerce.number().int().safe()
export const positiveIntegerArg = integerArg.positive()
export const positiveNumberArg = z.coerce.number().finite().positive()
export const pgUrlArg = nonemptyStringArg.default(DEFAULT_PG_URL)
const positiveIntegerStringArg = z
	.string()
	.transform(Number)
	.pipe(z.number().int().safe().positive())

/** A comma-separated scale sweep resolved to increasing positive safe integers. */
export function increasingIntegerListArg(
	fallback: readonly number[],
): z.ZodType<number[]> {
	return z
		.string()
		.default(fallback.join(","))
		.transform((raw) => raw.split(","))
		.pipe(
			z
				.array(positiveIntegerStringArg)
				.min(2)
				.refine(
					(values) =>
						values.every((value, index) => {
							const previous = values[index - 1]
							return previous === undefined || value > previous
						}),
					"must contain strictly increasing values",
				),
		)
}

function argPairs(): { name: string; value: string }[] {
	return process.argv.slice(2).map((arg) => argPairSchema.parse(arg))
}

/** Parse a complete standalone entrypoint argv into a caller-owned strict schema.
 * Bare, positional, duplicate, and unknown arguments fail before the entrypoint runs. */
export function parseArgs<T>(schema: z.ZodType<T>): T {
	const values: Record<string, string> = {}
	for (const { name, value } of argPairs()) {
		if (values[name] !== undefined)
			throw new Error(`--${name} was supplied more than once`)
		values[name] = value
	}
	return schema.parse(values)
}

/** Parse a complete entrypoint whose named flags may intentionally repeat. */
export function parseRepeatedArgs<T>(schema: z.ZodType<T>): T {
	const values: Record<string, string[]> = {}
	for (const { name, value } of argPairs()) {
		const existing = values[name]
		if (existing === undefined) values[name] = [value]
		else existing.push(value)
	}
	return schema.parse(values)
}
