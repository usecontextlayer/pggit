import { defineConfig } from "tsdown"

export default defineConfig({
	clean: true,
	dts: true,
	entry: ["src/index.ts", "src/schema.ts"],
	format: ["esm"],
	minify: false,
	outDir: "dist",
	platform: "node",
	sourcemap: true,
})
