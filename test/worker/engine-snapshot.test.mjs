import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { InspectionEngine } from '../../src/worker/engine.ts';

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
  const output = join(parent, 'git-output');
  const errors = join(parent, 'git-errors');
  await mkdir(root);
  await mkdir(outside);
  await mkdir(tools);
  try {
    const sourcePath = change === 'parent' ? 'dir/source.ts' : 'source.ts';
    if (change === 'parent') await mkdir(join(root, 'dir'));
    await writeFile(join(root, sourcePath), 'export function snapshotNeedle() { return "inside"; }\n');
    await writeFile(join(outside, 'secret.ts'), 'export function snapshotNeedle() { return "outside secret"; }\n');
    await execute(git, ['init', '--quiet'], { cwd: root, env: gitEnvironment });
    await execute(git, ['add', '--', '.'], { cwd: root, env: gitEnvironment });
    await execute(git, ['-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root, env: gitEnvironment });
    const helper = join(parent, 'mutate.mjs');
    await writeFile(helper, `import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';\nimport { join } from 'node:path';\nconst [change, root, outside] = process.argv.slice(2);\nif (change === 'source') await writeFile(join(root, 'source.ts'), 'export function snapshotNeedle() { return "changed"; }\\n');\nif (change === 'root') { await rename(root, root + '.old'); await mkdir(root); await writeFile(join(root, 'secret.ts'), 'outside replacement content'); }\nif (change === 'parent') { await rename(join(root, 'dir'), join(root, 'dir-old')); await symlink(outside, join(root, 'dir')); }\n`);
    const wrapper = join(tools, 'git');
    await writeFile(wrapper, `#!/bin/sh\nset +e\n${shellQuote(git)} "$@" > ${shellQuote(output)}.$$ 2> ${shellQuote(errors)}.$$\nresult=$?\ncase "$*" in *"status --porcelain=v2"*) count=$(cat ${shellQuote(count)} 2>/dev/null || printf 0); count=$((count + 1)); printf '%s' "$count" > ${shellQuote(count)}; if [ "$count" -eq 2 ]; then ${shellQuote(node)} ${shellQuote(helper)} ${shellQuote(change)} ${shellQuote(root)} ${shellQuote(outside)}; fi ;; esac\ncat ${shellQuote(output)}.$$\ncat ${shellQuote(errors)}.$$ >&2\nexit "$result"\n`);
    await chmod(wrapper, 0o755);
    const canonicalRoot = await realpath(root);
    const previousPath = process.env.PATH ?? '/usr/bin:/bin';
    process.env.PATH = `${tools}:${previousPath}`;
    const engine = new InspectionEngine();
    try {
      await assert.rejects(
        engine.inspect({ version: 1, root: canonicalRoot, query: 'snapshotNeedle' }, { version: 1, root: canonicalRoot }),
        (error) => error.code === 'snapshot_changed',
      );
    } finally {
      await engine.close();
      process.env.PATH = previousPath;
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test('rejects an accepted source changed after final Git status capture', async () => {
  await fixture('source');
});

test('rejects a replaced repository root after final Git status capture', async () => {
  await fixture('root');
});

test('rejects an accepted parent replaced by a symlink after final Git status capture', async () => {
  await fixture('parent');
});
