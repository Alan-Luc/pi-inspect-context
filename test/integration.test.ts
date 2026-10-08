import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { registerInspectContext } from "../extensions/index.ts";
import { createInspectContextTool } from "../src/adapter.ts";

const execFileAsync = promisify(execFile);

test("the registered tool executes the packaged Go worker", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-inspect-context-integration-"));
	try {
		const sourceRoot = join(root, "src");
		await mkdir(sourceRoot);
		await writeFile(join(sourceRoot, "feature.go"), "func integratedNeedle() {}\n", "utf8");
		await execFileAsync("git", ["init", "--quiet"], { cwd: root });
		await execFileAsync("git", ["add", "--", "src/feature.go"], { cwd: root });

		const registrations: Array<ReturnType<typeof createInspectContextTool>> = [];
		registerInspectContext({ registerTool(tool) { registrations.push(tool); } });
		const result = await registrations[0].execute(
			"integration-call",
			{ query: "integratedNeedle" },
			undefined,
			undefined,
			{ cwd: sourceRoot },
		);
		const packet = result.details;

		assert.deepEqual(JSON.parse(result.content[0].text), packet);
		assert.deepEqual(result.structuredContent, packet);
		assert.equal(packet.target.repository, "git");
		assert.equal(packet.target.root, ".");
		assert.equal(packet.target.query, "integratedNeedle");
		assert.equal(packet.snapshot.validated, true);
		const definition = packet.definitions.find((item) => item.path === "src/feature.go");
		assert.ok(definition);
		const excerpt = packet.excerpts.find((item) => item.id === definition.excerptId);
		assert.match(excerpt?.text ?? "", /func integratedNeedle\(\)/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
