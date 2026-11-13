import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants, openSync, closeSync, fstatSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { acquireNativeFiles } from '../../src/worker/native-files.ts';
import { parseGitLine, parseGitPaths, parseGitMatchPaths, parseGitStatusPaths, runGit } from '../../src/worker/git.ts';

const execute = promisify(execFile);
const zero = '0'.repeat(40);
const ordinary = path => `1 .M N... 100644 100644 100644 ${zero} ${zero} ${path}\0`;

test('Git path framing rejects unsafe and malformed output while preserving spaces and Unicode', () => {
  assert.deepEqual(parseGitPaths(Buffer.from('H src/a b.ts\0H src/café.ts\0H node_modules/\0')), [{ path: 'src/a b.ts', skipWorktree: false }, { path: 'src/café.ts', skipWorktree: false }]);
  assert.deepEqual(parseGitPaths(Buffer.from('H \uFEFFsource.ts\0')), [{ path: '\uFEFFsource.ts', skipWorktree: false }]);
  for (const value of ['H ../escape\0', 'H /outside\0', 'H a\\b\0', 'H a//b\0', 'unterminated']) assert.throws(() => parseGitPaths(Buffer.from(value)));
  assert.throws(() => parseGitPaths(Buffer.from([0xff, 0])));
  assert.deepEqual(parseGitPaths(Buffer.from('H tracked.ts\0M conflict.ts\0M conflict.ts\0S sparse.ts\0')), [{ path: 'tracked.ts', skipWorktree: false }, { path: 'conflict.ts', skipWorktree: false }, { path: 'sparse.ts', skipWorktree: true }]);
  assert.throws(() => parseGitPaths(Buffer.from('H duplicate.ts\0M duplicate.ts\0')));
  assert.throws(() => parseGitPaths(Buffer.from('M duplicate.ts\0H duplicate.ts\0')));
  assert.equal(parseGitLine(Buffer.from('revision\n'), 'revision'), 'revision');
  for (const value of ['revision', ' revision\n', 'revision\r\n', 'a\nb\n']) assert.throws(() => parseGitLine(Buffer.from(value), 'revision'));
});

test('Git match and status records must belong to the inventory and stay unique', () => {
  const inventory = new Set(['src/a b.ts', 'new.ts']);
  assert.deepEqual(parseGitStatusPaths(Buffer.from(ordinary('src/a b.ts') + '? new.ts\0'), inventory), ['src/a b.ts', 'new.ts']);
  assert.deepEqual(parseGitMatchPaths(Buffer.from('src/a b.ts\0'), inventory), ['src/a b.ts']);
  assert.throws(() => parseGitMatchPaths(Buffer.from('unknown.ts\0'), inventory));
  assert.throws(() => parseGitMatchPaths(Buffer.from('new.ts\0new.ts\0'), inventory));
  assert.throws(() => parseGitStatusPaths(Buffer.from(ordinary('unknown.ts')), inventory));
  assert.throws(() => parseGitStatusPaths(Buffer.from(ordinary('new.ts') + ordinary('new.ts')), inventory));
  assert.throws(() => parseGitStatusPaths(Buffer.from(ordinary('new.ts').replace('.M', '..')), inventory));
  assert.throws(() => parseGitStatusPaths(Buffer.from(ordinary('new.ts').replace('N...', 'bad!')), inventory));
  assert.throws(() => parseGitStatusPaths(Buffer.from('2 R100 renamed\0'), inventory));
});

async function repository(run) {
  const release = acquireNativeFiles();
  const root = await mkdtemp(join(await realpath(tmpdir()), 'inspect-native-git-'));
  const descriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await execute('git', ['init', '--quiet'], { cwd: root });
    await run(root, descriptor);
  } finally { closeSync(descriptor); await rm(root, { recursive: true, force: true }); release(); }
}

test('metadata commands that ignore stdin preserve Git success and failure results', async () => {
  await repository(async (_root, descriptor) => {
    const success = await runGit(descriptor, ['--version']);
    assert.equal(success.code, 0);
    assert.match(success.stdout.toString(), /^git version /);
    const failure = await runGit(descriptor, ['inspect-context-missing-command']);
    assert.notEqual(failure.code, 0);
    assert.match(failure.stderr.toString(), /not a git command/);
  });
});

test('Git starts from the anchored repository and restores the caller directory', async () => {
  await repository(async (root, descriptor) => {
    const previous = openSync('.', constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const before = fstatSync(previous);
      const result = await runGit(descriptor, ['rev-parse', '--show-toplevel']);
      assert.equal(result.code, 0);
      assert.equal(parseGitLine(result.stdout, 'Git top level'), root);
      const current = openSync('.', constants.O_RDONLY | constants.O_DIRECTORY);
      try { const after = fstatSync(current); assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino); }
      finally { closeSync(current); }
    } finally { closeSync(previous); }
  });
});

test('fixed Git configuration prevents filesystem monitor execution and preserves limits', async () => {
  await repository(async (root, descriptor) => {
    const sentinel = join(root, 'executed');
    await writeFile(join(root, 'monitor.sh'), `#!/bin/sh\nprintf executed > '${sentinel}'\n`, { mode: 0o700 });
    await execute('git', ['config', 'core.fsmonitor', join(root, 'monitor.sh')], { cwd: root });
    const result = await runGit(descriptor, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames']);
    assert.equal(result.code, 0);
    await assert.rejects(readFile(sentinel), { code: 'ENOENT' });
    await assert.rejects(runGit(descriptor, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames'], '', 1), /exceeded/);
    const abort = new AbortController();
    abort.abort(new Error('owned cancellation'));
    await assert.rejects(runGit(descriptor, ['status'], '', 4096, abort.signal), /owned cancellation/);
  });
});
