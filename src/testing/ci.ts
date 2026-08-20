import { z } from "zod"

/** Test-runner configuration boundary: any non-empty CI value selects the broad corpus. */
export const IS_CI = z
	.string()
	.optional()
	.transform((value) => value !== undefined && value !== "")
	.parse(process.env.CI)
