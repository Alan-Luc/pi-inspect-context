import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { registerInspectContext } from "../extensions/index.ts";
import { INSPECT_CONTEXT_PARAMETERS, RESEARCH_PACKET_V1_SCHEMA } from "../src/packet.ts";
import { createInspectContextTool } from "../src/adapter.ts";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function packetWorkerSource(): string {
	return `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const text = "const needle = 1;";
const packet = {
  version: 1,
  target: { query: request.query, root: ".", repository: "filesystem" },
  snapshot: { id: "snapshot", validated: true },
  governingArtifacts: [], definitions: [], callers: [], imports: [], tests: [], configuration: [],
  matches: [{ excerptId: "e1", path: "src/a.ts", startLine: 1, endLine: 1, confidence: "observed", reason: "literal match" }],
  excerpts: [{ id: "e1", path: "src/a.ts", startLine: 1, endLine: 1, kind: "match", text }],
  unknowns: [], omissions: [],
  receipt: { packetId: "packet", schemaVersion: 1, policyVersion: "inspect-context-mini-v1", snapshotId: "snapshot", durationMs: 1, discoveredFiles: 1, readFiles: 1, bytesRead: text.length, excerptCount: 1, omissionCount: 0 }
};
process.stdout.write(JSON.stringify(packet));
`;
}

async function makeDirectory(prefix: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(await realpath(tmpdir()), prefix));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function makeWorker(root: string): Promise<string> {
	const modulePath = join(root, "worker.mjs");
	const workerPath = join(root, "worker.sh");
	await writeFile(modulePath, packetWorkerSource(), { encoding: "utf8", mode: 0o600 });
	await writeFile(workerPath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(modulePath)}\n`, { encoding: "utf8", mode: 0o700 });
	await chmod(workerPath, 0o700);
	return workerPath;
}

test("registers exactly one direct sequential closed-world read-only tool", () => {
	const registrations: Array<ReturnType<typeof createInspectContextTool>> = [];
	registerInspectContext({ registerTool(tool) { registrations.push(tool); } });
	assert.equal(registrations.length, 1);
	const tool = registrations[0];
	assert.equal(tool.name, "inspect_context");
	assert.equal(tool.executionMode, "sequential");
	assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
	assert.equal(tool.parameters, INSPECT_CONTEXT_PARAMETERS);
	assert.equal(tool.outputSchema, RESEARCH_PACKET_V1_SCHEMA);
	assert.equal(Value.Check(INSPECT_CONTEXT_PARAMETERS, { query: "needle" }), true);
	assert.equal(Value.Check(INSPECT_CONTEXT_PARAMETERS, { query: "needle", root: "/tmp" }), false);
	assert.match(tool.description, /zero results are not proof of absence/);
	assert.match(tool.description, /ordinary repository investigation/);
});

test("the registered handler returns identical compact content, details, and structured data", async () => {
	const directory = await makeDirectory("pi-inspect-context-tool-worker-");
	const workspace = await makeDirectory("pi-inspect-context-tool-root-");
	try {
		const workerPath = await makeWorker(directory.root);
		const registrations: Array<ReturnType<typeof createInspectContextTool>> = [];
		registerInspectContext({ registerTool(tool) { registrations.push(tool); } }, { workerPath });
		const tool = registrations[0];
		const result = await tool.execute("call-1", { query: "needle" }, undefined, undefined, { cwd: workspace.root });
		const content = result.content[0];
		assert.equal(content.type, "text");
		const parsed = JSON.parse(content.text);
		assert.deepEqual(parsed, result.details);
		assert.deepEqual(result.structuredContent, result.details);
		assert.equal(Value.Check(RESEARCH_PACKET_V1_SCHEMA, result.structuredContent), true);
	} finally {
		await directory.cleanup();
		await workspace.cleanup();
	}
});
