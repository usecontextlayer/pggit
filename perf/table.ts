/** Render a rectangular measurement table as aligned Markdown. */
export function table(
	headers: readonly string[],
	rows: readonly (readonly (string | number)[])[],
): string {
	if (headers.length === 0)
		throw new Error("measurement table requires at least one column")
	const body = rows.map((row, index) => {
		if (row.length !== headers.length) {
			throw new Error(
				`measurement table row ${index} has ${row.length}/${headers.length} columns`,
			)
		}
		return row.map(String)
	})
	const columns = headers.map((header, index) => {
		let width = header.length
		for (const row of body) {
			const cell = row[index]
			if (cell === undefined)
				throw new Error(`measurement table row omitted column ${index}`)
			width = Math.max(width, cell.length)
		}
		return { index, width }
	})
	const line = (row: readonly string[]): string => {
		const cells = columns.map(({ index, width }) => {
			const cell = row[index]
			if (cell === undefined)
				throw new Error(`measurement table row omitted column ${index}`)
			return cell.padEnd(width)
		})
		return `| ${cells.join(" | ")} |`
	}
	return [
		line(headers),
		`|${columns.map(({ width }) => "-".repeat(width + 2)).join("|")}|`,
		...body.map(line),
	].join("\n")
}
