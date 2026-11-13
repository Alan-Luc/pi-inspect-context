import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixtureCases } from '../../bench/inspect-context.mjs';
import { runWorker } from '../../src/adapter.ts';
import { buildEvidencePacket, sourceLines, exclusionReason } from '../../src/worker/retrieval.ts';

const frozen = fileURLToPath(new URL('../..', import.meta.url));
const execute = promisify(execFile);
const environment = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
async function filesIn(root, directory = '') {
  const files = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesIn(root, path));
    else if (!exclusionReason(path)) {
      const text = await readFile(join(root, path), 'utf8');
      files.push({ path, text, lines: sourceLines(text) });
    }
  }
  return files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}
function nearestScope(files, cwd) {
  const markers = new Set(files.filter(file => ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'].includes(posix.basename(file.path))).map(file => posix.dirname(file.path)));
  for (let current = cwd; current !== '.'; current = posix.dirname(current)) if (markers.has(current)) return current;
  return '.';
}
for (const fixture of fixtureCases) {
  test(`pure packet parity with frozen Go: ${fixture.id}`, async () => {
    const scratch = await mkdtemp(join(await realpath(tmpdir()), 'inspect-pure-parity-'));
    try {
      await cp(join(frozen, 'bench/fixtures', fixture.root), scratch, { recursive: true });
      const files = await filesIn(scratch);
      await execute('git', ['init', '--quiet'], { cwd: scratch, env: environment });
      await execute('git', ['add', '-A'], { cwd: scratch, env: environment });
      const reference = await runWorker({ root: scratch, cwd: fixture.cwd, query: fixture.query }, { workerPath: join(frozen, 'bin/inspect-context') });
      const candidate = buildEvidencePacket({
        query: fixture.query, cwd: fixture.cwd, scope: nearestScope(files, fixture.cwd), files,
        repository: reference.target.repository, ...(reference.snapshot.revision === undefined ? {} : { revision: reference.snapshot.revision }), snapshotId: reference.snapshot.id,
        discoveredFiles: reference.receipt.discoveredFiles, readFiles: reference.receipt.readFiles, bytesRead: reference.receipt.bytesRead, durationMs: reference.receipt.durationMs,
        omissions: reference.omissions.filter(group => !['package_scope', 'excerpt_limit', 'packet_limit'].includes(group.reason)),
      });
      assert.deepEqual(candidate, reference);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
