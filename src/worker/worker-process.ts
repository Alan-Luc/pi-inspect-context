import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Value } from 'typebox/value';
import { InspectionEngine } from './engine.ts';
import { decodeWorkerJSON, MAX_WORKER_INPUT_BYTES } from './worker-input.ts';
import { AUTHORIZATION_MANIFEST_SCHEMA, MAX_PACKET_BYTES, InspectContextError, type AuthorizationManifest } from '../packet.ts';

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function decodeRequest(bytes: Buffer): unknown {
  try { return decodeWorkerJSON(bytes); }
  catch (error) { throw new InspectContextError('protocol', message(error)); }
}
function loadManifest(): AuthorizationManifest {
  try {
    const path = process.env.INSPECT_CONTEXT_MANIFEST;
    if (!path || !isAbsolute(path) || path.includes('\0') || resolve(path) !== path) throw new Error('manifest path must be a clean absolute path');
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077n) !== 0n) throw new Error('manifest must be a regular non-symlink file with mode 0600 or stricter');
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || (opened.mode & 0o077n) !== 0n) throw new Error('manifest changed before authorization');
      const buffer = Buffer.alloc(MAX_WORKER_INPUT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(descriptor, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > MAX_WORKER_INPUT_BYTES) throw new Error('manifest exceeds its byte bound');
      const after = lstatSync(path, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || (after.mode & 0o077n) !== 0n || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) throw new Error('manifest changed during authorization');
      bytes = buffer.subarray(0, length);
    } finally { closeSync(descriptor); }
    const manifest = decodeWorkerJSON(bytes);
    if (!Value.Check(AUTHORIZATION_MANIFEST_SCHEMA, manifest)) throw new Error('manifest failed its closed schema');
    if (!isAbsolute(manifest.root) || manifest.root.includes('\0') || resolve(manifest.root) !== manifest.root || realpathSync(manifest.root) !== manifest.root) throw new Error('manifest root must be clean, canonical and symlink-free');
    return manifest;
  } catch (error) { throw new InspectContextError('authorization', message(error)); }
}
async function* requests(session: boolean): AsyncGenerator<Buffer> {
  let pending = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) throw new InspectContextError('protocol', 'worker input must contain bytes');
    pending = Buffer.concat([pending, chunk]);
    if (session) {
      let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        if (end > MAX_WORKER_INPUT_BYTES) throw new InspectContextError('protocol', 'request exceeds its byte bound');
        const frame = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        yield frame;
      }
    }
    if (pending.length > MAX_WORKER_INPUT_BYTES) throw new InspectContextError('protocol', 'request exceeds its byte bound');
  }
  if (!session || pending.length) yield pending;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const session = args.length === 1 && args[0] === '--session';
  if (args.length && !session) throw new InspectContextError('protocol', 'unsupported worker arguments');
  loadManifest();
  const engine = new InspectionEngine();
  const controller = new AbortController();
  const outputError = (error: Error) => controller.abort(error);
  const terminate = () => {
    const error = new Error('worker terminated');
    controller.abort(error);
    process.stdin.destroy(error);
  };
  process.stdout.on('error', outputError);
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  try {
    for await (const bytes of requests(session)) {
      const manifest = loadManifest();
      const packet = await engine.inspect(decodeRequest(bytes), manifest, controller.signal);
      const encoded = JSON.stringify(packet);
      if (Buffer.byteLength(encoded) > MAX_PACKET_BYTES) throw new InspectContextError('packet_limit', 'packet exceeds its byte bound');
      await new Promise<void>((resolveWrite, rejectWrite) => {
        process.stdout.write(encoded + (session ? '\n' : ''), error => error ? rejectWrite(error) : resolveWrite());
      });
    }
  } finally {
    await engine.close();
    process.stdout.off('error', outputError);
    process.off('SIGTERM', terminate);
    process.off('SIGINT', terminate);
  }
}
try { await main(); }
catch (error) {
  process.stderr.write(`inspect_context: ${message(error)}\n`);
  process.exitCode = 1;
}
