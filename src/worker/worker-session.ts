import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Value } from 'typebox/value';
import { parseWorkerResponse } from '../adapter.ts';
import { MAX_PACKET_BYTES, WORKER_REQUEST_SCHEMA, normalizeQuery, type ResearchPacketV1, type WorkerRequest } from '../packet.ts';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const KILL_GRACE_MS = 250;

type PendingReply = {
  query: string;
  resolve: (packet: ResearchPacketV1) => void;
  reject: (error: Error) => void;
};
type SessionProcess = {
  child: ChildProcessWithoutNullStreams;
  root: string;
  directory: string;
  stdout: Buffer;
  stderr: Buffer;
  pending?: PendingReply;
  error?: Error;
  cleanup?: Promise<void>;
  closed: Promise<void>;
};

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
}
function workerRuntime(): string {
  if (!process.versions.bun) return process.execPath;
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (!isAbsolute(directory)) continue;
    try {
      const executable = realpathSync(join(directory, 'node'));
      accessSync(executable, constants.X_OK);
      if (lstatSync(executable).isFile()) return executable;
    } catch { continue; }
  }
  throw new Error('inspect_context requires Node.js 22.19 or newer on PATH for its worker');
}
function canonicalRoot(root: string): string {
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root || !lstatSync(root).isDirectory()) {
    throw new Error('inspection root must be a canonical real directory');
  }
  return root;
}

export class PersistentWorkerSession {
  private readonly workerPath: string;
  private readonly timeoutMs: number;
  private process?: SessionProcess;
  private busy = false;
  private closed = false;
  private cleanupFailure?: Error;

  constructor(options: { workerPath: string; timeoutMs?: number }) {
    this.workerPath = resolve(options.workerPath);
    this.timeoutMs = options.timeoutMs ?? 2000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('worker timeout must be a positive integer');
  }

  get pid(): number | undefined { return this.process?.child.pid; }

  private stop(state: SessionProcess, error: Error): Promise<void> {
    if (state.cleanup) return state.cleanup;
    state.error = error;
    state.cleanup = (async () => {
      let failure: Error | undefined;
      try { signalGroup(state.child, 'SIGTERM'); } catch (error) { failure = asError(error); }
      state.child.stdin.destroy();
      await new Promise<void>(done => setTimeout(done, KILL_GRACE_MS));
      try { signalGroup(state.child, 'SIGKILL'); } catch (error) { failure ??= asError(error); }
      await state.closed;
      try { rmSync(state.directory, { recursive: true, force: true }); } catch (error) { failure ??= asError(error); }
      if (this.process === state) this.process = undefined;
      const pending = state.pending;
      state.pending = undefined;
      const terminal = failure ? new Error(`${error.message}; process cleanup failed: ${failure.message}`) : error;
      pending?.reject(terminal);
      if (failure) {
        this.cleanupFailure = terminal;
        throw terminal;
      }
    })();
    // Retain idle cleanup failures for the next run or close caller.
    void state.cleanup.catch(() => {});
    return state.cleanup;
  }

  private poison(state: SessionProcess, error: Error): void { void this.stop(state, error); }

  private start(root: string): SessionProcess {
    const metadata = lstatSync(this.workerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('worker script must be a regular non-symlink file');
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pi-inspect-session-')));
    let child: ChildProcessWithoutNullStreams;
    try {
      chmodSync(directory, 0o700);
      mkdirSync(join(directory, 'home'), { mode: 0o700 });
      const manifestPath = join(directory, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify({ version: 1, root }), { mode: 0o600 });
      const args = this.workerPath.endsWith('.ts') ? ['--experimental-strip-types', this.workerPath, '--session'] : [this.workerPath, '--session'];
      child = spawn(workerRuntime(), args, {
        cwd: directory, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: join(directory, 'home'), LANG: 'C', LC_ALL: 'C',
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', INSPECT_CONTEXT_MANIFEST: manifestPath,
        },
      });
    } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
    const closed = new Promise<void>(done => child.once('close', () => done()));
    const state: SessionProcess = { child, root, directory, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), closed };
    this.process = state;
    child.stdout.on('data', (chunk: Buffer) => {
      if (state.error) return;
      if (!state.pending) { this.poison(state, new Error('worker sent unsolicited stdout')); return; }
      if (state.stdout.length + chunk.length > MAX_PACKET_BYTES + 1) {
        this.poison(state, new Error('worker stdout exceeded packet byte bound')); return;
      }
      state.stdout = Buffer.concat([state.stdout, chunk]);
      const newline = state.stdout.indexOf(10);
      if (newline === -1) return;
      if (newline !== state.stdout.length - 1) { this.poison(state, new Error('worker sent extra reply bytes')); return; }
      try {
        const packet = parseWorkerResponse(state.stdout.subarray(0, newline), state.pending.query);
        const pending = state.pending;
        state.pending = undefined;
        state.stdout = Buffer.alloc(0);
        pending.resolve(packet);
      } catch (error) { this.poison(state, asError(error)); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (state.error) return;
      if (state.stderr.length + chunk.length > MAX_STDERR_BYTES) {
        this.poison(state, new Error('worker stderr exceeded byte bound')); return;
      }
      state.stderr = Buffer.concat([state.stderr, chunk]);
    });
    child.stdin.on('error', error => this.poison(state, new Error(`worker stdin failed: ${error.message}`)));
    child.once('error', error => this.poison(state, new Error(`worker could not start: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (!state.error) this.poison(state, new Error(`worker closed with ${signal ?? `exit ${code}`}: ${state.stderr.toString('utf8').trim()}`));
    });
    return state;
  }

  async run(target: { root: string; query: string; cwd?: string }, options: { signal?: AbortSignal } = {}): Promise<ResearchPacketV1> {
    const query = normalizeQuery({ query: target.query });
    options.signal?.throwIfAborted();
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.closed) throw new Error('worker session is closed');
    if (this.busy) throw new Error('worker session already has an active request');
    this.busy = true;
    try {
      const root = canonicalRoot(target.root);
      const request: WorkerRequest = { version: 1, root, query, ...(target.cwd === undefined ? {} : { cwd: target.cwd }) };
      if (!Value.Check(WORKER_REQUEST_SCHEMA, request)) throw new Error('worker request failed its schema');
      const encoded = JSON.stringify(request);
      if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw new Error('worker request exceeds byte bound');
      if (this.process?.cleanup) await this.process.cleanup;
      if (this.process && this.process.root !== root) await this.stop(this.process, new Error('inspection root changed'));
      options.signal?.throwIfAborted();
      if (this.closed) throw new Error('worker session is closed');
      const state = this.process ?? this.start(root);
      const abort = () => this.poison(state, asError(options.signal?.reason ?? new Error('worker request aborted')));
      const timeout = setTimeout(() => this.poison(state, new Error(`worker timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        return await new Promise<ResearchPacketV1>((resolveReply, reject) => {
          state.pending = { query, resolve: resolveReply, reject };
          state.child.stdin.write(encoded + '\n', error => { if (error) this.poison(state, error); });
          if (options.signal?.aborted) abort();
        });
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
      }
    } finally { this.busy = false; }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.process) await this.stop(this.process, new Error('worker session closed'));
  }
}
