import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixtureCases } from '../../bench/inspect-context.mjs';
import { runWorker } from '../../src/adapter.ts';
import { InspectionEngine } from '../../src/worker/engine.ts';

const frozen = fileURLToPath(new URL('../..', import.meta.url));
const execute = promisify(execFile);
const environment = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
for (const fixture of fixtureCases) {
  test(`full collector parity with frozen Go: ${fixture.id}`, async () => {
    const scratch = await mkdtemp(join(await realpath(tmpdir()), 'inspect-collector-parity-'));
    const engine = new InspectionEngine();
    try {
      await cp(join(frozen, 'bench/fixtures', fixture.root), scratch, { recursive: true });
      await execute('git', ['init', '--quiet'], { cwd: scratch, env: environment });
      await execute('git', ['add', '-A'], { cwd: scratch, env: environment });
      const reference = await runWorker({ root: scratch, cwd: fixture.cwd, query: fixture.query }, { workerPath: join(frozen, 'bin/inspect-context') });
      const candidate = await engine.inspect({ version: 1, root: scratch, cwd: fixture.cwd, query: fixture.query }, { version: 1, root: scratch });
      assert.deepEqual({ ...candidate, receipt: { ...candidate.receipt, durationMs: 0 } }, { ...reference, receipt: { ...reference.receipt, durationMs: 0 } });
    } finally {
      await engine.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
