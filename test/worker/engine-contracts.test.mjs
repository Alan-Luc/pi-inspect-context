import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { InspectionEngine } from '../../src/worker/engine.ts';

const execute = promisify(execFile);
const gitEnvironment = {
  PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
};

async function repository(run) {
  const parent = await mkdtemp(join(tmpdir(), 'inspect-ts-engine-contract-'));
  const root = await realpath(parent);
  try {
    await execute('git', ['init', '--quiet'], { cwd: root, env: gitEnvironment });
    await run(root);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function inspect(root, query) {
  const engine = new InspectionEngine();
  try {
    return await engine.inspect({ version: 1, root, query }, { version: 1, root });
  } finally {
    await engine.close();
  }
}

test('recognizes an unborn Git repository and searches its untracked source', async () => {
  await repository(async (root) => {
    await writeFile(join(root, 'untracked.ts'), 'export function unbornNeedle() {}\n');

    const packet = await inspect(root, 'unbornNeedle');

    assert.equal(packet.target.repository, 'git');
    assert.equal(packet.snapshot.revision, undefined);
    assert.ok(packet.excerpts.some((item) => item.path === 'untracked.ts' && item.text === 'export function unbornNeedle() {}\n'));
  });
});

test('reads dirty worktree content instead of staged index content', async () => {
  await repository(async (root) => {
    const source = join(root, 'src.ts');
    await writeFile(source, 'export function stagedNeedle() {}\n');
    await execute('git', ['add', '--', 'src.ts'], { cwd: root, env: gitEnvironment });
    await writeFile(source, 'export function worktreeNeedle() {}\n');

    const packet = await inspect(root, 'worktreeNeedle');

    assert.equal(packet.target.repository, 'git');
    assert.ok(packet.excerpts.some((item) => item.path === 'src.ts' && item.text === 'export function worktreeNeedle() {}\n'));
    assert.ok(!packet.excerpts.some((item) => item.text.includes('stagedNeedle')));
  });
});

test('preserves a source UTF-8 byte-order mark in exact excerpt text', async () => {
  await repository(async (root) => {
    const source = '\uFEFFexport function bomNeedle() {}\n';
    await writeFile(join(root, 'source.ts'), source);
    const packet = await inspect(root, 'bomNeedle');
    assert.ok(packet.excerpts.some(item => item.path === 'source.ts' && item.text === source));
    assert.equal(packet.receipt.bytesRead, Buffer.byteLength(source));
  });
});

test('excludes ignored untracked files from Git evidence', async () => {
  await repository(async (root) => {
    await writeFile(join(root, '.gitignore'), 'ignored/\n');
    await writeFile(join(root, 'tracked.ts'), 'export function visibleNeedle() {}\n');
    await mkdir(join(root, 'ignored'));
    await writeFile(join(root, 'ignored', 'hidden.ts'), 'export function visibleNeedle() {}\n');
    await execute('git', ['add', '--', '.gitignore', 'tracked.ts'], { cwd: root, env: gitEnvironment });

    const packet = await inspect(root, 'visibleNeedle');

    assert.equal(packet.target.repository, 'git');
    assert.ok(packet.excerpts.some((item) => item.path === 'tracked.ts'));
    assert.ok(!packet.excerpts.some((item) => item.path.startsWith('ignored/')));
  });
});
