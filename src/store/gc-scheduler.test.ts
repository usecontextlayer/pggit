import { describe, expect, it } from "vitest"
import { resolveGcSchedulerOptions } from "@/store/gc-scheduler"

// The options schema is the drain's ONE default site, and its resolution
// contract is undefined-tolerant: a host building overrides from optional env
// values passes `key: undefined` for anything unset, and that must resolve to
// the default — never clobber it. The plausible reimplementation, a spread
// merge over a defaults object, fails exactly that case silently.
describe("resolveGcSchedulerOptions", () => {
	it("treats an explicitly-undefined override as absent, never as a value", () => {
		expect(resolveGcSchedulerOptions({ concurrency: undefined }).concurrency).toBe(4)
	})
})
