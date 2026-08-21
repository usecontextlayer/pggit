import type { Collector } from "@/instrument"

/** Read one positive named measurement whose value proves that its path ran. */
export function requiredPositiveMeasurement(
	measurements: ReadonlyMap<string, number>,
	name: string,
	context: string,
): number {
	const value = measurements.get(name)
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${context}: required ${name} measurement is missing or invalid`)
	}
	return value
}

/** Select exactly one named collector so duplicate or absent runs cannot be scored. */
export function requiredCollector(
	collectors: readonly Collector[],
	label: string,
	context: string,
): Collector {
	const matches = collectors.filter((collector) => collector.label === label)
	const [collector] = matches
	if (collector === undefined || matches.length !== 1) {
		throw new Error(
			`${context}: expected exactly one ${label} collector, got ${matches.length}`,
		)
	}
	return collector
}

/** Read one positive counter whose value proves that the measured path ran. */
export function requiredPositiveCounter(
	collector: Collector,
	metric: string,
	context: string,
): number {
	return requiredPositiveMeasurement(collector.counters, metric, context)
}

/** Read one positive phase duration; absent phases are missing evidence, never zero work. */
export function requiredPhase(
	collector: Collector,
	phase: string,
	context: string,
): number {
	return requiredPositiveMeasurement(collector.phaseMs, phase, context)
}
