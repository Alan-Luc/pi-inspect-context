import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("package includes new model and worker runtime sources", () => {
	const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: dirname(dirname(fileURLToPath(import.meta.url))),
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	const files = new Set(JSON.parse(result.stdout)[0].files.map((file) => file.path));
	const requiredFiles = ["src/model-evidence.ts", "worker/body.go", "worker/scope.go"];
	assert.deepEqual(requiredFiles.filter((path) => !files.has(path)), []);
});
