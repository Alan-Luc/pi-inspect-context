import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Value } from "typebox/value";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
	AUTHORIZATION_MANIFEST_SCHEMA,
	INSPECT_CONTEXT_PARAMETERS,
	MAX_AGGREGATE_READ_BYTES,
	MAX_DISCOVERED_FILES,
	MAX_EXCERPT_LINES,
	MAX_PACKET_BYTES,
	RESEARCH_PACKET_V1_SCHEMA,
	WORKER_PROTOCOL_VERSION,
	WORKER_REQUEST_SCHEMA,
	InspectContextError,
	normalizeQuery,
	packetByteLength,
	type ResearchPacketV1,
	type WorkerRequest,
} from "./packet.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = MAX_PACKET_BYTES;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_GIT_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 2_000;
const KILL_GRACE_MS = 250;
const POSIX_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

export type InspectionTarget = {
	root: string;
	query: string;
};

export type WorkerRunOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
	workerPath?: string;
};

export type InspectContextToolOptions = Omit<WorkerRunOptions, "signal">;

type ProcessResult = {
	stdout: Buffer;
	stderr: Buffer;
	code: number | null;
	signal: NodeJS.Signals | null;
};

type ProcessOptions = {
	cwd: string;
	environment: NodeJS.ProcessEnv;
	input?: string;
	label: string;
	maxStdoutBytes: number;
	maxStderrBytes: number;
	timeoutMs: number;
	signal?: AbortSignal;
};

function fail(code: string, message: string): never {
	throw new InspectContextError(code, message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

function assertSupportedPlatform(): void {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		fail("unsupported_platform", `inspect_context supports macOS and Linux only; unsupported platform: ${process.platform}`);
	}
}

function abortError(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	const error = new Error("inspect_context operation aborted");
	error.name = "AbortError";
	return error;
}

function utf8(value: Buffer, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(value);
	} catch (error) {
		fail("invalid_output", `${label} is not valid UTF-8: ${errorMessage(error)}`);
	}
}

function diagnostic(value: Buffer): string {
	return value.toString("utf8").trim() || "no diagnostics";
}

function rejectSymlinkComponents(pathValue: string, label: string): void {
	const absolute = resolve(pathValue);
	const root = parse(absolute).root;
	let current = root;
	for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
		current = join(current, component);
		let metadata;
		try {
			metadata = lstatSync(current);
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				fail("invalid_root", `${label} component does not exist: ${current}`);
			}
			throw error;
		}
		if (metadata.isSymbolicLink()) fail("invalid_root", `${label} contains a symlink component: ${current}`);
	}
}

function validateDirectory(pathValue: unknown, label: string): string {
	if (typeof pathValue !== "string" || pathValue.length === 0) fail("invalid_root", `${label} must be a path string`);
	const absolute = resolve(pathValue);
	rejectSymlinkComponents(absolute, label);
	let metadata;
	try {
		metadata = lstatSync(absolute);
	} catch (error) {
		fail("invalid_root", `${label} could not be inspected: ${errorMessage(error)}`);
	}
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("invalid_root", `${label} must be a real directory: ${pathValue}`);
	try {
		return realpathSync(absolute);
	} catch (error) {
		fail("invalid_root", `${label} could not be canonicalized: ${errorMessage(error)}`);
	}
}

function contained(root: string, child: string): boolean {
	const value = relative(root, child);
	return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function nearestGitMarker(cwd: string): string | undefined {
	let current = cwd;
	for (;;) {
		const marker = join(current, ".git");
		try {
			const metadata = lstatSync(marker);
			if (metadata.isSymbolicLink()) fail("invalid_root", `Git marker is a symlink: ${marker}`);
			if (!metadata.isDirectory() && !metadata.isFile()) fail("invalid_root", `Git marker is not a file or directory: ${marker}`);
			return current;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		const parent = parse(current).root === current ? current : resolve(current, "..");
		if (parent === current) return undefined;
		current = parent;
	}
}

function gitEnvironment(): NodeJS.ProcessEnv {
	return {
		PATH: POSIX_PATH,
		HOME: "/nonexistent",
		LANG: "C",
		LC_ALL: "C",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_PAGER: "cat",
		GIT_OPTIONAL_LOCKS: "0",
	};
}

async function signalProcessGroup(child: ChildProcessWithoutNullStreams, force: boolean): Promise<void> {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
	} catch (error) {
		if (errorCode(error) !== "ESRCH") throw error;
	}
}

async function cleanupProcessGroup(child: ChildProcessWithoutNullStreams): Promise<void> {
	let cleanupError: unknown;
	try {
		await signalProcessGroup(child, false);
	} catch (error) {
		cleanupError = error;
	}
	await new Promise<void>((resolveCleanup) => setTimeout(resolveCleanup, KILL_GRACE_MS));
	try {
		await signalProcessGroup(child, true);
	} catch (error) {
		cleanupError ??= error;
	}
	if (cleanupError !== undefined) throw cleanupError;
}

async function runBoundedProcess(executable: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
	options.signal?.throwIfAborted();
	if (options.input !== undefined && Buffer.byteLength(options.input, "utf8") > MAX_REQUEST_BYTES) {
		fail("request_limit", `${options.label} request exceeds ${MAX_REQUEST_BYTES} bytes`);
	}
	return await new Promise<ProcessResult>((resolveProcess, rejectProcess) => {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(executable, args, {
			cwd: options.cwd,
			detached: true,
			env: options.environment,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			});
		} catch (error) {
			rejectProcess(new Error(`${options.label} could not start: ${errorMessage(error)}`));
			return;
		}

		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let closeSeen = false;
		let closeCode: number | null = null;
		let closeSignal: NodeJS.Signals | null = null;
		let inputDone = options.input === undefined;
		let settled = false;
		let cleanupDone = true;
		let cleanupPromise: Promise<void> | undefined;
		let terminalError: Error | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const finish = (): void => {
			if (settled || !closeSeen || !inputDone || !cleanupDone) return;
			settled = true;
			if (timeout !== undefined) clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abortHandler);
			if (terminalError !== undefined) {
				rejectProcess(terminalError);
				return;
			}
			resolveProcess({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: closeCode, signal: closeSignal });
		};

		const terminate = (error: Error): void => {
			if (settled) return;
			terminalError ??= error;
			inputDone = true;
			if (cleanupPromise === undefined) {
				cleanupDone = false;
				cleanupPromise = cleanupProcessGroup(child)
					.catch((cleanupError: unknown) => {
						terminalError = new Error(`${terminalError?.message ?? error.message}; ${options.label} process-group cleanup failed: ${errorMessage(cleanupError)}`);
					})
					.finally(() => {
						cleanupDone = true;
						finish();
					});
			}
			if (!child.stdin.destroyed) child.stdin.destroy();
			finish();
		};

		const abortHandler = (): void => {
			if (options.signal !== undefined) terminate(abortError(options.signal));
		};

		child.stdout.on("data", (chunk: Buffer) => {
			if (terminalError !== undefined) return;
			stdoutBytes += chunk.length;
			if (stdoutBytes > options.maxStdoutBytes) {
				terminate(new Error(`${options.label} stdout exceeded ${options.maxStdoutBytes} bytes`));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (terminalError !== undefined) return;
			stderrBytes += chunk.length;
			if (stderrBytes > options.maxStderrBytes) {
				terminate(new Error(`${options.label} stderr exceeded ${options.maxStderrBytes} bytes`));
				return;
			}
			stderr.push(chunk);
		});
		child.stdin.once("error", (error: Error) => terminate(new Error(`${options.label} stdin failed: ${error.message}`)));
		child.once("error", (error: Error) => {
			terminalError ??= new Error(`${options.label} could not start: ${error.message}`);
			inputDone = true;
			closeSeen = true;
			finish();
		});
		child.once("close", (code: number | null, signalValue: NodeJS.Signals | null) => {
			closeSeen = true;
			closeCode = code;
			closeSignal = signalValue;
			finish();
		});
		if (options.signal !== undefined) {
			options.signal.addEventListener("abort", abortHandler, { once: true });
			if (options.signal.aborted) abortHandler();
		}
		timeout = setTimeout(() => terminate(new Error(`${options.label} timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
		try {
			if (options.input === undefined) {
				child.stdin.end(() => {
					inputDone = true;
					finish();
				});
			} else {
				child.stdin.end(options.input, () => {
					inputDone = true;
					finish();
				});
			}
		} catch (error) {
			terminate(new Error(`${options.label} stdin write failed: ${errorMessage(error)}`));
		}
	});
}

async function runGit(cwd: string, signal?: AbortSignal): Promise<string> {
	const result = await runBoundedProcess("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
		cwd,
		environment: gitEnvironment(),
		label: "Git root resolution",
		maxStdoutBytes: MAX_GIT_BYTES,
		maxStderrBytes: MAX_STDERR_BYTES,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		signal,
	});
	if (result.signal !== null || result.code !== 0) {
		const status = result.signal === null ? `exit ${result.code ?? "unknown"}` : `signal ${result.signal}`;
		fail("git_resolution", `Git root resolution failed with ${status}: ${diagnostic(result.stderr)}`);
	}
	return utf8(result.stdout, "Git root resolution output");
}

function parseOneLine(value: string, label: string): string {
	if (!value.endsWith("\n")) fail("git_resolution", `${label} did not end with a line terminator`);
	const line = value.slice(0, -1);
	if (line.length === 0 || line.includes("\n") || line.includes("\r") || line.includes("\0")) {
		fail("git_resolution", `${label} was not exactly one non-empty line`);
	}
	return line;
}

export async function resolveInspectionRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	assertSupportedPlatform();
	signal?.throwIfAborted();
	const verifiedCwd = validateDirectory(cwd, "ctx.cwd");
	signal?.throwIfAborted();
	if (nearestGitMarker(verifiedCwd) === undefined) return verifiedCwd;
	const rootText = parseOneLine(await runGit(verifiedCwd, signal), "Git root");
	const root = validateDirectory(rootText, "Git repository root");
	if (!contained(root, verifiedCwd)) fail("invalid_root", `Git repository root does not contain ctx.cwd: ${root}`);
	return root;
}

function packagedWorkerPath(): string {
	assertSupportedPlatform();
	return validateExecutable(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "inspect-context"), "packaged inspect_context worker");
}

function validateExecutable(pathValue: string, label: string): string {
	const path = resolve(pathValue);
	let metadata;
	try {
		metadata = lstatSync(path);
	} catch (error) {
		fail("worker_unavailable", `${label} is unavailable at ${path}: ${errorMessage(error)}`);
	}
	if (!metadata.isFile() || metadata.isSymbolicLink()) fail("worker_unavailable", `${label} must be a regular non-symlink file: ${path}`);
	if ((metadata.mode & 0o111) === 0) fail("worker_unavailable", `${label} is not executable: ${path}`);
	return path;
}

async function createRunRoot(): Promise<string> {
	const temporary = await mkdtemp(join(tmpdir(), "pi-inspect-context-"));
	try {
		await chmod(temporary, 0o700);
		const metadata = await lstat(temporary);
		if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
			throw new Error("temporary run directory must be a mode-0700 real directory");
		}
		const canonical = await realpath(temporary);
		await mkdir(join(canonical, "home"), { mode: 0o700 });
		await chmod(join(canonical, "home"), 0o700);
		return canonical;
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw new Error(`temporary inspect_context directory could not be prepared: ${errorMessage(error)}`);
	}
}

function workerEnvironment(runRoot: string, manifestPath: string): NodeJS.ProcessEnv {
	return {
		PATH: POSIX_PATH,
		HOME: join(runRoot, "home"),
		LANG: "C",
		LC_ALL: "C",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_PAGER: "cat",
		GIT_OPTIONAL_LOCKS: "0",
		INSPECT_CONTEXT_MANIFEST: manifestPath,
	};
}

function schemaPacket(value: unknown): value is ResearchPacketV1 {
	return Value.Check(RESEARCH_PACKET_V1_SCHEMA, value);
}

function safeRelativePosixPath(value: string, label: string): void {
	if (
		value.length === 0 ||
		value === "." ||
		value === ".." ||
		value.includes("\\") ||
		value.includes("\0") ||
		isAbsolute(value) ||
		/^[A-Za-z]:\//.test(value) ||
		value.startsWith("../") ||
		posix.normalize(value) !== value ||
		value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
	) {
		fail("invalid_response", `${label} is not a safe relative POSIX path: ${JSON.stringify(value)}`);
	}
}

function validatePacketSemantics(packet: ResearchPacketV1, expectedQuery: string): void {
	if (packet.target.root !== ".") fail("invalid_response", "worker packet target.root must be '.'");
	if (packet.target.query !== expectedQuery) fail("invalid_response", "worker packet query does not match the normalized request query");
	if (packet.snapshot.validated !== true || packet.receipt.snapshotId !== packet.snapshot.id) {
		fail("invalid_response", "worker packet snapshot and receipt identities do not match");
	}
	const excerpts = new Map<string, ResearchPacketV1["excerpts"][number]>();
	for (const [index, excerpt] of packet.excerpts.entries()) {
		safeRelativePosixPath(excerpt.path, `excerpts[${index}].path`);
		if (excerpt.endLine < excerpt.startLine || excerpt.endLine - excerpt.startLine + 1 > MAX_EXCERPT_LINES || excerpt.text.length === 0) {
			fail("invalid_response", `excerpts[${index}] has an invalid line range or empty text`);
		}
		if (excerpts.has(excerpt.id)) fail("invalid_response", `duplicate excerpt id: ${excerpt.id}`);
		excerpts.set(excerpt.id, excerpt);
	}

	const categories = [
		["governingArtifacts", "governing"],
		["definitions", "definition"],
		["callers", "caller"],
		["imports", "import"],
		["tests", "test"],
		["configuration", "configuration"],
		["matches", "match"],
	] as const;
	for (const [categoryName, expectedKind] of categories) {
		const seen = new Set<string>();
		for (const [index, reference] of packet[categoryName].entries()) {
			safeRelativePosixPath(reference.path, `${categoryName}[${index}].path`);
			const excerpt = excerpts.get(reference.excerptId);
			if (excerpt === undefined || excerpt.path !== reference.path || excerpt.startLine !== reference.startLine || excerpt.endLine !== reference.endLine) {
				fail("invalid_response", `${categoryName}[${index}] does not match its excerpt`);
			}
			if (excerpt.kind !== expectedKind) fail("invalid_response", `${categoryName}[${index}] has the wrong excerpt kind`);
			if (seen.has(reference.excerptId)) fail("invalid_response", `${categoryName} contains a duplicate excerpt reference`);
			seen.add(reference.excerptId);
		}
	}
	for (const [index, omission] of packet.omissions.entries()) {
		for (const [exampleIndex, example] of (omission.examples ?? []).entries()) {
			safeRelativePosixPath(example, `omissions[${index}].examples[${exampleIndex}]`);
		}
	}
	const omissionCount = packet.omissions.reduce((total, omission) => total + omission.count, 0);
	if (
		packet.receipt.discoveredFiles > MAX_DISCOVERED_FILES ||
		packet.receipt.readFiles > packet.receipt.discoveredFiles ||
		packet.receipt.bytesRead > MAX_AGGREGATE_READ_BYTES ||
		packet.receipt.excerptCount !== packet.excerpts.length ||
		packet.receipt.omissionCount !== omissionCount
	) {
		fail("invalid_response", "worker packet receipt counters do not match the packet or protocol bounds");
	}
	if (packetByteLength(packet) > MAX_PACKET_BYTES) fail("invalid_response", `worker packet exceeds ${MAX_PACKET_BYTES} bytes`);
}

export function parseWorkerResponse(output: Buffer, expectedQuery: string): ResearchPacketV1 {
	if (output.length === 0) fail("invalid_response", "worker closed without a response");
	const text = utf8(output, "worker stdout");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		fail("invalid_response", `worker returned malformed or extra JSON: ${errorMessage(error)}`);
	}
	if (!schemaPacket(value)) fail("invalid_response", "worker response failed the closed Research Packet V1 schema");
	validatePacketSemantics(value, expectedQuery);
	return value;
}

function workerFailure(result: ProcessResult): never {
	const status = result.signal === null ? `exit ${result.code ?? "unknown"}` : `signal ${result.signal}`;
	fail("worker_failed", `inspect_context worker failed with ${status}: ${diagnostic(result.stderr)}`);
}

export async function runWorker(target: InspectionTarget, options: WorkerRunOptions = {}): Promise<ResearchPacketV1> {
	const query = normalizeQuery({ query: target.query });
	assertSupportedPlatform();
	options.signal?.throwIfAborted();
	const root = validateDirectory(target.root, "inspection root");
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) fail("invalid_options", "worker timeout must be a positive integer");
	const workerPath = options.workerPath === undefined ? packagedWorkerPath() : validateExecutable(options.workerPath, "inspect_context worker");
	const runRoot = await createRunRoot();
	let operationError: unknown;
	try {
		const manifestPath = join(runRoot, "inspect-context-manifest.json");
		const manifest = { version: WORKER_PROTOCOL_VERSION, root } as const;
		if (!Value.Check(AUTHORIZATION_MANIFEST_SCHEMA, manifest)) fail("authorization", "generated authorization manifest failed its schema");
		await writeFile(manifestPath, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
		await chmod(manifestPath, 0o600);
		const manifestMetadata = await lstat(manifestPath);
		if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || (manifestMetadata.mode & 0o077) !== 0) {
			fail("authorization", "authorization manifest must be a mode-0600 regular file");
		}
		const request: WorkerRequest = { version: WORKER_PROTOCOL_VERSION, root, query };
		if (!Value.Check(WORKER_REQUEST_SCHEMA, request)) fail("request_limit", "generated worker request failed its schema");
		const input = JSON.stringify(request);
		if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) fail("request_limit", `worker request exceeds ${MAX_REQUEST_BYTES} bytes`);
		const result = await runBoundedProcess(workerPath, [], {
			cwd: runRoot,
			environment: workerEnvironment(runRoot, manifestPath),
			input,
			label: "inspect_context worker",
			maxStdoutBytes: MAX_OUTPUT_BYTES,
			maxStderrBytes: MAX_STDERR_BYTES,
			timeoutMs,
			signal: options.signal,
		});
		if (result.code !== 0 || result.signal !== null) workerFailure(result);
		return parseWorkerResponse(result.stdout, query);
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		try {
			await rm(runRoot, { recursive: true, force: true });
		} catch (cleanupError) {
			const message = `temporary inspect_context state cleanup failed: ${errorMessage(cleanupError)}`;
			if (operationError === undefined) throw new Error(message);
			throw new Error(`${errorMessage(operationError)}; ${message}`);
		}
	}
}

export async function inspectContext(
	ctx: Pick<ExtensionToolContext, "cwd">,
	params: unknown,
	options: WorkerRunOptions = {},
): Promise<ResearchPacketV1> {
	const query = normalizeQuery(params);
	const root = await resolveInspectionRoot(ctx.cwd, options.signal);
	return runWorker({ root, query }, options);
}

export function createInspectContextTool(options: InspectContextToolOptions = {}) {
	return {
		name: "inspect_context",
		label: "Inspect context",
		description: "Find bounded repository context for one literal query. Results are read-only, lexical discovery aids: zero results are not proof of absence, and weak or materially omitted evidence requires another literal query or ordinary repository investigation.",
		parameters: INSPECT_CONTEXT_PARAMETERS,
		outputSchema: RESEARCH_PACKET_V1_SCHEMA,
		executionMode: "sequential" as const,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		execute: async (
			_toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionToolContext,
		) => {
			const packet = await inspectContext(ctx, params, { ...options, signal });
			return {
				content: [{ type: "text" as const, text: JSON.stringify(packet) }],
				details: packet,
				structuredContent: packet,
			};
		},
	};
}
