import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGitExecutable } from '../../src/git-executable.ts';
import { resolveInspectionRoot } from '../../src/adapter.ts';
import test from 'node:test';

const selected = process.platform === 'darwin' ? cp.spawnSync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8' }).stdout.trimEnd() : 'git';

test('selects the real developer-tools Git when the system launcher owns the sanitized PATH', { skip: process.platform !== 'darwin' }, () => {
  assert.notEqual(selected, '/usr/bin/git');
  assert.equal(resolveGitExecutable(process.env.PATH ?? '/usr/bin:/bin'), selected);
});

test('root resolution uses the developer-tools executable through the sanitized environment', { skip: process.platform !== 'darwin' }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'inspect-root-git-')));
  cp.execFileSync('git', ['init', '--quiet'], { cwd: root });
  const original = cp.spawn;
  const launches = [];
  cp.spawn = (...args) => {
    launches.push(args);
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await resolveInspectionRoot(root), root);
    assert.equal(launches.length, 1);
    assert.equal(launches[0][0], selected);
    assert.equal(launches[0][2].env.PATH, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  } finally { cp.spawn = original; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test('preserves a Git executable earlier in PATH', { skip: process.platform !== 'darwin' }, () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'inspect-git-path-')));
  const previous = process.env.PATH;
  try {
    writeFileSync(join(directory, 'git'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(directory, 'git'), 0o700);
    process.env.PATH = `${directory}:/usr/bin:/bin`;
    assert.equal(resolveGitExecutable(process.env.PATH ?? '/usr/bin:/bin'), 'git');
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('preserves normal Git selection outside macOS', { skip: process.platform === 'darwin' }, () => {
  assert.equal(resolveGitExecutable(process.env.PATH ?? '/usr/bin:/bin'), 'git');
});

test('falls back to normal Git selection when developer-tools discovery fails or is unsafe', { skip: process.platform !== 'darwin' }, () => {
  const original = cp.spawnSync;
  try {
    for (const outcome of [
      { status: 1, stdout: '', stderr: 'not installed' },
      { status: null, stdout: '', error: new Error('timeout') },
      { status: 0, stdout: '/usr/bin/git\nextra\n' },
      { status: 0, stdout: 'relative/git\n' },
      { status: 0, stdout: '/does-not-exist/git\n' },
      { status: 0, stdout: '/usr/bin/git\n' },
      { status: 0, stdout: '/tmp\n' },
    ]) {
      cp.spawnSync = (file, args, options) => {
        assert.equal(file, '/usr/bin/xcrun');
        assert.deepEqual(args, ['--find', 'git']);
        assert.equal(options.shell, false);
        assert.ok(options.timeout > 0 && options.timeout <= 2000);
        assert.ok(options.maxBuffer <= 4096);
        assert.equal(options.env.DEVELOPER_DIR, undefined);
        return outcome;
      };
      syncBuiltinESMExports();
      assert.equal(resolveGitExecutable(process.env.PATH ?? '/usr/bin:/bin'), 'git');
    }
  } finally { cp.spawnSync = original; syncBuiltinESMExports(); }
});
