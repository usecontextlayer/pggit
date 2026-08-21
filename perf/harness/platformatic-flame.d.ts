// @platformatic/flame ships no type declarations; the profile wrapper validates
// the unknown parsed profile at its boundary.
declare module "@platformatic/flame" {
	export function generateMarkdown(
		profilePath: string,
		outputPath: string,
		options: { format: "detailed" },
	): Promise<void>
	export function generateFlamegraph(
		profilePath: string,
		outputPath: string,
	): Promise<void>
	export function parseProfile(profilePath: string): Promise<unknown>
}
