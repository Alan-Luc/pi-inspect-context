import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registerInspectContext } from '../../extensions/index.ts';
import { createInspectContextTool } from '../../src/adapter.ts';

function registration(options) {
  const handlers = new Map();
  const tools = [];
  registerInspectContext({
    on(name, handler) { assert.equal(handlers.has(name), false); handlers.set(name, handler); },
    registerTool(tool) { tools.push(tool); },
  }, options);
  assert.equal(tools.length, 1);
  assert.deepEqual([...handlers.keys()], ['session_shutdown']);
  return { tool: tools[0], shutdown: handlers.get('session_shutdown') };
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
    const ordinary = createInspectContextTool();
    for (const key of ['name', 'description', 'parameters', 'outputSchema', 'executionMode', 'annotations']) {
      assert.deepEqual(registered.tool[key], ordinary[key]);
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
