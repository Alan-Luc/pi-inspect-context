import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PersistentWorkerSession } from '../../src/worker/worker-session.ts';
import { MAX_PACKET_BYTES, POLICY_VERSION } from '../../src/packet.ts';

const worker = fileURLToPath(new URL('../../src/worker/worker-process.ts', import.meta.url));
function validPacket(query = 'needle') {
  return {
    version: 1, target: { query, root: '.', repository: 'filesystem' }, snapshot: { id: 's', validated: true },
    governingArtifacts: [], definitions: [], callers: [], imports: [], tests: [], configuration: [], matches: [], excerpts: [],
    unknowns: [], omissions: [], receipt: { packetId: 'p', schemaVersion: 1, policyVersion: POLICY_VERSION, snapshotId: 's',
      durationMs: 0, discoveredFiles: 0, readFiles: 0, bytesRead: 0, excerptCount: 0, omissionCount: 0 },
  };
}
function packetWithEvidence(query = 'needle') {
  const packet = validPacket(query);
  const text = 'const needle = 1;';
  packet.matches.push({ excerptId: 'e1', path: 'src/a.ts', startLine: 1, endLine: 1, confidence: 'observed', reason: 'literal match' });
  packet.excerpts.push({ id: 'e1', path: 'src/a.ts', startLine: 1, endLine: 1, kind: 'match', text, bodyComplete: false });
  packet.receipt.discoveredFiles = 1;
  packet.receipt.readFiles = 1;
  packet.receipt.bytesRead = Buffer.byteLength(text);
  packet.receipt.excerptCount = 1;
  return packet;
}
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'expected process effect before deadline');
    await new Promise(done => setTimeout(done, 10));
  }
}
function processGone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}
function script(f, source) {
  const path = join(f.directory, 'script.mjs');
  writeFileSync(path, source);
  return path;
}

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'inspect-context-session-')));
  const root = join(directory, 'root');
  mkdirSync(root);
  writeFileSync(join(root, 'needle.txt'), 'needle appears here\n');
  return { directory, root };
}

test('lazily reuses one real CLI process, serves fresh queries, changes root, and closes idempotently', async () => {
  const f = fixture();
  const other = join(f.directory, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'second.txt'), 'second needle\n');
  const session = new PersistentWorkerSession({ workerPath: worker });
  try {
    assert.equal(session.pid, undefined);
    const first = await session.run({ root: f.root, query: 'needle' });
    const pid = session.pid;
    assert.equal(first.target.query, 'needle');
    assert.ok(pid);
    writeFileSync(join(f.root, 'fresh.txt'), 'needle fresh evidence\n');
    const next = await session.run({ root: f.root, query: 'fresh' });
    assert.equal(session.pid, pid);
    assert.ok(next.excerpts.some(item => item.path === 'fresh.txt'));
    const changed = await session.run({ root: other, query: 'second' });
    assert.notEqual(session.pid, pid);
    assert.ok(changed.excerpts.some(item => item.path === 'second.txt'));
  } finally {
    await session.close();
    await session.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('rejects closed sessions before allocating resources', async () => {
  const session = new PersistentWorkerSession({ workerPath: worker });
  await session.close();
  await assert.rejects(session.run({ root: '/', query: 'needle' }), /closed/);
  assert.equal(session.pid, undefined);
});

test('forwards only the authorized root-relative cwd with a private manifest', async () => {
  const f = fixture();
  const nested = join(f.root, 'src', 'nested');
  mkdirSync(nested, { recursive: true });
  const probe = join(f.directory, 'request.json');
  const response = packetWithEvidence();
  const session = new PersistentWorkerSession({ workerPath: script(f, `
    import fs from 'node:fs';
    process.stdin.once('data', chunk => {
      const request = JSON.parse(chunk.toString('utf8').trim());
      const manifest = JSON.parse(fs.readFileSync(process.env.INSPECT_CONTEXT_MANIFEST, 'utf8'));
      fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({request, manifest,
        mode: fs.statSync(process.env.INSPECT_CONTEXT_MANIFEST).mode & 0o777}));
      const packet = ${JSON.stringify(response)};
      packet.target.query = request.query;
      process.stdout.write(JSON.stringify(packet) + '\\n');
    });
  `) });
  try {
    const packet = await session.run({ root: f.root, cwd: 'src/nested', query: 'e\u0301' });
    const details = JSON.parse(readFileSync(probe, 'utf8'));
    assert.equal(packet.target.query, 'é');
    assert.deepEqual(details.request, { version: 1, root: f.root, query: 'é', cwd: 'src/nested' });
    assert.deepEqual(details.manifest, { version: 1, root: f.root });
    assert.equal(details.mode, 0o600);
  } finally {
    await session.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

for (const [name, source, expected] of [
  ['malformed', `process.stdout.write('{\\n');`, /malformed/],
  ['extra replies', `process.stdout.write(${JSON.stringify(JSON.stringify(validPacket()) + '\n{}\n')});`, /extra|unsolicited/],
  ['stdout bound', `process.stdout.write('x'.repeat(${MAX_PACKET_BYTES + 2}));`, /stdout.*bound/],
  ['stderr bound', `process.stderr.write('x'.repeat(65537));`, /stderr.*bound/],
  ['query mismatch', `process.stdout.write(${JSON.stringify(JSON.stringify(validPacket('other')) + '\n')});`, /query/],
  ['unsafe path', `const packet=${JSON.stringify(packetWithEvidence())};packet.excerpts[0].path='../outside';process.stdout.write(JSON.stringify(packet)+'\\n');`, /path/],
  ['broken reference', `const packet=${JSON.stringify(packetWithEvidence())};packet.matches[0].path='src/other.ts';process.stdout.write(JSON.stringify(packet)+'\\n');`, /match|excerpt/],
  ['invalid counters', `const packet=${JSON.stringify(packetWithEvidence())};packet.receipt.readFiles=2;process.stdout.write(JSON.stringify(packet)+'\\n');`, /counter/],
  ['worker crash', `process.stderr.write('deliberate crash');process.exit(7);`, /exit 7.*deliberate crash/],
]) {
  test(`rejects ${name}, kills the process and removes private state`, async () => {
    const f = fixture();
    const probe = join(f.directory, 'probe.json');
    const session = new PersistentWorkerSession({ workerPath: script(f, `
      import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ pid: process.pid, directory: process.cwd(),
        mode: fs.statSync(process.env.INSPECT_CONTEXT_MANIFEST).mode & 0o777,
        secret: process.env.INSPECT_SESSION_SECRET ?? null }));
      process.stdin.once('data', () => { ${source} });
    `) });
    process.env.INSPECT_SESSION_SECRET = 'must not cross';
    try {
      await assert.rejects(session.run({ root: f.root, query: 'needle' }), expected);
      const details = JSON.parse(readFileSync(probe, 'utf8'));
      assert.equal(details.mode, 0o600);
      assert.equal(details.secret, null);
      assert.equal(existsSync(details.directory), false);
      await waitFor(() => processGone(details.pid));
      assert.equal(session.pid, undefined);
    } finally {
      delete process.env.INSPECT_SESSION_SECRET;
      await session.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
}

for (const ending of ['timeout', 'abort', 'close']) {
  test(`${ending} rejects an active call, kills descendants and removes private state`, async () => {
    const f = fixture();
    const probe = join(f.directory, 'probe.json');
    const session = new PersistentWorkerSession({ timeoutMs: 750, workerPath: script(f, `
      import fs from 'node:fs';
      import {spawn} from 'node:child_process';
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({pid:process.pid, descendant:child.pid,directory:process.cwd()}));
      setInterval(()=>{},1000);
    `) });
    const controller = new AbortController();
    try {
      const pending = session.run({ root: f.root, query: 'needle' }, { signal: controller.signal });
      const rejected = assert.rejects(pending, ending === 'timeout' ? /timed out after 1500ms/ : ending === 'close' ? /closed/ : /cancel active/);
      await waitFor(() => existsSync(probe));
      await assert.rejects(session.run({ root: f.root, query: 'needle' }), /active request/);
      const details = JSON.parse(readFileSync(probe, 'utf8'));
      if (ending === 'abort') controller.abort(new Error('cancel active'));
      if (ending === 'close') await session.close();
      await rejected;
      await waitFor(() => processGone(details.pid) && processGone(details.descendant));
      assert.equal(existsSync(details.directory), false);
    } finally { await session.close(); rmSync(f.directory, { recursive: true, force: true }); }
  });
}

test('rejects a worker executable symlink before starting a process', async () => {
  const f = fixture();
  const link = join(f.directory, 'worker-link.mjs');
  const session = new PersistentWorkerSession({ workerPath: link });
  try {
    const realWorker = script(f, `process.stdin.once('data',()=>process.stdout.write(${JSON.stringify(JSON.stringify(validPacket()) + '\\n')}));`);
    fs.symlinkSync(realWorker, link);
    await assert.rejects(session.run({ root: f.root, query: 'needle' }), /regular non-symlink/i);
    assert.equal(session.pid, undefined);
  } finally { await session.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('restarts after a failed worker without reusing poisoned response bytes', async () => {
  const f = fixture();
  const path = script(f, `process.stdin.once('data',()=>{process.stdout.write('{\\n')});`);
  const session = new PersistentWorkerSession({ workerPath: path });
  try {
    await assert.rejects(session.run({ root: f.root, query: 'needle' }), /malformed/);
    script(f, `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(JSON.stringify(validPacket()) + '\n')})});`);
    assert.equal((await session.run({ root: f.root, query: 'needle' })).target.query, 'needle');
  } finally { await session.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('retains cleanup failures for later close and run callers', async () => {
  const f = fixture();
  const session = new PersistentWorkerSession({ workerPath: worker });
  const original = fs.rmSync;
  let blockedDirectory;
  try {
    await session.run({ root: f.root, query: 'needle' });
    fs.rmSync = (path, options) => {
      if (String(path).includes('pi-inspect-session-')) {
        blockedDirectory = path;
        throw new Error('deliberate cleanup denial');
      }
      return original(path, options);
    };
    syncBuiltinESMExports();
    await assert.rejects(session.close(), /cleanup.*deliberate cleanup denial/);
    await assert.rejects(session.close(), /cleanup.*deliberate cleanup denial/);
    await assert.rejects(session.run({ root: f.root, query: 'needle' }), /cleanup.*deliberate cleanup denial/);
  } finally {
    fs.rmSync = original;
    syncBuiltinESMExports();
    if (blockedDirectory) original(blockedDirectory, { recursive: true, force: true });
    original(f.directory, { recursive: true, force: true });
  }
});

test('close immediately after run cancels startup without leaking a process', async () => {
  const f = fixture();
  const session = new PersistentWorkerSession({ workerPath: worker });
  try {
    const pending = session.run({ root: f.root, query: 'needle' });
    const rejected = assert.rejects(pending, /closed/);
    const pid = session.pid;
    await session.close();
    await rejected;
    assert.equal(session.pid, undefined);
    await waitFor(() => processGone(pid));
  } finally { await session.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('unsolicited idle output poisons the process before the next call', async () => {
  const f = fixture();
  const session = new PersistentWorkerSession({ workerPath: script(f, `
    process.stdin.once('data',()=>{
      process.stdout.write(${JSON.stringify(JSON.stringify(validPacket()) + '\n')});
      setTimeout(()=>process.stdout.write('{}\\n'),30);
    });
  `) });
  try {
    await session.run({ root: f.root, query: 'needle' });
    const pid = session.pid;
    await waitFor(() => session.pid === undefined);
    await waitFor(() => processGone(pid));
  } finally { await session.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('rejects an aborted call before starting resources', async () => {
  const f = fixture();
  const session = new PersistentWorkerSession({ workerPath: worker });
  const controller = new AbortController();
  controller.abort(new Error('cancelled before start'));
  try {
    await assert.rejects(session.run({ root: f.root, query: 'needle' }, { signal: controller.signal }), /cancelled before start/);
    assert.equal(session.pid, undefined);
  } finally {
    await session.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

const BUDGET_MS = 200;
function delayedWorker(f, hang = false) {
  return script(f, `
    process.stdin.on('data', chunk => {
      const request = JSON.parse(chunk.toString('utf8').trim());
      const delay = Number(request.query.split(':')[1]);
      const packet = ${JSON.stringify(validPacket())};
      packet.target.query = request.query;
      if (${hang}) return;
      setTimeout(() => process.stdout.write(JSON.stringify(packet) + '\\n'), delay);
    });
  `);
}
test('gives a fresh worker twice the budget and later requests the plain budget', async () => {
  const f = fixture();
  const other = join(f.directory, 'other');
  mkdirSync(other);
  const session = new PersistentWorkerSession({ timeoutMs: BUDGET_MS, workerPath: delayedWorker(f) });
  try {
    await session.run({ root: f.root, query: 'slow:300' });
    await session.run({ root: f.root, query: 'quick:10' });
    await assert.rejects(session.run({ root: f.root, query: 'slow:300' }), /worker timed out after 200ms/);
    await session.run({ root: other, query: 'slow:300' });
  } finally {
    await session.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test('kills a hung fresh worker at twice the budget', async () => {
  const f = fixture();
  const session = new PersistentWorkerSession({ timeoutMs: BUDGET_MS, workerPath: delayedWorker(f, true) });
  try {
    const started = Date.now();
    await assert.rejects(session.run({ root: f.root, query: 'hang:0' }), /worker timed out after 400ms/);
    assert.ok(Date.now() - started >= 2 * BUDGET_MS);
  } finally {
    await session.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
