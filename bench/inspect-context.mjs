import { createHash } from "node:crypto";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { labelAccuracy, measureBytes, percentile, recallAt5 } from "./metrics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const fixtureCases = [
	{ id: "python-sibling-service", root: "python-monorepo", cwd: "services/billing", query: "charge_customer", expected: [
		{ path: "services/billing/service.py", line: 2, kind: "definition" },
		{ path: "services/billing/api.py", line: 5, kind: "caller" },
		{ path: "services/billing/feature_tests/billing_scenario.py", line: 4, kind: "test" },
	] },
	{ id: "typescript-member-methods", root: "typescript-methods", cwd: "apps/accounts", query: "loadAccount", expected: [
		{ path: "apps/accounts/service.ts", line: 2, kind: "definition" },
		{ path: "apps/accounts/routes.ts", line: 6, kind: "caller" },
		{ path: "apps/accounts/integration-tests/account.test.ts", line: 2, kind: "test" },
	] },
	{ id: "typescript-object-method", root: "typescript-methods", cwd: "apps/accounts", query: "lookupAccount", expected: [
		{ path: "apps/accounts/object.ts", line: 2, kind: "definition" },
		{ path: "apps/accounts/routes.ts", line: 10, kind: "caller" },
		{ path: "apps/accounts/integration-tests/object.ts", line: 4, kind: "test" },
	] },
	{ id: "typescript-arrow-function", root: "typescript-methods", cwd: "apps/accounts", query: "formatAccount", expected: [
		{ path: "apps/accounts/arrow.ts", line: 1, kind: "definition" },
		{ path: "apps/accounts/routes.ts", line: 14, kind: "caller" },
	] },
	{ id: "go-receiver-method", root: "go-receiver", cwd: ".", query: "FetchEntry", expected: [
		{ path: "service.go", line: 5, kind: "definition" },
		{ path: "caller.go", line: 4, kind: "caller" },
		{ path: "feature_tests/service_test.go", line: 5, kind: "test" },
	] },
];

function options(argv) {
	const result = { samples: 10, output: undefined, adapterRoot: undefined, config: undefined };
	for (let index = 0; index < argv.length; index++) {
		const key = argv[index];
		if (!["--samples", "--output", "--adapter-root", "--config"].includes(key) || !argv[index + 1]) throw new Error(`invalid option: ${key}`);
		const value = argv[++index];
		if (key === "--samples") result.samples = Number(value);
		if (key === "--output") result.output = value;
		if (key === "--adapter-root") result.adapterRoot = value;
		if (key === "--config") result.config = value;
	}
	if (!Number.isInteger(result.samples) || result.samples < 10) throw new Error("--samples must be an integer of at least 10");
	return result;
}

export async function runBenchmark(settings) {
	const adapterRoot = resolve(settings.adapterRoot ?? dirname(here));
	const { createInspectContextTool } = await import(pathToFileURL(join(adapterRoot, "src/adapter.ts")).href);
	const tool = createInspectContextTool();
	const cases = settings.config ? JSON.parse(await (await import("node:fs/promises")).readFile(settings.config, "utf8")).cases : fixtureCases;
	if (!Array.isArray(cases) || cases.length === 0) throw new Error("benchmark config must contain at least one case");
	const results = [];
	const elapsedAll = [];
	const scratch = await mkdtemp(join(await realpath(tmpdir()), "inspect-context-bench-"));
	try {
		for (const benchmarkCase of cases) {
			if (typeof benchmarkCase.id !== "string" || !benchmarkCase.id || typeof benchmarkCase.root !== "string" || !benchmarkCase.root || typeof benchmarkCase.query !== "string" || !benchmarkCase.query || !Array.isArray(benchmarkCase.expected) || benchmarkCase.expected.some((label) => typeof label.path !== "string" || !Number.isInteger(label.line) || label.line < 1 || !["definition", "caller", "test", "import", "configuration", "match"].includes(label.kind))) throw new Error(`invalid case: ${benchmarkCase.id ?? "unknown"}`);
			const fixture = resolve(benchmarkCase.root.startsWith("/") ? benchmarkCase.root : join(settings.config ? dirname(resolve(settings.config)) : join(here, "fixtures"), benchmarkCase.root));
			const root = settings.config ? fixture : join(scratch, String(results.length));
			if (!settings.config) {
				await cp(fixture, root, { recursive: true });
				const { execFile } = await import("node:child_process");
				const { promisify } = await import("node:util");
				await promisify(execFile)("git", ["init", "--quiet"], { cwd: root });
				await promisify(execFile)("git", ["add", "-A"], { cwd: root });
			}
			const cwd = resolve(root, benchmarkCase.cwd ?? ".");
			const relativeCwd = relative(root, cwd);
			if (relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`) || isAbsolute(relativeCwd)) {
				throw new Error("case cwd must remain inside its root");
			}
			await tool.execute("benchmark-warmup", { query: benchmarkCase.query }, undefined, undefined, { cwd });
			const elapsed = [];
			let result;
			for (let sample = 0; sample < settings.samples; sample++) {
				const started = performance.now();
				result = await tool.execute("benchmark-sample", { query: benchmarkCase.query }, undefined, undefined, { cwd });
				elapsed.push(performance.now() - started);
			}
			elapsedAll.push(...elapsed);
			const packet = result.details;
			const bytes = measureBytes(packet, result.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
			const contractHash = createHash("sha256").update(JSON.stringify({root: benchmarkCase.root, cwd: relativeCwd, query: benchmarkCase.query, expected: benchmarkCase.expected})).digest("hex");
			results.push({ id: benchmarkCase.id, contractHash, recallAt5: recallAt5(packet, [...new Set(benchmarkCase.expected.map(({ path }) => path))]), labelAccuracy: labelAccuracy(packet, benchmarkCase.expected), p50Ms: percentile(elapsed, 0.5), p95Ms: percentile(elapsed, 0.95), ...bytes });
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
	return { kind: "labeled-offline-benchmark-not-agent-ab", warmupsPerCase: 1, samplesPerCase: settings.samples, cases: results, summary: {
		caseCount: results.length,
		recallAt5: results.reduce((sum, item) => sum + item.recallAt5, 0) / results.length,
		labelAccuracy: results.reduce((sum, item) => sum + item.labelAccuracy, 0) / results.length,
		p50Ms: percentile(elapsedAll, 0.5), p95Ms: percentile(elapsedAll, 0.95),
		packetBytes: Math.round(results.reduce((sum, item) => sum + item.packetBytes, 0) / results.length),
		contentBytes: Math.round(results.reduce((sum, item) => sum + item.contentBytes, 0) / results.length),
		contentTokens: Math.round(results.reduce((sum, item) => sum + item.contentTokens, 0) / results.length),
	} };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try {
		const settings = options(process.argv.slice(2));
		const report = await runBenchmark(settings);
		const serialized = `${JSON.stringify(report, null, 2)}\n`;
		if (settings.output) await (await import("node:fs/promises")).writeFile(settings.output, serialized, { flag: "w" });
		else process.stdout.write(serialized);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
