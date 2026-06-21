import { startServer } from "@/server"

// Standalone boot entry: `pnpm run dev` → tsx src/main.ts. The open socket keeps
// the loop alive; Ctrl-C tears it down.
const { port } = await startServer()
console.log(`[pggit] listening on http://localhost:${port}`)
