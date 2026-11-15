import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { MAX_PACKET_BYTES, POLICY_VERSION, type ResearchPacketV1 } from "../src/packet.ts";
import { parseWorkerResponse, resolveInspectionRoot } from "../src/adapter.ts";

const execFileAsync = promisify(execFile);

function packet(): ResearchPacketV1 {
	const text = "const needle = 1;";
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
		matches: [{ excerptId: "e1", path: "src/a.ts", startLine: 1, endLine: 1, confidence: "observed", reason: "literal match" }],
		excerpts: [{ id: "e1", path: "src/a.ts", startLine: 1, endLine: 1, kind: "match", text, bodyComplete: false }],
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

test("rejects a symlink cwd before root authorization", async () => {
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

test("parseWorkerResponse rejects unsafe complete bodies for non-definition evidence", () => {
	const base = packet();
	const reference = base.matches[0];
	const complete = {
		...base,
		definitions: [reference],
		matches: [],
		excerpts: [{ ...base.excerpts[0], kind: "definition", text: "function needle() {}", bodyComplete: true }],
	};
	assert.doesNotThrow(() => parseWorkerResponse(Buffer.from(JSON.stringify(complete)), "needle"));
	for (const [kind, category] of [
		["match", "matches"], ["import", "imports"], ["test", "tests"],
		["configuration", "configuration"], ["governing", "governingArtifacts"],
	] as const) {
		const invalid = {
			...complete,
			definitions: [],
			[category]: [reference],
			excerpts: [{ ...complete.excerpts[0], kind }],
		};
		assert.throws(() => parseWorkerResponse(Buffer.from(JSON.stringify(invalid)), "needle"), /complete.*body|body.*complete/i);
	}
});

test("parseWorkerResponse rejects a packet over the compact byte bound", () => {
	const oversized = packet();
	oversized.unknowns = ["x".repeat(MAX_PACKET_BYTES)];
	assert.throws(() => parseWorkerResponse(Buffer.from(JSON.stringify(oversized)), "needle"), /bytes|schema/i);
});
