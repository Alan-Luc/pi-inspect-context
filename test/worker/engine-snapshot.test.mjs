import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { InspectionEngine } from '../../src/worker/engine.ts';
import { MAX_FILE_BYTES } from '../../src/packet.ts';

const execute = promisify(execFile);
const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const node = process.execPath;
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

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fixture(change) {
  const parent = await mkdtemp(join(tmpdir(), 'inspect-ts-engine-snapshot-'));
  const root = join(parent, 'repo');
  const outside = join(parent, 'outside');
  const tools = join(parent, 'tools');
  const count = join(parent, 'status-count');
  const inventoryCount = join(parent, 'inventory-count');
  const headCount = join(parent, 'head-count');
  const mutationMarker = join(parent, 'mutation-started');
  const output = join(parent, 'git-output');
  const errors = join(parent, 'git-errors');
  await mkdir(root);
  await mkdir(outside);
  await mkdir(tools);
  try {
    const sourcePath = change === 'parent' ? 'dir/source.ts' : 'source.ts';
    if (change === 'parent') await mkdir(join(root, 'dir'));
    if (change === 'sparse') {
      await mkdir(join(root, 'kept'));
      await mkdir(join(root, 'omitted'));
      await writeFile(join(root, 'kept', 'source.ts'), 'export function sparseNeedle() { return "inside"; }\n');
      await writeFile(join(root, 'omitted', 'absent.ts'), 'export function sparseNeedle() { return "omitted"; }\n');
    } else await writeFile(join(root, sourcePath), 'export function snapshotNeedle() { return "inside"; }\n');
    await writeFile(join(outside, 'secret.ts'), 'export function snapshotNeedle() { return "outside secret"; }\n');
    await execute(git, ['init', '--quiet'], { cwd: root, env: gitEnvironment });
    await execute(git, ['add', '--', '.'], { cwd: root, env: gitEnvironment });
    await execute(git, ['-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root, env: gitEnvironment });
    const initialHead = (await execute(git, ['rev-parse', 'HEAD'], { cwd: root, env: gitEnvironment })).stdout.trim();
    if (change === 'oversized') await writeFile(join(root, 'new.ts'), Buffer.alloc(MAX_FILE_BYTES + 1, 120));
    const initialStatus = (await execute(git, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames'], { cwd: root, env: gitEnvironment })).stdout;
    if (change === 'sparse') await execute(git, ['sparse-checkout', 'set', '--cone', 'kept'], { cwd: root, env: gitEnvironment });
    const helper = join(parent, 'mutate.mjs');
    await writeFile(helper, `import { execFile } from 'node:child_process';\nimport { mkdir, rename, symlink, writeFile } from 'node:fs/promises';\nimport { join } from 'node:path';\nimport { promisify } from 'node:util';\nconst execute = promisify(execFile);\nconst [change, root, outside, git] = process.argv.slice(2);\nif (change === 'source') await writeFile(join(root, 'source.ts'), 'export function snapshotNeedle() { return "changed"; }\\n');\nif (change === 'skip') { await execute(git, ['update-index', '--skip-worktree', '--', 'source.ts'], { cwd: root }); await writeFile(join(root, 'source.ts'), 'export function snapshotNeedle() { return "changed after skip"; }'); }\nif (change === 'oversized') await writeFile(join(root, 'new.ts'), 'export function snapshotNeedle() {}');\nif (change === 'untracked') await writeFile(join(root, 'new.ts'), 'export function newNeedle() {}\\n');\nif (change === 'head') { await writeFile(join(root, 'head.ts'), 'export function committedDuringScan() {}\\n'); await execute(git, ['add', '--', 'head.ts'], { cwd: root }); await execute(git, ['-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.invalid', 'commit', '--quiet', '-m', 'during scan'], { cwd: root }); }\nif (change === 'sparse') { await mkdir(join(root, 'omitted'), { recursive: true }); await writeFile(join(root, 'omitted', 'absent.ts'), 'export function sparseNeedle() { return "omitted"; }\\n'); }\nif (change === 'root') { await rename(root, root + '.old'); await mkdir(root); await writeFile(join(root, 'secret.ts'), 'outside replacement content'); }\nif (change === 'parent') { await rename(join(root, 'dir'), join(root, 'dir-old')); await symlink(outside, join(root, 'dir')); }\n`);
    const wrapper = join(tools, 'git');
    await writeFile(wrapper, `#!/bin/sh\nset +e\n${shellQuote(git)} "$@" > ${shellQuote(output)}.$$ 2> ${shellQuote(errors)}.$$\nresult=$?\ncase "$*" in *"ls-files -t"*) count=$(cat ${shellQuote(inventoryCount)} 2>/dev/null || printf 0); printf '%s' "$((count + 1))" > ${shellQuote(inventoryCount)} ;; esac\ncase "$*" in *"rev-parse --verify --quiet HEAD"*) count=$(cat ${shellQuote(headCount)} 2>/dev/null || printf 0); printf '%s' "$((count + 1))" > ${shellQuote(headCount)} ;; esac\ncase "$*" in *"status --porcelain=v2"*) count=$(cat ${shellQuote(count)} 2>/dev/null || printf 0); count=$((count + 1)); printf '%s' "$count" > ${shellQuote(count)}; if [ "$count" -eq 2 ] && { [ ${shellQuote(change)} = source ] || [ ${shellQuote(change)} = root ] || [ ${shellQuote(change)} = parent ]; }; then ${shellQuote(node)} ${shellQuote(helper)} ${shellQuote(change)} ${shellQuote(root)} ${shellQuote(outside)} ${shellQuote(git)}; fi ;; esac\ncase "$*" in *"grep --cached"*) if { [ ${shellQuote(change)} = untracked ] || [ ${shellQuote(change)} = oversized ] || [ ${shellQuote(change)} = skip ] || [ ${shellQuote(change)} = head ] || [ ${shellQuote(change)} = sparse ]; } && mkdir ${shellQuote(mutationMarker)} 2>/dev/null; then ${shellQuote(node)} ${shellQuote(helper)} ${shellQuote(change)} ${shellQuote(root)} ${shellQuote(outside)} ${shellQuote(git)}; fi ;; esac\ncat ${shellQuote(output)}.$$\ncat ${shellQuote(errors)}.$$ >&2\nexit "$result"\n`);
    await chmod(wrapper, 0o755);
    const canonicalRoot = await realpath(root);
    const previousPath = process.env.PATH ?? '/usr/bin:/bin';
    process.env.PATH = `${tools}:${previousPath}`;
    const engine = new InspectionEngine();
    try {
      const inspect = engine.inspect({ version: 1, root: canonicalRoot, query: change === 'sparse' ? 'sparseNeedle' : 'snapshotNeedle' }, { version: 1, root: canonicalRoot });
      if (change === 'stable') {
        const packet = await inspect;
        assert.ok(packet.excerpts.some(item => item.path === 'source.ts'));
        assert.equal(Number(await readFile(inventoryCount, 'utf8')), 2);
        assert.equal(Number(await readFile(headCount, 'utf8')), 2);
        assert.equal(Number(await readFile(count, 'utf8')), 2);
      } else if (change === 'oversized') {
        assert.match(initialStatus.toString(), /\? new\.ts\0/);
        const outcome = await inspect.then(packet => ({ packet }), error => ({ error }));
        assert.equal(await readFile(join(root, 'new.ts'), 'utf8'), 'export function snapshotNeedle() {}');
        assert.equal((await execute(git, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames'], { cwd: root, env: gitEnvironment })).stdout, initialStatus);
        assert.equal(outcome.error?.code, 'snapshot_changed', 'must reject changed oversized worktree admission despite unchanged status');
      } else if (change === 'skip') {
        assert.equal(initialStatus.toString(), '');
        assert.match((await execute(git, ['ls-files', '-t', '--', 'source.ts'], { cwd: root, env: gitEnvironment })).stdout, /^H source\.ts/);
        const outcome = await inspect.then(packet => ({ packet }), error => ({ error }));
        assert.equal(await readFile(join(root, 'source.ts'), 'utf8'), 'export function snapshotNeedle() { return "changed after skip"; }');
        assert.equal((await execute(git, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames'], { cwd: root, env: gitEnvironment })).stdout, initialStatus);
        assert.match((await execute(git, ['ls-files', '-t', '--', 'source.ts'], { cwd: root, env: gitEnvironment })).stdout, /^S source\.ts/);
        assert.equal(outcome.error?.code, 'snapshot_changed', 'must reject skip-worktree flag change hiding an accepted source edit');
      } else {
        await assert.rejects(inspect, (error) => error.code === 'snapshot_changed');
        if (change === 'untracked') {
          assert.match((await execute(git, ['status', '--porcelain=v2'], { cwd: root, env: gitEnvironment })).stdout, /\? new\.ts/);
        }
        if (change === 'head') {
          assert.notEqual((await execute(git, ['rev-parse', 'HEAD'], { cwd: root, env: gitEnvironment })).stdout.trim(), initialHead);
          assert.equal((await execute(git, ['status', '--porcelain=v2'], { cwd: root, env: gitEnvironment })).stdout, '');
        }
        if (change === 'sparse') {
          assert.equal(await readFile(join(root, 'omitted', 'absent.ts'), 'utf8'), 'export function sparseNeedle() { return "omitted"; }\n');
          assert.equal((await execute(git, ['status', '--porcelain=v2'], { cwd: root, env: gitEnvironment })).stdout, '');
        }
      }
    } finally {
      await engine.close();
      process.env.PATH = previousPath;
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test('checks skip-worktree flags without rebuilding inventory', async () => {
  await fixture('stable');
});

test('rejects an accepted source changed after final Git status capture', async () => {
  await fixture('source');
});

test('rejects an oversized untracked file shrinking after admission while status stays unchanged', async () => {
  await fixture('oversized');
});

test('rejects an accepted source edit hidden by a new skip-worktree flag', async () => {
  await fixture('skip');
});

test('rejects a new untracked file in scope during scanning', async () => {
  await fixture('untracked');
});

test('rejects a HEAD change with a clean final worktree', async () => {
  await fixture('head');
});

test('rejects restoration of an omitted sparse file during scanning', async () => {
  await fixture('sparse');
});

test('rejects a replaced repository root after final Git status capture', async () => {
  await fixture('root');
});

test('rejects an accepted parent replaced by a symlink after final Git status capture', async () => {
  await fixture('parent');
});
