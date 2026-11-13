import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(root, "dist"), { recursive: true });
const result = spawnSync("bun", [
	"build", "src/worker/worker-process.ts", "--target=node", "--external=ffi-rs", "--outfile=dist/worker.mjs",
], { cwd: root, encoding: "utf8", shell: false, maxBuffer: 8 * 1024 * 1024 });
if (result.error) throw new Error(`TypeScript worker build could not start Bun: ${result.error.message}`);
if (result.status !== 0) {
	throw new Error(`TypeScript worker build failed: ${result.stderr || result.stdout || result.signal || result.status}`);
}
