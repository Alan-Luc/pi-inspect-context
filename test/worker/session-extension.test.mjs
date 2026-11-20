import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registerInspectContext } from '../../extensions/index.ts';
import { inspectContextToolDefinition } from '../../src/adapter.ts';

function registration(options) {
  const handlers = new Map();
  const tools = [];
  registerInspectContext({
    on(name, handler) { assert.equal(handlers.has(name), false); handlers.set(name, handler); },
    registerTool(tool) { tools.push(tool); },
  }, options);
  assert.equal(tools.length, 1);
  assert.deepEqual([...handlers.keys()].sort(), ['session_shutdown', 'session_start']);
  return { tool: tools[0], shutdown: handlers.get('session_shutdown'), start: handlers.get('session_start') };
}
function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}

test('default registration preserves a configured worker timeout', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'inspect-session-timeout-')));
  writeFileSync(join(scratch, 'needle.ts'), 'export const needle = 1;\n');
  const registered = registration({ timeoutMs: 1 });
  try {
    await assert.rejects(registered.tool.execute('timeout', { query: 'needle' }, undefined, undefined, { cwd: scratch }), /timed out/);
  } finally {
    await registered.shutdown({ type: 'session_shutdown', reason: 'quit' });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('registered tool owns lazy resources, returns exact fresh evidence, and releases roots on shutdown', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'inspect-session-tool-')));
  const first = join(scratch, 'first');
  const second = join(scratch, 'second');
  mkdirSync(first); mkdirSync(second);
  writeFileSync(join(first, 'needle.ts'), 'export const needle = 1;\n');
  writeFileSync(join(second, 'other.ts'), 'export const needle = 2;\n');
  const spawns = [];
  const original = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = original(...args);
    spawns.push({ child, args });
    return child;
  };
  syncBuiltinESMExports();
  let registered;
  try {
    registered = registration();
    assert.equal(spawns.length, 0);
    for (const key of ['name', 'description', 'parameters', 'outputSchema', 'executionMode', 'annotations']) {
      assert.deepEqual(registered.tool[key], inspectContextToolDefinition[key]);
    }
    await assert.rejects(registered.tool.execute('bad', { query: '' }, undefined, undefined, { cwd: '/does-not-exist' }), /query/);
    assert.equal(spawns.length, 0);
    const result = await registered.tool.execute('one', { query: 'needle' }, undefined, undefined, { cwd: first });
    assert.ok(result.details.excerpts.some(item => item.path === 'needle.ts' && item.text === 'export const needle = 1;\n'));
    assert.deepEqual(result.structuredContent, result.details);
    assert.match(result.content[0].text, /untrusted/i);
    assert.equal(spawns.length, 1);
    writeFileSync(join(first, 'needle.ts'), 'export const needle = 3;\n');
    const fresh = await registered.tool.execute('two', { query: 'needle' }, undefined, undefined, { cwd: first });
    assert.ok(fresh.details.excerpts.some(item => item.text === 'export const needle = 3;\n'));
    assert.equal(spawns.length, 1);
    await registered.tool.execute('three', { query: 'needle' }, undefined, undefined, { cwd: second });
    assert.equal(spawns.length, 2);
    assert.ok(gone(spawns[0].child.pid));
    assert.equal(existsSync(spawns[0].args[2].cwd), false);
    await registered.shutdown({ type: 'session_shutdown', reason: 'reload' });
    await registered.shutdown({ type: 'session_shutdown', reason: 'reload' });
    for (const spawned of spawns) {
      assert.ok(gone(spawned.child.pid));
      assert.equal(existsSync(spawned.args[2].cwd), false);
    }
  } finally {
    if (registered) await registered.shutdown({ type: 'session_shutdown', reason: 'quit' });
    childProcess.spawn = original;
    syncBuiltinESMExports();
    rmSync(scratch, { recursive: true, force: true });
  }
});

function spyOnSpawn() {
  const spawns = [];
  const original = childProcess.spawn;
  childProcess.spawn = (...args) => { const child = original(...args); spawns.push({ child, args }); return child; };
  syncBuiltinESMExports();
  return { spawns, restore() { childProcess.spawn = original; syncBuiltinESMExports(); } };
}
function gitScratch() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'inspect-session-prewarm-')));
  writeFileSync(join(scratch, 'needle.ts'), 'export const needle = 1;\n');
  childProcess.execFileSync('git', ['init', '-q'], { cwd: scratch });
  return scratch;
}
const sessionStart = { type: 'session_start', reason: 'startup' };

test('session_start prewarms the worker in a Git root without blocking', async () => {
  const scratch = gitScratch();
  const spy = spyOnSpawn();
  const registered = registration();
  try {
    await registered.start(sessionStart, { cwd: scratch });
    const deadline = Date.now() + 5000;
    const workers = () => spy.spawns.filter(s => s.args[1].includes('--session'));
    while (workers().length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(workers().length, 1);
  } finally {
    await registered.shutdown({ type: 'session_shutdown', reason: 'quit' });
    spy.restore();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('session_start spawns nothing outside a Git repository', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'inspect-session-nogit-')));
  const spy = spyOnSpawn();
  const registered = registration();
  try {
    await registered.start(sessionStart, { cwd: scratch });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(spy.spawns.length, 0);
  } finally {
    await registered.shutdown({ type: 'session_shutdown', reason: 'quit' });
    spy.restore();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a real call during prewarm waits and succeeds', async () => {
  const scratch = gitScratch();
  const spy = spyOnSpawn();
  const registered = registration();
  try {
    await registered.start(sessionStart, { cwd: scratch });
    const result = await registered.tool.execute('during', { query: 'needle' }, undefined, undefined, { cwd: scratch });
    assert.ok(result.details.excerpts.some(item => item.path === 'needle.ts'));
  } finally {
    await registered.shutdown({ type: 'session_shutdown', reason: 'quit' });
    spy.restore();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('aborting a real call during prewarm rejects without waiting for prewarm', async () => {
  const scratch = gitScratch();
  const registered = registration();
  try {
    await registered.start(sessionStart, { cwd: scratch });
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(new Error('caller cancelled')), 20);
    await assert.rejects(registered.tool.execute('abort', { query: 'needle' }, controller.signal, undefined, { cwd: scratch }), /caller cancelled/);
    assert.ok(performance.now() - started < 100, `rejected after ${Math.round(performance.now() - started)}ms`);
  } finally {
    await registered.shutdown({ type: 'session_shutdown', reason: 'quit' });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a repeated session_start queues prewarm so an immediate call succeeds', async () => {
  const scratch = gitScratch();
  const registered = registration();
  try {
    await registered.start(sessionStart, { cwd: scratch });
    await registered.start(sessionStart, { cwd: scratch });
    const result = await registered.tool.execute('twice', { query: 'needle' }, undefined, undefined, { cwd: scratch });
    assert.ok(result.details.excerpts.some(item => item.path === 'needle.ts'));
  } finally {
    await registered.shutdown({ type: 'session_shutdown', reason: 'quit' });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('shutdown during prewarm leaves no child process', async () => {
  const scratch = gitScratch();
  const spy = spyOnSpawn();
  const registered = registration();
  try {
    await registered.start(sessionStart, { cwd: scratch });
    await registered.shutdown({ type: 'session_shutdown', reason: 'quit' });
    await new Promise(r => setTimeout(r, 500));
    for (const spawned of spy.spawns) assert.ok(gone(spawned.child.pid));
  } finally {
    spy.restore();
    rmSync(scratch, { recursive: true, force: true });
  }
});
