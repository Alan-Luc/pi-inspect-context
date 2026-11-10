import assert from "node:assert/strict";
import test from "node:test";
import { labelAccuracy, recallAt5, rankedExcerptPaths, measureBytes } from "../bench/metrics.mjs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchmark, fixtureCases } from "../bench/inspect-context.mjs";

test("recall ranks distinct paths in excerpt reading order, not category order", () => {
	const packet = { governingArtifacts: [{ path: "README.md" }], excerpts: [
		{ path: "README.md", kind: "governing" },
		{ path: "z.ts" }, { path: "a.ts" }, { path: "z.ts" }, { path: "c.ts" }, { path: "d.ts" }, { path: "e.ts" },
	] };
	assert.deepEqual(rankedExcerptPaths(packet), ["z.ts", "a.ts", "c.ts", "d.ts", "e.ts"]);
	assert.equal(recallAt5(packet, ["e.ts"]), 1);
	assert.equal(recallAt5(packet, ["missing.ts"]), 0);
});

test("label accuracy requires matching path, source line, and role", () => {
	const packet = { excerpts: [
		{ path: "src/a.py", startLine: 2, endLine: 4, kind: "definition" },
		{ path: "tests/test_a.py", startLine: 8, endLine: 10, kind: "test" },
	] };
	assert.equal(labelAccuracy(packet, [
		{ path: "src/a.py", line: 3, kind: "definition" },
		{ path: "tests/test_a.py", line: 9, kind: "test" },
	]), 1);
	assert.equal(labelAccuracy(packet, [
		{ path: "src/a.py", line: 3, kind: "caller" },
		{ path: "tests/test_a.py", line: 9, kind: "test" },
	]), 0.5);
});

test("private config inspects the original root without copying or changing its Git index", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "benchmark-config-"));
	try {
		const root = join(scratch, "repository");
		const adapterRoot = join(scratch, "adapter");
		await mkdir(join(root, "app"), { recursive: true });
		await mkdir(join(adapterRoot, "src"), { recursive: true });
		await writeFile(join(adapterRoot, "src/adapter.ts"), `export function createInspectContextTool() { return { execute: async (_id, _params, _signal, _update, ctx) => {
			if (ctx.cwd !== ${JSON.stringify(join(root, "app"))}) throw new Error("private root was copied");
			return { details: { excerpts: [{path:"app/source.ts",startLine:1,endLine:1,kind:"definition"}] }, content: [{type:"text",text:"compact"},{type:"text",text:" view"}] };
		} }; }`);
		const config = join(scratch, "config.json");
		await writeFile(config, JSON.stringify({cases:[{id:"private",root,cwd:"app",query:"symbol",expected:[{path:"app/source.ts",line:1,kind:"definition"}]}]}));
		const report = await runBenchmark({config,adapterRoot,samples:10});
		assert.equal(report.cases[0].recallAt5, 1);
		assert.equal(report.cases[0].contentBytes, 12);
	} finally {
		await rm(scratch, {recursive:true,force:true});
	}
});

test("public labels point to actual matching lines in all three fixture corpora", async () => {
	assert.equal(new Set(fixtureCases.map(({root}) => root)).size, 3);
	for (const fixture of fixtureCases) {
		for (const fact of fixture.expected) {
			const path = new URL(`../bench/fixtures/${fixture.root}/${fact.path}`, import.meta.url);
			const lines = (await readFile(path, "utf8")).split("\n");
			assert.ok(lines[fact.line - 1]?.includes(fixture.query), `${fixture.id}: ${fact.path}:${fact.line}`);
		}
	}
});

test("byte metrics measure serialized packet and exact model-facing text", () => {
	const packet = { message: "é" };
	const modelContent = `tool says ${JSON.stringify(packet)}`;
	const measured = measureBytes(packet, modelContent);
	assert.equal(measured.packetBytes, Buffer.byteLength(JSON.stringify(packet)));
	assert.equal(measured.contentBytes, Buffer.byteLength(modelContent));
	assert.equal(measured.contentTokens, Math.ceil(measured.contentBytes / 4));
});
