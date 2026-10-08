import { chmod, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin" && process.platform !== "linux") {
	throw new Error(`pi-inspect-context supports macOS and Linux only; unsupported platform: ${process.platform}`);
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workerRoot = join(packageRoot, "worker");
const outputPath = join(packageRoot, "bin", "inspect-context");
const go = process.env.GO_BIN || "go";

function run(label, args) {
	const result = spawnSync(go, args, { cwd: workerRoot, stdio: "inherit", shell: false });
	if (result.error) throw new Error(`${label} could not start ${go}: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`${label} failed with ${result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`}`);
}

await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
run("Go worker tests", ["test", "./..."]);
run("Go worker build", ["build", "-trimpath", "-ldflags=-s -w", "-o", outputPath, "./cmd/inspect-context"]);
await chmod(outputPath, 0o755);
console.log(`Built ${outputPath}`);
