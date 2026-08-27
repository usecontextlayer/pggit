import { describe, expect, it } from "vitest"
import { resolveGcSchedulerOptions } from "@/store/gc-scheduler"

// The options schema is the drain's ONE default site, and its resolution
// contract is undefined-tolerant: a host building overrides from optional env
// values passes `key: undefined` for anything unset, and that must resolve to
// the default — never clobber it. The plausible reimplementation, a spread
// merge over a defaults object, fails exactly that case silently.
describe("resolveGcSchedulerOptions", () => {
	it("resolves an empty override set to the defaults", () => {
		expect(resolveGcSchedulerOptions({})).toEqual({
			concurrency: 4,
			graceSeconds: 60,
			intervalMs: 30_000,
			repackEnabled: true,
		})
	})

	it("treats an explicitly-undefined override as absent, never as a value", () => {
		const resolved = resolveGcSchedulerOptions({
			concurrency: undefined,
			graceSeconds: undefined,
			intervalMs: undefined,
			repackEnabled: undefined,
		})
		expect(resolved).toEqual({
			concurrency: 4,
			graceSeconds: 60,
			intervalMs: 30_000,
			repackEnabled: true,
		})
	})

	it("keeps explicit overrides beside resolved defaults", () => {
		const resolved = resolveGcSchedulerOptions({ concurrency: 2, repackEnabled: false })
		expect(resolved).toEqual({
			concurrency: 2,
			graceSeconds: 60,
			intervalMs: 30_000,
			repackEnabled: false,
		})
	})
})
