import { mkdir, readFile, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_READ_OFFSET = 1;
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch"]);

function fail(message) {
  throw new Error(message);
}

function parseArguments(args) {
  let output;
  const sessions = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--output") {
      if (output !== undefined || !args[index + 1]) fail("--output requires one destination");
      output = resolve(args[++index]);
    } else if (args[index].startsWith("--")) {
      fail(`unknown option ${args[index]}`);
    } else {
      sessions.push(resolve(args[index]));
    }
  }
  if (!output || sessions.length === 0) fail("usage: node bench/session-metrics.mjs --output <path> <session.jsonl> [...]");
  if (sessions.includes(output)) fail("output must not overwrite an input session");
  return { output, sessions };
}

function unwrapEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (value.entry && typeof value.entry === "object") return unwrapEntry(value.entry);
  if (value.sessionEntry && typeof value.sessionEntry === "object") return unwrapEntry(value.sessionEntry);
  if (value.type === "message" && value.message && typeof value.message === "object") {
    let message = value.message;
    while (message.message && typeof message.message === "object") message = message.message;
    return { ...value, message };
  }
  return value;
}

function readSession(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail("session contains malformed JSONL");
    }
    entries.push(unwrapEntry(parsed));
  }
  return entries;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}

function packetFrom(result) {
  const details = result.message.details;
  const candidate = details?.packet ?? details;
  if (candidate && typeof candidate === "object" && Array.isArray(candidate.excerpts)) return candidate;
  const text = textContent(result.message.content);
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.excerpts)) return parsed;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function toolCalls(entry) {
  if (entry?.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) return [];
  return entry.message.content.filter((block) => block?.type === "toolCall" && typeof block.name === "string").map((block) => ({
    id: block.id,
    name: block.name.toLowerCase(),
    arguments: block.arguments && typeof block.arguments === "object" ? block.arguments : {},
  }));
}

function isAnswer(entry) {
  const reason = entry?.message?.stopReason;
  return entry?.type === "message" && entry.message?.role === "assistant" && !toolCalls(entry).length && (reason === undefined || reason === "stop");
}

function resultEntries(entries) {
  return entries.flatMap((entry, index) => entry?.type === "message" && entry.message?.role === "toolResult" ? [{ entry, index, message: entry.message }] : []);
}

function findGitRoot(sessionCwd) {
  try {
    if (!lstatSync(sessionCwd).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  let current = sessionCwd;
  for (;;) {
    try {
      const marker = lstatSync(resolve(current, ".git"));
      return marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile()) ? undefined : current;
    } catch (error) {
      if (error?.code !== "ENOENT") return undefined;
    }
    const parent = resolve(current, "..");
    if (parent === current) return undefined;
    current = parent;
  }
}

function packetRoot(packet, sessionCwd) {
  const repository = packet.target?.repository;
  if (repository === "git") return findGitRoot(sessionCwd);
  if (repository === "filesystem") return sessionCwd;
  return undefined;
}

function packetPaths(packet, root) {
  const paths = new Set();
  if (!root) return paths;
  for (const category of ["governingArtifacts", "definitions", "callers", "imports", "tests", "configuration", "matches", "excerpts"]) {
    for (const item of packet[category] ?? []) if (typeof item?.path === "string") paths.add(resolve(root, item.path));
  }
  for (const omission of packet.omissions ?? []) {
    for (const example of omission.examples ?? []) if (typeof example === "string") paths.add(resolve(root, example));
  }
  return paths;
}

function packetRanges(packet, root) {
  const ranges = new Map();
  for (const excerpt of packet.excerpts) {
    if (typeof excerpt?.path !== "string" || !Number.isInteger(excerpt.startLine) || !Number.isInteger(excerpt.endLine) || excerpt.startLine < 1 || excerpt.endLine < excerpt.startLine) continue;
    const path = resolve(root, excerpt.path);
    ranges.set(path, [...(ranges.get(path) ?? []), [excerpt.startLine, excerpt.endLine]]);
  }
  return ranges;
}

function mergedRanges(ranges) {
  const merged = [];
  for (const [start, end] of ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1])) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function returnedReadRange(call, result) {
  if (!result || result.message.isError) return undefined;
  const offset = Number.isInteger(call.arguments.offset) && call.arguments.offset > 0 ? call.arguments.offset : DEFAULT_READ_OFFSET;
  const output = textContent(result.message.content);
  const shown = /Showing lines (\d+)-(\d+) of/u.exec(output);
  if (shown) return [Number(shown[1]), Number(shown[2])];
  const outputLines = result.message.details?.truncation?.outputLines;
  if (Number.isInteger(outputLines) && outputLines >= 0) return [offset, offset + outputLines - 1];
  const textBlocks = Array.isArray(result.message.content) ? result.message.content.filter((block) => block?.type === "text") : [];
  if (!textBlocks.length) return undefined;
  const body = output.replace(/\n\n\[(?:\d+ more lines in file|Showing lines )[^\]]*\][\s\S]*$/u, "");
  const lineCount = body.length === 0 ? 0 : body.split(/\r?\n/u).length - (body.endsWith("\n") ? 1 : 0);
  return [offset, offset + lineCount - 1];
}

function emptyInspect(status, reason, result) {
  const bytes = result ? Buffer.byteLength(textContent(result.message.content), "utf8") : null;
  return {
    status,
    reason,
    redundantReadLines: null,
    completeBodyRereadLines: null,
    missedFiles: null,
    toolCalls: null,
    callsToFirstEditOrAnswer: null,
    unknownReadRanges: null,
    rootResolution: null,
    inspectResultModelBytes: bytes,
    inspectResultEstimatedTokens: bytes === null ? null : Math.ceil(bytes / 4),
  };
}

function analyzeInspect(entries, inspectCall, inspectIndex, results, sessionCwd) {
  const result = results.find(({ index, message }) => index > inspectIndex && message.toolCallId === inspectCall.id);
  if (!result) return emptyInspect("incomplete", "no persisted tool result");
  if (result.message.isError) return emptyInspect("failed", "tool returned an error", result);
  const packet = packetFrom(result);
  if (!packet) fail("successful inspect_context result is missing packet details");

  const root = packetRoot(packet, sessionCwd);
  const rootResolution = root ? "resolved" : "unresolved";
  const returnedRanges = root ? packetRanges(packet, resolve(root, packet.target?.root ?? ".")) : new Map();
  const completeBodyRanges = root ? packetRanges({ excerpts: packet.excerpts.filter((excerpt) => excerpt?.bodyComplete === true && (excerpt.kind === "definition" || excerpt.kind === "caller")) }, resolve(root, packet.target?.root ?? ".")) : new Map();
  const mentionedPaths = root ? packetPaths(packet, resolve(root, packet.target?.root ?? ".")) : new Set();
  const reads = [];
  const toolCounts = { read: 0, grep: 0, find: 0 };
  let callsToStop = 0;
  let stopped = false;
  for (let index = result.index + 1; index < entries.length && !stopped; index += 1) {
    const entry = entries[index];
    const calls = toolCalls(entry);
    if (calls.length) {
      for (const call of calls) {
        callsToStop += 1;
        if (call.name === "read") {
          toolCounts.read += 1;
          const path = typeof call.arguments.path === "string" ? resolve(sessionCwd, call.arguments.path) : undefined;
          const readResult = results.find(({ index: resultIndex, message }) => resultIndex > index && message.toolCallId === call.id);
          reads.push({ path, range: returnedReadRange(call, readResult), successful: Boolean(readResult && !readResult.message.isError) });
        } else if (call.name.includes("grep")) toolCounts.grep += 1;
        else if (call.name.includes("find")) toolCounts.find += 1;
        if (EDIT_TOOLS.has(call.name)) {
          stopped = true;
          break;
        }
      }
    } else if (isAnswer(entry)) {
      stopped = true;
    }
  }

  let redundantReadLines = 0;
  let completeBodyRereadLines = 0;
  let unknownReadRanges = 0;
  const missed = new Set();
  for (const read of reads) {
    if (!read.path || !read.range || !read.successful) unknownReadRanges += 1;
    if (!read.path || !read.successful || !root) continue;
    if (!mentionedPaths.has(read.path)) missed.add(relative(sessionCwd, read.path).split(sep).join("/"));
    if (!read.range) continue;
    for (const [start, end] of mergedRanges(returnedRanges.get(read.path) ?? [])) {
      const overlapStart = Math.max(start, read.range[0]);
      const overlapEnd = Math.min(end, read.range[1]);
      if (overlapEnd >= overlapStart) redundantReadLines += overlapEnd - overlapStart + 1;
    }
    for (const [start, end] of mergedRanges(completeBodyRanges.get(read.path) ?? [])) {
      const overlapStart = Math.max(start, read.range[0]);
      const overlapEnd = Math.min(end, read.range[1]);
      if (overlapEnd >= overlapStart) completeBodyRereadLines += overlapEnd - overlapStart + 1;
    }
  }

  const modelBytes = Buffer.byteLength(textContent(result.message.content), "utf8");
  return {
    status: "ok",
    redundantReadLines: root ? redundantReadLines : null,
    completeBodyRereadLines: root && stopped && unknownReadRanges === 0 ? completeBodyRereadLines : null,
    missedFiles: root ? [...missed] : null,
    toolCalls: toolCounts,
    callsToFirstEditOrAnswer: stopped ? callsToStop : null,
    unknownReadRanges,
    rootResolution,
    inspectResultModelBytes: modelBytes,
    inspectResultEstimatedTokens: Math.ceil(modelBytes / 4),
  };
}

async function analyzeSession(path) {
  let entries;
  try {
    entries = readSession(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("session contains")) throw error;
    fail("could not read session JSONL");
  }
  const sessionCwd = entries.find((entry) => entry?.type === "session")?.cwd;
  if (typeof sessionCwd !== "string" || !isAbsolute(sessionCwd)) fail("session requires an absolute cwd header");
  const cwd = resolve(sessionCwd);
  const results = resultEntries(entries);
  const inspects = [];
  for (let index = 0; index < entries.length; index += 1) {
    for (const call of toolCalls(entries[index])) {
      if (call.name === "inspect_context") inspects.push(analyzeInspect(entries, call, index, results, cwd));
    }
  }
  return { session: basename(path), inspects };
}

function sumKnown(inspects, key) {
  return inspects.every((inspect) => typeof inspect[key] === "number")
    ? inspects.reduce((sum, inspect) => sum + inspect[key], 0)
    : null;
}

function aggregate(sessions) {
  const inspects = sessions.flatMap(({ inspects: rows }) => rows);
  const toolCalls = inspects.every((inspect) => inspect.toolCalls !== null)
    ? Object.fromEntries(["read", "grep", "find"].map((name) => [name, inspects.reduce((sum, inspect) => sum + inspect.toolCalls[name], 0)]))
    : null;
  return {
    inspectCount: inspects.length,
    redundantReadLines: sumKnown(inspects, "redundantReadLines"),
    completeBodyRereadLines: sumKnown(inspects, "completeBodyRereadLines"),
    missedFiles: inspects.every((inspect) => Array.isArray(inspect.missedFiles))
      ? [...new Set(inspects.flatMap((inspect) => inspect.missedFiles))]
      : null,
    toolCalls,
    callsToFirstEditOrAnswer: sumKnown(inspects, "callsToFirstEditOrAnswer"),
    unknownReadRanges: sumKnown(inspects, "unknownReadRanges"),
    inspectResultModelBytes: sumKnown(inspects, "inspectResultModelBytes"),
    inspectResultEstimatedTokens: sumKnown(inspects, "inspectResultEstimatedTokens"),
  };
}

async function main() {
  const { output, sessions: paths } = parseArguments(process.argv.slice(2));
  const sessions = await Promise.all(paths.map(analyzeSession));
  if (!sessions.some((session) => session.inspects.length > 0)) fail("no inspect_context calls found in persisted sessions");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify({ sessions, aggregate: aggregate(sessions) }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`session-metrics: ${error instanceof Error ? error.message : "analysis failed"}\n`);
    process.exitCode = 1;
  });
}
