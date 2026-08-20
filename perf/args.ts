/** Strict readers for the `--name=value` convention shared by standalone perf harnesses. */
export function optionalFlag(name: string): string | undefined {
	const prefix = `--${name}=`
	const matches = process.argv.filter((arg) => arg.startsWith(prefix))
	if (matches.length > 1) {
		throw new Error(`--${name} was supplied ${matches.length} times`)
	}
	return matches[0]?.slice(prefix.length)
}

export function flag(name: string, fallback: string): string {
	return optionalFlag(name) ?? fallback
}

export function integerFlag(
	name: string,
	fallback: number,
	limits: { min: number; max?: number },
): number {
	const raw = optionalFlag(name)
	const value = raw === undefined ? fallback : Number(raw)
	if (
		!Number.isSafeInteger(value) ||
		value < limits.min ||
		(limits.max !== undefined && value > limits.max)
	) {
		const range =
			limits.max === undefined ? `>= ${limits.min}` : `${limits.min}..${limits.max}`
		throw new Error(`--${name}=${raw ?? fallback} must be a safe integer in ${range}`)
	}
	return value
}

export function positiveIntegerFlag(name: string, fallback: number): number {
	const raw = optionalFlag(name) ?? String(fallback)
	const value = Number(raw)
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`--${name}=${raw} must be a positive safe integer`)
	}
	return value
}

export function positiveNumberFlag(name: string, fallback: number): number {
	const raw = optionalFlag(name) ?? String(fallback)
	const value = Number(raw)
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`--${name}=${raw} must be a positive finite number`)
	}
	return value
}

/** A scale sweep: at least `minLength` positive safe integers in strict ascending order. */
export function increasingIntegerListFlag(
	name: string,
	fallback: readonly number[],
	minLength = 2,
): number[] {
	if (!Number.isSafeInteger(minLength) || minLength < 1) {
		throw new Error(`minimum --${name} list length must be a positive safe integer`)
	}
	const raw = optionalFlag(name) ?? fallback.join(",")
	const values = raw.split(",").map((part) => Number(part))
	if (
		values.length < minLength ||
		values.some((value) => !Number.isSafeInteger(value) || value < 1) ||
		values.some((value, index) => index > 0 && value <= (values[index - 1] as number))
	) {
		throw new Error(
			`--${name}=${raw} must contain at least ${minLength} strictly increasing positive safe integers`,
		)
	}
	return values
}
