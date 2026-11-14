import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import registerSessionInspectContext from '../../extensions/typescript.ts';
import { PersistentWorkerSession } from '../../src/worker/worker-session.ts';
import { renderModelEvidence } from '../../src/session-model-evidence.ts';

const execute = promisify(execFile);

test('root resolution timing excludes the worker session', async (context) => {
  const parent = await mkdtemp(join(tmpdir(), 'inspect-ts-root-timing-'));
  const root = await realpath(parent);
  let shutdown;
  let clock = 0;
  const packet = JSON.parse(await readFile(new URL('../fixtures/protocol/packet.json', import.meta.url), 'utf8'));
  context.mock.method(performance, 'now', () => clock);
  context.mock.method(PersistentWorkerSession.prototype, 'run', async () => {
    clock += 100;
    return packet;
  });
  try {
    const registrations = [];
    registerSessionInspectContext({
      registerTool(tool) { registrations.push(tool); },
      on(_event, handler) { shutdown = handler; },
    });
    const result = await registrations[0].execute('timing-call', { query: 'timingNeedle' }, undefined, undefined, { cwd: root });
    assert.equal(result.details.receipt.stageDurationsMs.rootResolution, 0);
  } finally {
    if (shutdown) await shutdown();
    await rm(parent, { recursive: true, force: true });
  }
});

test('session tool exposes all stage timings without changing rendered model content', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'inspect-ts-timing-'));
  const root = await realpath(parent);
  let shutdown;
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'timing.ts'), 'export function timingNeedle() {}\n');
    await execute('git', ['init', '--quiet'], { cwd: root });
    await execute('git', ['add', '--', 'src/timing.ts'], { cwd: root });
    const registrations = [];
    registerSessionInspectContext({
      registerTool(tool) { registrations.push(tool); },
      on(_event, handler) { shutdown = handler; },
    });
    const result = await registrations[0].execute('timing-call', { query: 'timingNeedle' }, undefined, undefined, { cwd: root });
    const durations = result.details.receipt.stageDurationsMs;
    assert.deepEqual(Object.keys(durations).sort(), ['directReads', 'discovery', 'finalSnapshot', 'rendering', 'retrievalRanking', 'rootResolution']);
    assert.ok(Object.values(durations).every(value => Number.isFinite(value) && value >= 0));
    assert.equal(result.content[0].text, renderModelEvidence(result.details));
  } finally {
    if (shutdown) await shutdown();
    await rm(parent, { recursive: true, force: true });
  }
});
