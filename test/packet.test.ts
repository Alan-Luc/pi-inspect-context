import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Value } from "typebox/value";
import {
	AUTHORIZATION_MANIFEST_SCHEMA,
	INSPECT_CONTEXT_PARAMETERS,
	MAX_PACKET_BYTES,
	MAX_QUERY_BYTES,
	POLICY_VERSION,
	RESEARCH_PACKET_V1_SCHEMA,
	WORKER_REQUEST_SCHEMA,
	InspectContextError,
	normalizeQuery,
	packetByteLength,
	serializePacket,
	type ResearchPacketV1,
} from "../src/packet.ts";

function packet(text = "match"): ResearchPacketV1 {
	return {
		version: 1,
		target: { query: "needle", root: ".", repository: "filesystem" },
		snapshot: { id: "snapshot", validated: true },
		governingArtifacts: [],
		definitions: [],
		callers: [],
		imports: [],
		tests: [],
		configuration: [],
		matches: [],
		excerpts: [{ id: "e1", path: "src/a.ts", startLine: 1, endLine: 1, kind: "match", text }],
		unknowns: ["Relations are lexical candidates, not a semantic call graph."],
		omissions: [],
		receipt: {
			packetId: "packet",
			schemaVersion: 1,
			policyVersion: POLICY_VERSION,
			snapshotId: "snapshot",
			durationMs: 0,
			discoveredFiles: 1,
			readFiles: 1,
			bytesRead: text.length,
			excerptCount: 1,
			omissionCount: 0,
		},
	};
}

test("normalizes searchable queries before enforcing the UTF-8 byte limit", () => {
	assert.equal(normalizeQuery({ query: "e\u0301" }), "é");
	assert.equal(normalizeQuery({ query: "é".repeat(MAX_QUERY_BYTES / 2) }).length, MAX_QUERY_BYTES / 2);
	assert.throws(
		() => normalizeQuery({ query: "é".repeat(MAX_QUERY_BYTES / 2 + 1) }),
		(error: unknown) => error instanceof InspectContextError && error.code === "invalid_query",
	);
});

test("accepts exact and multi-term queries and rejects malformed or unsearchable input", () => {
	assert.equal(normalizeQuery({ query: "/health/ready" }), "/health/ready");
	assert.equal(normalizeQuery({ query: "cache refresh startup" }), "cache refresh startup");
	for (const value of [null, [], {}, { query: "x", root: "/tmp" }, { query: 1 }, { query: "" }, { query: "a\0b" }, { query: "  " }, { query: "///***" }]) {
		assert.throws(
			() => normalizeQuery(value),
			(error: unknown) => error instanceof InspectContextError && error.code === "invalid_query",
		);
	}
});

test("publishes closed input, protocol, and output schemas", () => {
	assert.equal(INSPECT_CONTEXT_PARAMETERS.additionalProperties, false);
	assert.deepEqual(INSPECT_CONTEXT_PARAMETERS.required, ["query"]);
	assert.match(INSPECT_CONTEXT_PARAMETERS.properties.query.description ?? "", /loadUserProfile.*\/health\/ready.*CACHE_CONFIG_PATH/);
	assert.equal(WORKER_REQUEST_SCHEMA.additionalProperties, false);
	assert.equal(AUTHORIZATION_MANIFEST_SCHEMA.additionalProperties, false);
	assert.equal(RESEARCH_PACKET_V1_SCHEMA.additionalProperties, false);
	assert.equal(RESEARCH_PACKET_V1_SCHEMA.properties.receipt.additionalProperties, false);
	assert.equal(RESEARCH_PACKET_V1_SCHEMA.properties.receipt.properties.policyVersion.const, POLICY_VERSION);
});

test("matches the shared protocol goldens", async () => {
	const fixture = async (name: string): Promise<string> =>
		await readFile(new URL(`fixtures/protocol/${name}`, import.meta.url), "utf8");
	const request = JSON.parse(await fixture("request.json"));
	const manifest = JSON.parse(await fixture("manifest.json"));
	const goldenPacket = (await fixture("packet.json")).trim();
	const parsedPacket: unknown = JSON.parse(goldenPacket);

	assert.equal(Value.Check(WORKER_REQUEST_SCHEMA, request), true);
	assert.equal(Value.Check(AUTHORIZATION_MANIFEST_SCHEMA, manifest), true);
	assert.equal(Value.Check(RESEARCH_PACKET_V1_SCHEMA, parsedPacket), true);
	assert.equal(serializePacket(parsedPacket as ResearchPacketV1), goldenPacket);
	assert.equal(Value.Check(WORKER_REQUEST_SCHEMA, { ...request, extra: true }), false);
});

test("serializes compact no-match packets and rejects packets above the byte budget", () => {
	const noMatch = packet();
	noMatch.matches = [];
	noMatch.excerpts = [];
	noMatch.unknowns = ["No lexical matches; retry with an exact symbol, route, config key, or path fragment."];
	noMatch.receipt.excerptCount = 0;
	const serializedNoMatch = serializePacket(noMatch);
	assert.ok(Buffer.byteLength(serializedNoMatch, "utf8") < 2_048);
	assert.equal(Value.Check(RESEARCH_PACKET_V1_SCHEMA, noMatch), true);

	const compact = serializePacket(packet());
	assert.equal(compact.includes("\n"), false);
	assert.equal(Buffer.byteLength(compact, "utf8"), packetByteLength(packet()));

	const oversized = packet("x".repeat(MAX_PACKET_BYTES));
	assert.throws(
		() => serializePacket(oversized),
		(error: unknown) => error instanceof InspectContextError && error.code === "packet_fit_failed",
	);
});
