import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignSplit, selectInScopeLabels, normalizeQueryKey, rankModelVisiblePaths, scoreCase, summarize } from "../bench/replay/replay.mjs";

test("rank uses first unique file in model-visible order", () => {
	const text = "Untrusted text.\n1. a:1-2,5-6 definition,test | key\n2. dir/b c.ts:3-4 match | x\n3. c:1-1 test\n1 more file omitted.";
	assert.deepEqual(rankModelVisiblePaths(text), ["a", "dir/b c.ts", "c"]);
	assert.deepEqual(rankModelVisiblePaths(JSON.stringify({ evidence: [{ path: "a" }, { path: "b" }, { path: "a" }] })), ["a", "b"]);
	assert.equal(scoreCase(["a", "b", "c"], ["c", "x"]).rank, 3);
	assert.equal(scoreCase(["a"], ["z"]).rank, null);
});

test("summary computes hit@k, MRR, miss rate and bytes", () => {
	const s = summarize([{ rank: 1, contentBytes: 10 }, { rank: 4, contentBytes: 20 }, { rank: null, contentBytes: 30 }, { rank: 2, contentBytes: 40 }]);
	assert.deepEqual([s.hitAt1, s.hitAt3, s.hitAt8, s.missRate], [0.25, 0.5, 0.75, 0.25]);
	assert.equal(s.mrr, (1 + 0.25 + 0 + 0.5) / 4);
	assert.equal(s.contentBytesMedian, 20);
});

test("split is deterministic and queries normalize", () => {
	assert.equal(assignSplit("r\nq"), assignSplit("r\nq"));
	assert.equal(normalizeQueryKey("  Foo   BAR "), "foo bar");
});

test("in-scope labels drop excluded directories and gitignored files", () => {
	const root = mkdtempSync(join(tmpdir(), "replay-scope-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	for (const dir of ["src", ".harness/plans", "dist", "secret"]) mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(join(root, ".gitignore"), "secret/\n");
	for (const file of ["src/a.ts", ".harness/plans/p.md", "dist/b.js", "secret/c.ts"]) writeFileSync(join(root, file), "x\n");
	assert.deepEqual(selectInScopeLabels(root, ["src/a.ts", ".harness/plans/p.md", "dist/b.js", "secret/c.ts"]), ["src/a.ts"]);
});
