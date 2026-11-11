import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	InspectContextError,
	MAX_PACKET_BYTES,
	POLICY_VERSION,
	type ResearchPacketV1,
} from "../src/packet.ts";
import {
	inspectContext,
	parseWorkerResponse,
	resolveInspectionRoot,
	runWorker,
} from "../src/adapter.ts";

const execFileAsync = promisify(execFile);

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function packet(query = "needle"): ResearchPacketV1 {
	const text = "const needle = 1;";
	return {
		version: 1,
		target: { query, root: ".", repository: "filesystem" },
		snapshot: { id: "snapshot", validated: true },
		governingArtifacts: [],
		definitions: [],
		callers: [],
		imports: [],
		tests: [],
		configuration: [],
		matches: [{ excerptId: "e1", path: "src/a.ts", startLine: 1, endLine: 1, confidence: "observed", reason: "literal match" }],
		excerpts: [{ id: "e1", path: "src/a.ts", startLine: 1, endLine: 1, kind: "match", text }],
		unknowns: [],
		omissions: [],
		receipt: {
			packetId: "packet",
			schemaVersion: 1,
			policyVersion: POLICY_VERSION,
			snapshotId: "snapshot",
			durationMs: 1,
			discoveredFiles: 1,
			readFiles: 1,
			bytesRead: Buffer.byteLength(text, "utf8"),
			excerptCount: 1,
			omissionCount: 0,
		},
	};
}

async function makeDirectory(prefix: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(await realpath(tmpdir()), prefix));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function makeWorker(root: string, source: string): Promise<string> {
	const modulePath = join(root, "worker.mjs");
	const workerPath = join(root, "worker.sh");
	await writeFile(modulePath, source, { encoding: "utf8", mode: 0o600 });
	await writeFile(workerPath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(modulePath)}\n`, { encoding: "utf8", mode: 0o700 });
	await chmod(workerPath, 0o700);
	return workerPath;
}

function packetWorkerSource(value: ResearchPacketV1, extra = ""): string {
	return `
import fs from "node:fs";
const input = await new Promise((resolve, reject) => {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("error", reject);
  process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});
const request = JSON.parse(input);
const packet = ${JSON.stringify(value)};
packet.target.query = request.query;
${extra}
process.stdout.write(JSON.stringify(packet));
`;
}

async function makeRepository(): Promise<{ root: string; nested: string; cleanup: () => Promise<void> }> {
	const repository = await makeDirectory("pi-inspect-context-git-");
	const nested = join(repository.root, "src", "nested");
	await (await import("node:fs/promises")).mkdir(nested, { recursive: true });
	await writeFile(join(repository.root, "src", "file.ts"), "const needle = 1;\n", "utf8");
	const environment = {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "inspect-context-test",
		GIT_AUTHOR_EMAIL: "inspect-context-test@example.invalid",
		GIT_COMMITTER_NAME: "inspect-context-test",
		GIT_COMMITTER_EMAIL: "inspect-context-test@example.invalid",
	};
	await execFileAsync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repository.root, env: environment });
	await execFileAsync("git", ["add", "--all", "--"], { cwd: repository.root, env: environment });
	await execFileAsync("git", ["commit", "--quiet", "-m", "initial"], { cwd: repository.root, env: environment });
	return { ...repository, nested };
}

async function waitForFile(path: string): Promise<string> {
	for (let attempt = 0; attempt < 80; attempt++) {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	throw new Error(`file was not written: ${path}`);
}

async function waitForProcessGone(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt++) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`process ${pid} is still alive`);
}

test("normalizes the query before touching an invalid cwd", async () => {
	await assert.rejects(
		inspectContext({ cwd: join(tmpdir(), "missing-inspect-context-root") }, { query: "", extra: true }),
		(error: unknown) => error instanceof InspectContextError && error.code === "invalid_query",
	);
});

test("resolves Git roots and authorizes the cwd itself outside Git", async () => {
	const filesystemRoot = await makeDirectory("pi-inspect-context-filesystem-");
	const gitRepository = await makeRepository();
	try {
		const filesystemNested = join(filesystemRoot.root, "nested");
		await (await import("node:fs/promises")).mkdir(filesystemNested);
		assert.equal(await resolveInspectionRoot(filesystemNested), filesystemNested);
		assert.equal(await resolveInspectionRoot(gitRepository.nested), gitRepository.root);
	} finally {
		await filesystemRoot.cleanup();
		await gitRepository.cleanup();
	}
});

test("passes only the authorized root-relative cwd to the worker", async () => {
	const directory = await makeDirectory("pi-inspect-context-cwd-request-");
	const repository = await makeRepository();
	const probe = join(directory.root, "request.json");
	try {
		const worker = await makeWorker(directory.root, packetWorkerSource(packet(), `
fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify(request));
`));
		await inspectContext({ cwd: repository.nested }, { query: "needle" }, { workerPath: worker });
		const request = JSON.parse(await readFile(probe, "utf8"));
		assert.equal(request.root, repository.root);
		assert.equal(request.cwd, "src/nested");
		assert.deepEqual(Object.keys(request).sort(), ["cwd", "query", "root", "version"]);
	} finally {
		await directory.cleanup();
		await repository.cleanup();
	}
});

test("rejects a symlink cwd before worker execution", async () => {
	const directory = await makeDirectory("pi-inspect-context-symlink-");
	const target = join(directory.root, "target");
	const link = join(directory.root, "link");
	try {
		await (await import("node:fs/promises")).mkdir(target);
		await (await import("node:fs/promises")).symlink(target, link);
		await assert.rejects(resolveInspectionRoot(link), /symlink/i);
	} finally {
		await directory.cleanup();
	}
});

test("sends one compact request and private manifest, then removes temporary state", async () => {
	const directory = await makeDirectory("pi-inspect-context-manifest-");
	const workspace = await makeDirectory("pi-inspect-context-workspace-");
	const probe = join(directory.root, "probe.json");
	const worker = await makeWorker(directory.root, packetWorkerSource(packet(), `
const manifestPath = process.env.INSPECT_CONTEXT_MANIFEST;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const metadata = fs.statSync(manifestPath);
fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({
  request,
  manifest,
  manifestKeys: Object.keys(manifest).sort(),
  manifestMode: metadata.mode & 0o777,
  runRoot: process.cwd(),
  leaked: process.env.INSPECT_CONTEXT_TEST_SECRET ?? null,
}));
`));
	const oldSecret = process.env.INSPECT_CONTEXT_TEST_SECRET;
	process.env.INSPECT_CONTEXT_TEST_SECRET = "must-not-cross-boundary";
	try {
		const result = await inspectContext({ cwd: workspace.root }, { query: "e\u0301" }, { workerPath: worker });
		assert.equal(result.target.query, "é");
		const details = JSON.parse(await readFile(probe, "utf8")) as {
			request: { version: number; root: string; cwd: string; query: string };
			manifest: { version: number; root: string };
			manifestKeys: string[];
			manifestMode: number;
			runRoot: string;
			leaked: string | null;
		};
		assert.deepEqual(Object.keys(details.request).sort(), ["cwd", "query", "root", "version"]);
		assert.equal(details.request.cwd, ".");
		assert.deepEqual(details.manifestKeys, ["root", "version"]);
		assert.equal(details.manifestMode, 0o600);
		assert.equal(details.request.root, workspace.root);
		assert.deepEqual(details.manifest, { root: workspace.root, version: 1 });
		assert.equal(details.leaked, null);
		await assert.rejects(lstat(details.runRoot), { code: "ENOENT" });
	} finally {
		if (oldSecret === undefined) delete process.env.INSPECT_CONTEXT_TEST_SECRET;
		else process.env.INSPECT_CONTEXT_TEST_SECRET = oldSecret;
		await directory.cleanup();
		await workspace.cleanup();
	}
});

test("rejects malformed, extra, oversized, and semantically unsafe packets", async () => {
	const directory = await makeDirectory("pi-inspect-context-response-");
	const workspace = await makeDirectory("pi-inspect-context-response-root-");
	try {
		const malformed = await makeWorker(directory.root, `process.stdout.write("{");`);
		await assert.rejects(runWorker({ root: workspace.root, query: "needle" }, { workerPath: malformed }), /malformed|schema/i);

		const extra = await makeWorker(directory.root, packetWorkerSource(packet(), `process.stdout.write("{}" );`));
		await assert.rejects(runWorker({ root: workspace.root, query: "needle" }, { workerPath: extra }), /malformed|extra|schema/i);

		const oversized = await makeWorker(directory.root, `process.stdout.write("x".repeat(${MAX_PACKET_BYTES + 1}));`);
		await assert.rejects(runWorker({ root: workspace.root, query: "needle" }, { workerPath: oversized }), /stdout exceeded/);

		const wrongQuery = await makeWorker(directory.root, `process.stdout.write(${JSON.stringify(JSON.stringify(packet("other")))});`);
		await assert.rejects(runWorker({ root: workspace.root, query: "needle" }, { workerPath: wrongQuery }), /query/i);

		const unsafePath = structuredClone(packet());
		unsafePath.excerpts[0].path = "../outside";
		const unsafePathWorker = await makeWorker(directory.root, packetWorkerSource(unsafePath));
		await assert.rejects(runWorker({ root: workspace.root, query: "needle" }, { workerPath: unsafePathWorker }), /path/i);

		const brokenReference = structuredClone(packet());
		brokenReference.matches[0].path = "src/other.ts";
		const brokenReferenceWorker = await makeWorker(directory.root, packetWorkerSource(brokenReference));
		await assert.rejects(runWorker({ root: workspace.root, query: "needle" }, { workerPath: brokenReferenceWorker }), /match|excerpt/i);

		const brokenCounters = structuredClone(packet());
		brokenCounters.receipt.readFiles = 2;
		const brokenCountersWorker = await makeWorker(directory.root, packetWorkerSource(brokenCounters));
		await assert.rejects(runWorker({ root: workspace.root, query: "needle" }, { workerPath: brokenCountersWorker }), /counter/i);
	} finally {
		await directory.cleanup();
		await workspace.cleanup();
	}
});

test("reports worker failure and bounded stderr", async () => {
	const directory = await makeDirectory("pi-inspect-context-failure-");
	const workspace = await makeDirectory("pi-inspect-context-failure-root-");
	try {
		const worker = await makeWorker(directory.root, `process.stderr.write("worker exploded"); process.exit(7);`);
		await assert.rejects(runWorker({ root: workspace.root, query: "needle" }, { workerPath: worker }), /exit 7.*worker exploded/);
	} finally {
		await directory.cleanup();
		await workspace.cleanup();
	}
});

test("terminates timeout and abort process groups and cleans temporary state", async () => {
	const directory = await makeDirectory("pi-inspect-context-cancel-");
	const workspace = await makeDirectory("pi-inspect-context-cancel-root-");
	const probes: string[] = [];
	try {
		const worker = await makeWorker(directory.root, `
import fs from "node:fs";
const probe = ${JSON.stringify(join(directory.root, "run-root.txt"))};
fs.writeFileSync(probe, process.cwd());
setInterval(() => {}, 1000);
`);
		const timeoutPending = runWorker({ root: workspace.root, query: "needle" }, { workerPath: worker, timeoutMs: 1_000 });
		probes.push(await waitForFile(join(directory.root, "run-root.txt")));
		await assert.rejects(timeoutPending, /timed out after 1000ms/);
		await assert.rejects(lstat(probes[0]), { code: "ENOENT" });

		const controller = new AbortController();
		const abortWorker = await makeWorker(directory.root, `
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(join(directory.root, "abort-root.txt"))}, process.cwd());
setInterval(() => {}, 1000);
`);
		const pending = runWorker({ root: workspace.root, query: "needle" }, { workerPath: abortWorker, signal: controller.signal, timeoutMs: 2_000 });
		const abortRoot = await waitForFile(join(directory.root, "abort-root.txt"));
		controller.abort();
		await assert.rejects(pending, /abort/i);
		await assert.rejects(lstat(abortRoot), { code: "ENOENT" });
	} finally {
		await directory.cleanup();
		await workspace.cleanup();
	}
});

test("kills a descendant in the detached worker process group", async () => {
	const directory = await makeDirectory("pi-inspect-context-descendant-");
	const workspace = await makeDirectory("pi-inspect-context-descendant-root-");
	let descendantPid: number | undefined;
	try {
		const probe = join(directory.root, "descendant.pid");
		const worker = await makeWorker(directory.root, `
import fs from "node:fs";
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(probe)}, String(child.pid));
setInterval(() => {}, 1000);
`);
		const pending = runWorker({ root: workspace.root, query: "needle" }, { workerPath: worker, timeoutMs: 1_000 });
		descendantPid = Number.parseInt(await waitForFile(probe), 10);
		await assert.rejects(pending, /timed out after 1000ms/);
		assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
		await waitForProcessGone(descendantPid);
	} finally {
		if (descendantPid !== undefined) {
			try {
				process.kill(descendantPid, "SIGKILL");
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
			}
		}
		await directory.cleanup();
		await workspace.cleanup();
	}
});

test("rejects a worker executable symlink", async () => {
	const directory = await makeDirectory("pi-inspect-context-worker-link-");
	const workspace = await makeDirectory("pi-inspect-context-worker-link-root-");
	try {
		const realWorker = await makeWorker(directory.root, packetWorkerSource(packet()));
		const linkedWorker = join(directory.root, "linked-worker");
		await (await import("node:fs/promises")).symlink(realWorker, linkedWorker);
		await assert.rejects(runWorker({ root: workspace.root, query: "needle" }, { workerPath: linkedWorker }), /non-symlink/i);
	} finally {
		await directory.cleanup();
		await workspace.cleanup();
	}
});

test("parseWorkerResponse rejects a packet over the compact byte bound", () => {
	const oversized = packet();
	oversized.unknowns = ["x".repeat(MAX_PACKET_BYTES)];
	assert.throws(() => parseWorkerResponse(Buffer.from(JSON.stringify(oversized)), "needle"), /bytes|schema/i);
});
