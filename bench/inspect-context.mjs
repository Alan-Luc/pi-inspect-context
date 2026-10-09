import { performance } from "node:perf_hooks";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectContext } from "../src/adapter.ts";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const samplesPerCase = 5;
const cases = [
	{
		id: "adapter-worker-path",
		queryParts: ["packaged", "WorkerPath"],
		expectedPath: "src/adapter.ts",
		replaces: ["grep for the worker path resolver", "read the defining adapter section"],
	},
	{
		id: "worker-root-authorization",
		queryParts: ["openAuthorized", "Repository"],
		expectedPath: "worker/worker.go",
		replaces: ["grep for root authorization", "read the worker implementation", "search for related tests"],
	},
	{
		id: "extension-registration",
		queryParts: ["registerInspect", "ContextExtension"],
		expectedPath: "extensions/index.ts",
		replaces: ["locate the extension entrypoint", "read the registration implementation"],
	},
	{
		id: "manifest-schema",
		queryParts: ["AUTHORIZATION", "_MANIFEST_SCHEMA"],
		expectedPath: "src/packet.ts",
		replaces: ["grep for the manifest schema", "read the protocol definition"],
	},
];
const evidenceKeys = ["definitions", "callers", "imports", "tests", "configuration", "matches"];

function percentile(values, fraction) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function rankedPaths(packet) {
	const seen = new Set();
	const paths = [];
	for (const key of evidenceKeys) {
		for (const reference of packet[key]) {
			if (seen.has(reference.path)) continue;
			seen.add(reference.path);
			paths.push(reference.path);
		}
	}
	return paths;
}

const results = [];
const allElapsedMs = [];
for (const benchmarkCase of cases) {
	const query = benchmarkCase.queryParts.join("");
	await inspectContext({ cwd: repositoryRoot }, { query });
	const elapsedMs = [];
	const workerMs = [];
	let packet;
	for (let sample = 0; sample < samplesPerCase; sample++) {
		const started = performance.now();
		packet = await inspectContext({ cwd: repositoryRoot }, { query });
		elapsedMs.push(performance.now() - started);
		workerMs.push(packet.receipt.durationMs);
	}
	const rank = rankedPaths(packet).indexOf(benchmarkCase.expectedPath) + 1;
	allElapsedMs.push(...elapsedMs);
	results.push({
		id: benchmarkCase.id,
		expectedPath: benchmarkCase.expectedPath,
		recalled: rank > 0,
		relevantPathRank: rank > 0 ? rank : null,
		p50Ms: percentile(elapsedMs, 0.5),
		p95Ms: percentile(elapsedMs, 0.95),
		workerP50Ms: percentile(workerMs, 0.5),
		workerP95Ms: percentile(workerMs, 0.95),
		replaces: benchmarkCase.replaces,
	});
}

const recalledRanks = results.flatMap((result) => result.relevantPathRank === null ? [] : [result.relevantPathRank]);
const report = {
	kind: "labeled-offline-check-not-agent-ab",
	coldProcessPerCall: true,
	warmupsPerCase: 1,
	samplesPerCase,
	cases: results,
	summary: {
		caseCount: results.length,
		relevantPathRecall: recalledRanks.length / cases.length,
		medianRelevantPathRank: recalledRanks.length === 0 ? null : percentile(recalledRanks, 0.5),
		p50Ms: percentile(allElapsedMs, 0.5),
		p95Ms: percentile(allElapsedMs, 0.95),
		estimatedReconnaissanceCallsReplaced: results.reduce((total, result) => total + result.replaces.length, 0),
	},
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (recalledRanks.length !== cases.length) process.exitCode = 1;
