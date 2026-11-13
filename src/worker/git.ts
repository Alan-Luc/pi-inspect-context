import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { resolveGitExecutable } from '../git-executable.ts';
import { changeDirectory } from './native-files.ts';
import { exclusionReasonForDirectory } from './retrieval.ts';
import { InspectContextError } from '../packet.ts';

let gitExecutable: string | undefined;

const maxGitOutputBytes = 8 * 1024 * 1024;
const maxGitStderrBytes = 64 * 1024;
export type GitOutput = { stdout: Buffer; stderr: Buffer; code: number };
export function safeRepositoryPath(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value) <= 4096 && Buffer.from(value).toString('utf8') === value && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function decode(data: Buffer, label: string): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
  catch { throw new InspectContextError('inventory', `${label} is not valid UTF-8`); }
}
export function parseGitLine(data: Buffer, label: string): string {
  const value = decode(data, label);
  if (!value.endsWith('\n') || value.includes('\0')) throw new InspectContextError('inventory', `${label} output is malformed`);
  const line = value.slice(0, -1);
  if (!line || /[\r\n]/.test(line) || line.trim() !== line) throw new InspectContextError('inventory', `${label} output is malformed`);
  return line;
}
function records(data: Buffer, label: string): string[] {
  if (!data.length) return [];
  if (data[data.length - 1] !== 0) throw new InspectContextError('inventory', `${label} is not NUL terminated`);
  return decode(data.subarray(0, -1), label).split('\0');
}
function excludedDirectory(value: string): boolean {
  return value.endsWith('/') && Buffer.byteLength(value) <= 4096 && safeRepositoryPath(value.slice(0, -1)) && exclusionReasonForDirectory(value.slice(0, -1)) !== undefined;
}
export function parseGitPaths(data: Buffer): string[] {
  const paths: string[] = [];
  for (const path of records(data, 'Git inventory')) {
    if (excludedDirectory(path)) continue;
    if (!safeRepositoryPath(path)) throw new InspectContextError('inventory', `git inventory contains unsafe path ${JSON.stringify(path)}`);
    paths.push(path);
  }
  return paths;
}
export function parseGitMatchPaths(data: Buffer, inventory: Set<string>): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const path of records(data, 'Git match output')) {
    if (!safeRepositoryPath(path) || !inventory.has(path) || seen.has(path)) throw new InspectContextError('inventory', `Git match output contains unsafe, unknown or duplicate path ${JSON.stringify(path)}`);
    seen.add(path);
    paths.push(path);
  }
  return paths;
}
function splitRecord(record: string, count: number): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let index = 1; index < count; index++) {
    const next = record.indexOf(' ', start);
    if (next < 0) return [];
    fields.push(record.slice(start, next));
    start = next + 1;
  }
  fields.push(record.slice(start));
  return fields;
}
function ordinaryStatus(value: string): boolean { return value.length === 2 && value !== '..' && /^[.MTAD]{2}$/.test(value); }
function submoduleStatus(value: string): boolean { return value === 'N...' || /^S[.C][.M][.U]$/.test(value); }
function fileMode(value: string): boolean { return ['000000', '040000', '100644', '100755', '120000', '160000'].includes(value); }
function objectId(value: string): boolean { return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
export function parseGitStatusPaths(data: Buffer, inventory: Set<string>): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const record of records(data, 'Git status output')) {
    let path: string;
    if (record.startsWith('1 ')) {
      const fields = splitRecord(record, 9);
      if (fields.length !== 9 || !ordinaryStatus(fields[1]) || !submoduleStatus(fields[2]) || !fields.slice(3, 6).every(fileMode) || !fields.slice(6, 8).every(objectId) || !fields[8]) throw new InspectContextError('inventory', 'malformed Git ordinary status record');
      path = fields[8];
    } else if (record.startsWith('u ')) {
      const fields = splitRecord(record, 11);
      if (fields.length !== 11 || !['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(fields[1]) || !submoduleStatus(fields[2]) || !fields.slice(3, 7).every(fileMode) || !fields.slice(7, 10).every(objectId) || !fields[10]) throw new InspectContextError('inventory', 'malformed Git unmerged status record');
      path = fields[10];
    } else if (record.startsWith('? ')) path = record.slice(2);
    else throw new InspectContextError('inventory', 'unsupported Git status record');
    if (excludedDirectory(path)) continue;
    if (!safeRepositoryPath(path) || !inventory.has(path) || seen.has(path)) throw new InspectContextError('inventory', `Git status contains unsafe, unknown or duplicate path ${JSON.stringify(path)}`);
    seen.add(path);
    paths.push(path);
  }
  return paths;
}
// Descriptor-relative Git startup belongs in the isolated worker because fchdir changes process-wide state.
export async function runGit(rootDescriptor: number, args: string[], input = '', outputLimit = maxGitOutputBytes, signal?: AbortSignal): Promise<GitOutput> {
  signal?.throwIfAborted();
  const executable = gitExecutable ??= resolveGitExecutable(process.env.PATH || '/usr/bin:/bin');
  signal?.throwIfAborted();
  const previous = openSync('.', constants.O_RDONLY | constants.O_DIRECTORY);
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    changeDirectory(rootDescriptor);
    try {
      child = spawn(executable, ['-c', 'core.fsmonitor=false', ...args], {
        env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } finally {
      try { changeDirectory(previous); }
      catch (error) { child?.kill('SIGKILL'); throw error; }
    }
  } finally { closeSync(previous); }
  if (!child) throw new InspectContextError('inventory', 'Git process did not start');
  const command = child;
  return new Promise<GitOutput>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const fail = (error: Error) => { failure ??= error; command.kill('SIGKILL'); };
    const abort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error('inspection aborted'));
    const finish = (error?: Error, value?: GitOutput) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    command.stdout.on('data', (bytes: Buffer) => {
      stdoutBytes += bytes.length;
      if (stdoutBytes > outputLimit) fail(new InspectContextError('inventory', 'git output exceeded configured limit'));
      else if (!failure) stdout.push(bytes);
    });
    command.stderr.on('data', (bytes: Buffer) => {
      stderrBytes += bytes.length;
      if (stderrBytes > maxGitStderrBytes) fail(new InspectContextError('inventory', 'git stderr exceeded configured limit'));
      else if (!failure) stderr.push(bytes);
    });
    command.on('error', error => finish(error));
    command.stdin.on('error', error => fail(error));
    command.on('close', (code, terminationSignal) => {
      if (failure) finish(failure);
      else if (code === null || terminationSignal !== null) finish(new InspectContextError('inventory', `git terminated with ${terminationSignal ?? 'unknown status'}`));
      else finish(undefined, { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (input.length) command.stdin.end(input);
    else command.stdin.end();
  });
}
