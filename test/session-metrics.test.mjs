import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bench/session-metrics.mjs", import.meta.url));
const packet = (excerpts, options = {}) => ({ version: 1, target: { repository: "filesystem", root: "." }, ...options, excerpts, receipt: { bytesRead: 100 } });
const excerpt = (path, startLine, endLine, text = "x") => ({ path, startLine, endLine, text });
const textBlock = (text) => [{ type: "text", text }];
const entry = (id, message) => ({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message });
const call = (toolCallId, name, arguments_ = {}) => ({ type: "toolCall", id: toolCallId, name, arguments: arguments_ });

async function runSession(entries, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "session-metrics-test-"));
  const session = join(directory, "session.jsonl");
  const output = join(directory, "private", "metrics.json");
  let header = options.header === undefined ? { type: "session", cwd: directory } : options.header;
  if (options.gitRoot) {
    const root = join(directory, "repo");
    const service = join(root, "services", "app");
    await mkdir(service, { recursive: true });
    await writeFile(join(root, ".git"), "gitdir: elsewhere\n");
    header = { ...header, cwd: service };
  }
  const lines = options.raw ?? [...(header ? [header] : []), ...entries].map((value) => JSON.stringify(value)).join("\n") + "\n";
  await writeFile(session, lines);
  const result = spawnSync(process.execPath, [cli, "--output", output, session, ...(options.args ?? [])], { encoding: "utf8" });
  return { directory, output, result };
}

test("analyzes inspect reads until first edit and writes private aggregate output", async () => {
  const result = await runSession([
    entry("a", { role: "assistant", content: [call("i1", "inspect_context", { query: "x" })] }),
    entry("b", { role: "toolResult", toolCallId: "i1", toolName: "inspect_context", content: textBlock(JSON.stringify(packet([excerpt("src/a.ts", 1, 4)]))), details: packet([excerpt("src/a.ts", 1, 4)]) }),
    entry("c", { role: "assistant", content: [call("r1", "read", { path: "src/a.ts", offset: 1, limit: 2 }), call("r2", "read", { path: "src/a.ts", offset: 4, limit: 3 })] }),
    entry("c1", { role: "toolResult", toolCallId: "r1", toolName: "read", content: textBlock("line1\nline2") }),
    entry("c2", { role: "toolResult", toolCallId: "r2", toolName: "read", content: textBlock("line4") }),
    entry("d", { role: "assistant", content: [call("f1", "find", { pattern: "a" }), call("r3", "read", { path: "src/missed.ts", limit: 2 })] }),
    entry("d1", { role: "toolResult", toolCallId: "r3", toolName: "read", content: textBlock("missed line") }),
    entry("e", { role: "assistant", content: [call("w1", "write", { path: "src/a.ts" })] }),
    entry("f", { role: "assistant", content: [call("r4", "read", { path: "src/a.ts", limit: 2 })] }),
    entry("g", { role: "assistant", content: textBlock("Answer") }),
  ]);
  try {
    assert.equal(result.result.status, 0, result.result.stderr);
    const report = JSON.parse(await readFile(result.output, "utf8"));
    assert.equal(report.sessions.length, 1);
    assert.equal(report.sessions[0].inspects[0].redundantReadLines, 3);
    assert.deepEqual(report.sessions[0].inspects[0].missedFiles, ["src/missed.ts"]);
    assert.deepEqual(report.sessions[0].inspects[0].toolCalls, { read: 3, grep: 0, find: 1 });
    assert.equal(report.sessions[0].inspects[0].callsToFirstEditOrAnswer, 5);
    assert.ok(report.sessions[0].inspects[0].inspectResultModelBytes > 0);
    assert.equal((await stat(result.output)).mode & 0o777, 0o600);
    assert.equal(report.aggregate.inspectCount, 1);
    assert.equal(report.aggregate.redundantReadLines, 3);
  } finally {
    await rm(result.directory, { recursive: true, force: true });
  }
});

test("measures partial overlaps, unknown read ranges, nested wrappers, and answer termination", async () => {
  const nested = { entry: entry("b", { role: "toolResult", toolCallId: "i1", toolName: "inspect_context", content: textBlock("{}"), details: { packet: packet([excerpt("src/a.ts", 5, 12)]) } }) };
  const result = await runSession([
    entry("a", { role: "assistant", content: [call("i1", "inspect_context")] }),
    nested,
    entry("c", { role: "assistant", content: [call("r1", "read", { path: "src/a.ts", offset: 7, limit: 4 }), call("r2", "read", { path: "src/a.ts" })] }),
    entry("c1", { role: "toolResult", toolCallId: "r1", toolName: "read", content: textBlock("line7\nline8") }),
    entry("d", { role: "assistant", content: textBlock("Answer with no calls" ) }),
    entry("e", { role: "assistant", content: [call("r2", "read", { path: "src/a.ts" })] }),
  ]);
  try {
    assert.equal(result.result.status, 0, result.result.stderr);
    const report = JSON.parse(await readFile(result.output, "utf8"));
    assert.equal(report.sessions[0].inspects[0].redundantReadLines, 2);
    assert.equal(report.sessions[0].inspects[0].callsToFirstEditOrAnswer, 2);
    assert.equal(report.sessions[0].inspects[0].unknownReadRanges, 1);
  } finally {
    await rm(result.directory, { recursive: true, force: true });
  }
});

test("rejects missing packet details and malformed sessions without writing a report", async () => {
  for (const entries of [
    [entry("a", { role: "assistant", content: [call("i1", "inspect_context")] }), entry("b", { role: "toolResult", toolCallId: "i1", toolName: "inspect_context", content: textBlock("no details") })],
  ]) {
    const result = await runSession(entries);
    try {
      assert.notEqual(result.result.status, 0);
      await assert.rejects(readFile(result.output));
    } finally {
      await rm(result.directory, { recursive: true, force: true });
    }
  }
  const malformed = await runSession([], { raw: "{not json}\n" });
  try {
    assert.notEqual(malformed.result.status, 0);
    await assert.rejects(readFile(malformed.output));
  } finally {
    await rm(malformed.directory, { recursive: true, force: true });
  }
});

test("rejects missing session identity and logs without inspect calls instead of reporting zero cost", async () => {
  const cases = [
    { options: { header: null }, entries: [
      entry("a", { role: "assistant", content: [call("i1", "inspect_context")] }),
      entry("b", { role: "toolResult", toolCallId: "i1", toolName: "inspect_context", content: textBlock("{}"), details: packet([]) }),
    ] },
    { options: {}, entries: [] },
  ];
  for (const { entries, options } of cases) {
    const result = await runSession(entries, options);
    try {
      assert.notEqual(result.result.status, 0);
      await assert.rejects(readFile(result.output));
    } finally {
      await rm(result.directory, { recursive: true, force: true });
    }
  }
});

test("resolves Git-root packet paths from a service working directory", async () => {
  const result = await runSession([
    entry("a", { role: "assistant", content: [call("i1", "inspect_context")] }),
    entry("b", { role: "toolResult", toolCallId: "i1", toolName: "inspect_context", content: textBlock("{}"), details: packet([excerpt("src/a.ts", 2, 3)], { target: { repository: "git", root: "." } }) }),
    entry("c", { role: "assistant", content: [call("r1", "read", { path: join("..", "..", "src", "a.ts"), offset: 2, limit: 2 })] }),
    entry("d", { role: "toolResult", toolCallId: "r1", toolName: "read", content: textBlock("two\nthree") }),
    entry("e", { role: "assistant", content: textBlock("Done") }),
  ], { header: { type: "session", cwd: "__SERVICE_CWD__" }, gitRoot: true });
  try {
    assert.equal(result.result.status, 0, result.result.stderr);
    const report = JSON.parse(await readFile(result.output, "utf8"));
    assert.equal(report.sessions[0].inspects[0].rootResolution, "resolved");
    assert.equal(report.sessions[0].inspects[0].redundantReadLines, 2);
  } finally {
    await rm(result.directory, { recursive: true, force: true });
  }
});

test("clips overlap to returned EOF lines and excludes failed or mentioned paths from missed files", async () => {
  const result = await runSession([
    entry("a", { role: "assistant", content: [call("i1", "inspect_context")] }),
    entry("b", { role: "toolResult", toolCallId: "i1", toolName: "inspect_context", content: textBlock("{}"), details: packet(
      [excerpt("src/a.ts", 7, 12)],
      { definitions: [{ path: "src/defined.ts" }], omissions: [{ reason: "excerpt_limit", count: 1, examples: ["src/omitted.ts"] }] },
    ) }),
    entry("c", { role: "assistant", content: [call("r1", "read", { path: "src/a.ts", offset: 7, limit: 5 }), call("r2", "read", { path: "src/failed.ts", limit: 2 }), call("r3", "read", { path: "src/defined.ts", limit: 1 }), call("r4", "read", { path: "src/omitted.ts", limit: 1 })] }),
    entry("d", { role: "toolResult", toolCallId: "r1", toolName: "read", content: textBlock("line7\nline8"), details: { truncation: { outputLines: 2 } } }),
    entry("e", { role: "toolResult", toolCallId: "r2", toolName: "read", content: textBlock("permission denied"), isError: true }),
    entry("f", { role: "toolResult", toolCallId: "r3", toolName: "read", content: textBlock("defined line") }),
    entry("g", { role: "toolResult", toolCallId: "r4", toolName: "read", content: textBlock("omitted line") }),
    entry("h", { role: "assistant", content: textBlock("Done") }),
  ]);
  try {
    assert.equal(result.result.status, 0, result.result.stderr);
    const inspect = JSON.parse(await readFile(result.output, "utf8")).sessions[0].inspects[0];
    assert.equal(inspect.redundantReadLines, 2);
    assert.deepEqual(inspect.missedFiles, []);
    assert.equal(inspect.unknownReadRanges, 1);
  } finally {
    await rm(result.directory, { recursive: true, force: true });
  }
});

test("keeps failed and incomplete inspections local and marks unfinished boundaries unknown", async () => {
  const result = await runSession([
    entry("a", { role: "assistant", content: [call("bad", "inspect_context")] }),
    entry("b", { role: "toolResult", toolCallId: "bad", toolName: "inspect_context", content: textBlock("failure"), isError: true }),
    entry("c", { role: "assistant", content: [call("good", "inspect_context")] }),
    entry("d", { role: "toolResult", toolCallId: "good", toolName: "inspect_context", content: textBlock("{}"), details: packet([excerpt("src/a.ts", 1, 2)]) }),
    entry("e", { role: "assistant", content: [call("r1", "read", { path: "src/a.ts", offset: 1, limit: 2 })] }),
    entry("f", { role: "toolResult", toolCallId: "r1", toolName: "read", content: textBlock("line1\nline2") }),
  ]);
  try {
    assert.equal(result.result.status, 0, result.result.stderr);
    const report = JSON.parse(await readFile(result.output, "utf8"));
    assert.equal(report.sessions[0].inspects[0].status, "failed");
    assert.equal(report.sessions[0].inspects[0].redundantReadLines, null);
    assert.equal(report.sessions[0].inspects[1].status, "ok");
    assert.equal(report.sessions[0].inspects[1].callsToFirstEditOrAnswer, null);
    assert.equal(report.aggregate.callsToFirstEditOrAnswer, null);
  } finally {
    await rm(result.directory, { recursive: true, force: true });
  }
});
