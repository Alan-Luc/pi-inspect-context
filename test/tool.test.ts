import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { registerInspectContext } from "../extensions/index.ts";
import { INSPECT_CONTEXT_PARAMETERS, RESEARCH_PACKET_V1_SCHEMA } from "../src/packet.ts";
import { inspectContextToolDefinition } from "../src/adapter.ts";

type RegisteredTool = Parameters<Parameters<typeof registerInspectContext>[0]["registerTool"]>[0];

function register() {
	const registrations: RegisteredTool[] = [];
	let shutdown: ((event: { type: string; reason: string }) => Promise<void>) | undefined;
	registerInspectContext({
		registerTool(tool) { registrations.push(tool); },
		on(_event, handler) { shutdown = handler; },
	});
	assert.equal(registrations.length, 1);
	assert.ok(shutdown);
	return { tool: registrations[0], shutdown };
}

test("registers the closed-world read-only tool metadata", async () => {
	const registered = register();
	try {
		const { tool } = registered;
		assert.equal(tool.name, "inspect_context");
		assert.equal(tool.name, inspectContextToolDefinition.name);
		assert.equal(tool.description, inspectContextToolDefinition.description);
		assert.equal(tool.executionMode, "sequential");
		assert.equal(tool.executionMode, inspectContextToolDefinition.executionMode);
		assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
		assert.deepEqual(tool.annotations, inspectContextToolDefinition.annotations);
		assert.deepEqual(tool.parameters, inspectContextToolDefinition.parameters);
		assert.equal(tool.parameters, INSPECT_CONTEXT_PARAMETERS);
		assert.deepEqual(Object.keys(tool.parameters.properties), ["query"]);
		assert.equal(tool.outputSchema, RESEARCH_PACKET_V1_SCHEMA);
		assert.equal(Value.Check(INSPECT_CONTEXT_PARAMETERS, { query: "needle" }), true);
		assert.equal(Value.Check(INSPECT_CONTEXT_PARAMETERS, { query: "needle", root: "/tmp" }), false);
		assert.match(tool.description, /Call this first, before grep, find, or reading files/);
		assert.match(tool.description, /skips \.harness, \.pi/);
		assert.match(tool.description, /ranked file map with line ranges and one key line per file/);
		assert.doesNotMatch(tool.description, /excerpts|bodyComplete/);
		assert.match(tool.description, /gitignored files, and paths outside the repository/);
		assert.match(tool.description, /loadUserProfile/);
		assert.match(tool.description, /\/health\/ready/);
		assert.match(tool.description, /CACHE_CONFIG_PATH/);
		assert.match(tool.description, /combine 2-5 exact anchors/);
		assert.match(tool.description, /use the returned paths first/);
		assert.match(tool.description, /repeat only for a missing branch/);
		assert.match(tool.description, /zero, weak, or materially omitted evidence is not proof of absence/);
		assert.match(tool.description, /ordinary repository investigation/);
		assert.match(tool.parameters.properties.query.description ?? "", /loadUserProfile/);
		assert.match(tool.parameters.properties.query.description ?? "", /\/health\/ready/);
		assert.match(tool.parameters.properties.query.description ?? "", /CACHE_CONFIG_PATH/);
		assert.match(tool.parameters.properties.query.description ?? "", /combine 2-5 exact anchors/);
		assert.match(tool.parameters.properties.query.description ?? "", /use the returned paths first/);
		assert.match(tool.parameters.properties.query.description ?? "", /repeat only for a missing branch/);
	} finally {
		await registered.shutdown({ type: "session_shutdown", reason: "test complete" });
	}
});

test("the default registered session returns compact actual fixture evidence and full structured JSON", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pi-inspect-context-tool-root-"));
	const registered = register();
	try {
		await assert.rejects(
			registered.tool.execute("invalid", { query: "" }, undefined, undefined, { cwd: join(root, "missing") }),
			/query/i,
		);
		await writeFile(join(root, "source.ts"), "export function needle() { return 1; }\n", "utf8");
		const result = await registered.tool.execute("call-1", { query: "needle" }, undefined, undefined, { cwd: root });
		const content = result.content[0];
		assert.equal(content.type, "text");
		assert.ok(Buffer.byteLength(content.text) <= Buffer.byteLength(JSON.stringify(result.details)) / 2);
		assert.match(content.text, /source\.ts/);
		assert.match(content.text, /export function needle/);
		assert.match(content.text, /untrusted/i);
		assert.doesNotMatch(content.text, /"receipt":|"excerpts":/);
		assert.equal(result.details.excerpts.some(item => item.path === "source.ts" && item.text.includes("export function needle()")), true);
		assert.deepEqual(result.structuredContent, result.details);
		assert.equal(Value.Check(RESEARCH_PACKET_V1_SCHEMA, result.structuredContent), true);
	} finally {
		await registered.shutdown({ type: "session_shutdown", reason: "test complete" });
		await rm(root, { recursive: true, force: true });
	}
});
