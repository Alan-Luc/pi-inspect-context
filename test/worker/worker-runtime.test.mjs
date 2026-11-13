import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bun = 'bun';
test('a compiled Bun host launches a real Node worker instead of reexecuting itself', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'inspect-compiled-host-')));
  const source = join(root, 'host.ts');
  const executable = join(root, 'compiled-host');
  const session = fileURLToPath(new URL('../../src/worker/worker-session.ts', import.meta.url));
  const worker = fileURLToPath(new URL('../../src/worker/worker-process.ts', import.meta.url));
  writeFileSync(join(root, 'needle.ts'), 'export const needle = 42;\n');
  writeFileSync(source, `
    import assert from 'node:assert/strict';
    import {PersistentWorkerSession} from ${JSON.stringify(session)};
    if (process.argv.includes('--session')) { console.error('compiled host is not a Node interpreter'); process.exit(31); }
    const session = new PersistentWorkerSession({workerPath:${JSON.stringify(worker)}});
    try {
      const packet = await session.run({root:${JSON.stringify(root)},query:'needle'});
      assert.ok(packet.excerpts.some(item=>item.path==='needle.ts'&&item.text==='export const needle = 42;\\n'));
      console.log('compiled-host-success');
    } finally { await session.close(); }
  `);
  try {
    const compiled = spawnSync(bun, ['build', source, '--compile', '--outfile', executable], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /compiled-host-success/);
    const missing = spawnSync(executable, [], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: '/nonexistent' } });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /requires Node.js 22.19 or newer on PATH/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
