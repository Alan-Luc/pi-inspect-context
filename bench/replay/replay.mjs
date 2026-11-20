import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { percentile } from "../metrics.mjs";
import { exclusionReason } from "../../src/worker/retrieval.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultHarvest = join(packageRoot, "../pi-inspect-context/.harness/eval/ic-eval/harvest.json");
const defaultOutputDir = join(packageRoot, "../pi-inspect-context/.harness/eval/replay");
const developmentShare = 0.7;

export const normalizeQueryKey = (query) => query.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

const hashOf = (text) => createHash("sha256").update(text).digest("hex");

export function assignSplit(key) {
	return parseInt(hashOf(key).slice(0, 8), 16) / 0x100000000 < developmentShare ? "development" : "holdout";
}

export function rankModelVisiblePaths(contentText) {
	return [...new Set(JSON.parse(contentText).evidence.map((item) => item.path))];
}

export function scoreCase(rankedPaths, labels) {
	const firstHit = rankedPaths.findIndex((path) => labels.includes(path));
	return { rank: firstHit < 0 ? null : firstHit + 1 };
}

export function selectInScopeLabels(root, labels) {
	const indexable = labels.filter((path) => !exclusionReason(path));
	if (indexable.length === 0) return [];
	const check = spawnSync("git", ["check-ignore", "--", ...indexable], { cwd: root, encoding: "utf8" });
	if (check.status !== 0 && check.status !== 1) throw new Error(`git check-ignore failed in ${root}: ${check.stderr}`);
	const ignored = new Set(check.stdout.split("\n").filter(Boolean));
	return indexable.filter((path) => !ignored.has(path));
}

export function summarize(results) {
	const ranks = results.map((item) => item.rank);
	const share = (predicate) => ranks.filter(predicate).length / ranks.length;
	const bytes = results.map((item) => item.contentBytes);
	return {
		cases: results.length,
		hitAt1: share((rank) => rank !== null && rank <= 1),
		hitAt3: share((rank) => rank !== null && rank <= 3),
		hitAt8: share((rank) => rank !== null && rank <= 8),
		mrr: ranks.reduce((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / ranks.length,
		missRate: share((rank) => rank === null),
		contentBytesMedian: percentile(bytes, 0.5),
		contentBytesP90: percentile(bytes, 0.9),
	};
}

async function loadTool(adapterRoot) {
	let tool;
	const shutdown = [];
	const { default: register } = await import(pathToFileURL(join(adapterRoot, "extensions/index.ts")).href);
	register({ registerTool(value) { tool = value; }, on(event, handler) { if (event === "session_shutdown") shutdown.push(handler); } });
	return { tool, close: async () => { for (const handler of shutdown) await handler({ type: "session_shutdown", reason: "quit" }); } };
}

async function buildCases(harvest, resolveRoot) {
	const dropped = { cwdMissing: 0, duplicate: 0, noLabel: 0 };
	const labels = { total: 0, vanished: 0, outsideRepo: 0 };
	const merged = new Map();
	for (const record of harvest) {
		if (!existsSync(record.cwd) || !statSync(record.cwd).isDirectory()) { dropped.cwdMissing++; continue; }
		const root = await resolveRoot(record.cwd);
		const key = `${root}\n${normalizeQueryKey(record.query)}`;
		const existing = merged.get(key);
		if (existing) {
			dropped.duplicate++;
			for (const read of record.reads) existing.reads.add(read);
		} else {
			merged.set(key, { key, root, cwd: record.cwd, query: record.query, reads: new Set(record.reads) });
		}
	}
	const cases = [];
	for (const entry of merged.values()) {
		const found = new Set();
		for (const read of entry.reads) {
			labels.total++;
			const path = relative(entry.root, isAbsolute(read) ? read : resolve(entry.cwd, read));
			if (path.startsWith("..") || isAbsolute(path)) { labels.outsideRepo++; continue; }
			if (!existsSync(join(entry.root, path)) || !statSync(join(entry.root, path)).isFile()) { labels.vanished++; continue; }
			found.add(path.split(sep).join("/"));
		}
		if (found.size === 0) { dropped.noLabel++; continue; }
		cases.push({ id: hashOf(entry.key).slice(0, 12), split: assignSplit(entry.key), cwd: entry.cwd, query: entry.query, labels: [...found].sort() });
	}
	cases.sort((a, b) => a.id.localeCompare(b.id));
	return { cases, dropped, labels };
}

export async function runReplay({ split, harvestPath = defaultHarvest, outputDir = defaultOutputDir, adapterRoot = packageRoot }) {
	if (!["development", "holdout"].includes(split)) throw new Error("--split must be development or holdout");
	const { resolveInspectionRoot } = await import(pathToFileURL(join(adapterRoot, "src/adapter.ts")).href);
	const harvest = JSON.parse(await readFile(harvestPath, "utf8"));
	const built = await buildCases(harvest, (cwd) => resolveInspectionRoot(realpathSync(cwd)));
	await mkdir(outputDir, { recursive: true });
	const splitPath = join(outputDir, "split.json");
	if (!existsSync(splitPath)) {
		await writeFile(splitPath, `${JSON.stringify({ rule: `sha256(repo\\nnormalized query) first 32 bits / 2^32 < ${developmentShare} => development`, harvestRecords: harvest.length, dropped: built.dropped, labels: built.labels, cases: built.cases }, null, 1)}\n`, "utf8");
	}
	const frozen = JSON.parse(await readFile(splitPath, "utf8"));
	const selected = frozen.cases.filter((item) => item.split === split);
	const results = [];
	for (const item of selected) {
		const { tool, close } = await loadTool(adapterRoot);
		try {
			let rank = null, inScopeRank = null, snapshotId = null, contentBytes = 0, error = null;
			const inScopeLabels = selectInScopeLabels(await resolveInspectionRoot(realpathSync(item.cwd)), item.labels);
			try {
				const result = await tool.execute("replay", { query: item.query }, undefined, undefined, { cwd: item.cwd });
				const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("");
				contentBytes = Buffer.byteLength(text, "utf8");
				const ranked = rankModelVisiblePaths(text);
				rank = scoreCase(ranked, item.labels).rank;
				inScopeRank = scoreCase(ranked, inScopeLabels).rank;
				snapshotId = result.details.snapshot.id;
			} catch (caught) {
				error = caught instanceof Error ? caught.message : String(caught);
			}
			results.push({ id: item.id, rank, inScopeLabels: inScopeLabels.length, inScopeRank, snapshotId, contentBytes, error });
		} finally {
			await close();
		}
	}
	const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: adapterRoot, encoding: "utf8" }).trim();
	const report = { adapterRevision: revision, split, summary: summarize(results), inScopeSummary: summarize(results.filter((item) => item.inScopeLabels > 0).map((item) => ({ ...item, rank: item.inScopeRank }))), errors: results.filter((item) => item.error).length, results };
	const outputPath = join(outputDir, `${split}-scores.json`);
	const text = `${JSON.stringify(report, null, 1)}\n`;
	await writeFile(outputPath, text, "utf8");
	return { report, outputPath, text, frozen };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const index = process.argv.indexOf("--split");
	const { report, outputPath, text, frozen } = await runReplay({ split: process.argv[index + 1] });
	const counts = { development: 0, holdout: 0 };
	for (const item of frozen.cases) counts[item.split]++;
	console.log(JSON.stringify({ counts, dropped: frozen.dropped, labels: frozen.labels }));
	if (report.split === "holdout") console.log(`holdout cases=${report.summary.cases} errors=${report.errors}; scores stored at ${outputPath}`);
	else console.log(JSON.stringify({ all: report.summary, inScope: report.inScopeSummary, errors: report.errors }, null, 1));
	console.log(`sha256 ${hashOf(text)}`);
}
