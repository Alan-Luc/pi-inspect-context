import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireNativeFiles } from '../../src/worker/native-files.ts';
import { runGit } from '../../src/worker/git.ts';
import { PrivateStatusIndex } from '../../src/worker/status-index.ts';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
const statusArgs = ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames'];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'status-index-'));
  git(root, 'init', '--quiet');
  mkdirSync(join(root, 'src/deep'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'ignored/\n*.log\n');
  writeFileSync(join(root, 'src/a.ts'), 'a\n');
  writeFileSync(join(root, 'src/deep/b.ts'), 'b\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'x');
  mkdirSync(join(root, 'ignored'));
  writeFileSync(join(root, 'ignored/x'), 'x');
  writeFileSync(join(root, 'debug.log'), 'x');
  writeFileSync(join(root, 'src/untracked.ts'), 'u\n');
  writeFileSync(join(root, 'src/deep/new.ts'), 'n\n');
  writeFileSync(join(root, 'src/a.ts'), 'changed\n');
  return root;
}

async function withRoot(run) {
  const root = fixture();
  const release = acquireNativeFiles();
  const descriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
  const statusIndex = new PrivateStatusIndex();
  try {
    await run({
      root,
      plain: async () => (await runGit(descriptor, statusArgs)).stdout,
      cached: async () => (await statusIndex.status(root, descriptor)).stdout,
    });
  } finally { statusIndex.close(); closeSync(descriptor); release(); rmSync(root, { recursive: true, force: true }); }
}

const listGitDirectory = root => readdirSync(join(root, '.git'), { recursive: true }).sort();

test('private-index status equals plain status across untracked, ignored, modified and nested files', async () => {
  await withRoot(async ({ plain, cached }) => {
    const expected = await plain();
    assert.ok(expected.length > 0);
    assert.deepEqual(await cached(), expected);
    assert.deepEqual(await cached(), expected);
  });
});

test('creating or deleting an untracked file in a known directory updates cached status', async () => {
  await withRoot(async ({ root, plain, cached }) => {
    await cached();
    await cached();
    writeFileSync(join(root, 'src/deep/created.ts'), 'c\n');
    assert.deepEqual(await cached(), await plain());
    assert.match((await cached()).toString(), /src\/deep\/created\.ts/);
    unlinkSync(join(root, 'src/deep/created.ts'));
    unlinkSync(join(root, 'src/untracked.ts'));
    assert.deepEqual(await cached(), await plain());
    assert.doesNotMatch((await cached()).toString(), /created\.ts|untracked\.ts/);
  });
});

test('inspections leave the repository git directory untouched', async () => {
  await withRoot(async ({ root, cached }) => {
    const names = listGitDirectory(root);
    const index = readFileSync(join(root, '.git/index'));
    await cached();
    writeFileSync(join(root, 'src/deep/late.ts'), 'l\n');
    await cached();
    assert.deepEqual(listGitDirectory(root), names);
    assert.ok(readFileSync(join(root, '.git/index')).equals(index));
  });
});

test('a changed real index refreshes the private copy', async () => {
  await withRoot(async ({ root, plain, cached }) => {
    await cached();
    git(root, 'add', 'src/untracked.ts');
    assert.deepEqual(await cached(), await plain());
    assert.match((await cached()).toString(), /(^|\0)1 A\./);
  });
});

test('split index falls back to plain status', async () => {
  await withRoot(async ({ root, plain, cached }) => {
    git(root, 'update-index', '--split-index');
    writeFileSync(join(root, 'src/deep/split.ts'), 's\n');
    assert.deepEqual(await cached(), await plain());
  });
});

const snapshotTree = directory => readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
  const path = join(entry.parentPath, entry.name);
  return [path, readFileSync(path).toString('base64'), statSync(path).mtimeMs];
}).sort((a, b) => a[0].localeCompare(b[0]));

for (const indexVersion of ['2', '3', '4']) test(`a populated submodule keeps its git directory untouched with index version ${indexVersion}`, async () => {
  await withRoot(async ({ root, plain, cached }) => {
    const source = fixture();
    try {
      git(root, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', source, 'sub');
      git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'sub');
      git(root, 'update-index', '--index-version', indexVersion);
      if (indexVersion === '3') git(root, 'update-index', '--skip-worktree', 'src/deep/b.ts');
      writeFileSync(join(root, 'sub/src/a.ts'), 'dirty\n');
      writeFileSync(join(root, 'sub/src/fresh.ts'), 'f\n');
      const before = snapshotTree(join(root, '.git/modules'));
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
      assert.deepEqual(await cached(), await plain());
      assert.deepEqual(await cached(), await plain());
      assert.deepEqual(snapshotTree(join(root, '.git/modules')), before);
    } finally { rmSync(source, { recursive: true, force: true }); }
  });
});

test('core.splitIndex in repository config writes no shared index into the git directory', async () => {
  await withRoot(async ({ root, plain, cached }) => {
    git(root, 'config', 'core.splitIndex', 'true');
    const names = listGitDirectory(root);
    assert.deepEqual(await cached(), await plain());
    assert.deepEqual(await cached(), await plain());
    assert.deepEqual(listGitDirectory(root), names);
  });
});

test('overlapping status calls across a real index change never keep a stale private copy', async () => {
  await withRoot(async ({ root, plain, cached }) => {
    for (let round = 0; round < 6; round++) {
      const path = `src/stage-${round}.ts`;
      writeFileSync(join(root, path), `${round}\n`);
      const first = cached();
      git(root, 'add', path);
      await Promise.all([first, cached(), cached()]);
      assert.deepEqual(await cached(), await plain());
    }
  });
});
