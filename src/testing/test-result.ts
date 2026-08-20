/** A test operation whose failure is evidence to retain while the suite keeps running. */
export type TestResult<T> =
	| { kind: "succeeded"; value: T }
	| { kind: "failed"; error: unknown }

/** Run one test operation without letting its failure hide the remaining probe arms. */
export async function captureTestResult<T>(
	run: () => Promise<T>,
): Promise<TestResult<T>> {
	try {
		return { kind: "succeeded", value: await run() }
	} catch (error) {
		return { error, kind: "failed" }
	}
}

/** Add retained failure evidence to an assertion label, at the presentation edge. */
export function testResultContext<T>(result: TestResult<T>, context: string): string {
	return result.kind === "failed" ? `${context}: ${String(result.error)}` : context
}
