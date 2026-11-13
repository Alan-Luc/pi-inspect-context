import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InspectionEngine } from '../../src/worker/engine.ts';

test('settles independent inventory subprocesses before reporting a failed command', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'inspect-inventory-concurrency-')));
  writeFileSync(join(root, 'needle.ts'), 'export const needle = 1;\n');
  cp.execFileSync('git', ['init', '--quiet'], { cwd: root });
  cp.execFileSync('git', ['add', '-A'], { cwd: root });
  const original = cp.spawn;
  const independent = [];
  const children = [];
  cp.spawn = (file, args, options) => {
    let child;
    if (args.includes('--verify')) {
      child = original(join(root, 'missing-git'), [], options);
    } else if (args.includes('ls-files')) {
      child = original(process.execPath, ['-e', `setTimeout(()=>process.stdout.write('needle.ts\\0'),150)`], options);
      independent.push(child);
    } else if (args.includes('status')) {
      child = original(file, args, options);
      independent.push(child);
    } else child = original(file, args, options);
    const record = { child, closed: false };
    children.push(record);
    child.once('close', () => { record.closed = true; });
    return child;
  };
  syncBuiltinESMExports();
  const engine = new InspectionEngine();
  try {
    await assert.rejects(engine.inspect({ version: 1, root, query: 'needle' }, { version: 1, root }), /ENOENT/);
    assert.equal(independent.length, 2, 'start both independent inventory reads');
    assert.ok(children.every(record => record.closed), 'settle all owned subprocesses before returning failure');
  } finally {
    cp.spawn = original;
    syncBuiltinESMExports();
    await engine.close();
    for (const { child, closed } of children) {
      if (!closed) {
        child.kill('SIGKILL');
        await new Promise(done => child.once('close', done));
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
