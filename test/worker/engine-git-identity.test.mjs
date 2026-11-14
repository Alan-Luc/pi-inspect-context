import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InspectionEngine } from '../../src/worker/engine.ts';

test('rejects loss of the nested Git marker despite matching parent HEAD and status', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'inspect-nested-git-proof-')));
  const parent = join(scratch, 'parent');
  const nested = join(parent, 'nested');
  const tools = join(scratch, 'tools');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const environment = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (root, args) => execFileSync(realGit, ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd: root, env: environment, encoding: 'utf8' });
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  let engine;
  const previousPath = process.env.PATH;
  try {
    mkdirSync(parent);
    mkdirSync(tools);
    writeFileSync(join(parent, 'source.ts'), 'export function nestedSnapshotNeedle() { return "original"; }\n');
    writeFileSync(join(parent, '.gitignore'), 'nested/\n');
    git(parent, ['init', '--quiet']);
    git(parent, ['add', '.']);
    git(parent, ['-c', 'user.name=Snapshot Proof', '-c', 'user.email=snapshot@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    git(parent, ['clone', '--quiet', '--no-hardlinks', parent, nested]);
    assert.equal(git(parent, ['rev-parse', 'HEAD']), git(nested, ['rev-parse', 'HEAD']));
    assert.equal(git(nested, ['status', '--porcelain=v2']), '');
    const helper = join(scratch, 'mutate.mjs');
    writeFileSync(helper, `import { renameSync, writeFileSync } from 'node:fs';\nrenameSync(${JSON.stringify(join(nested, '.git'))}, ${JSON.stringify(join(scratch, 'saved-git'))});\nwriteFileSync(${JSON.stringify(join(nested, 'new.ts'))}, 'export function nestedSnapshotNeedle() { return "new"; }\\n');\n`);
    const wrapper = join(tools, 'git');
    writeFileSync(wrapper, `#!/bin/sh\n${quote(realGit)} "$@" > ${quote(join(scratch, 'output'))}.$$ 2> ${quote(join(scratch, 'errors'))}.$$\nresult=$?\ncase "$*" in *"grep --cached"*) if mkdir ${quote(join(scratch, 'mutated'))} 2>/dev/null; then ${quote(process.execPath)} ${quote(helper)}; fi ;; esac\ncat ${quote(join(scratch, 'output'))}.$$\ncat ${quote(join(scratch, 'errors'))}.$$ >&2\nexit "$result"\n`);
    chmodSync(wrapper, 0o755);
    process.env.PATH = `${tools}:${previousPath}`;
    engine = new InspectionEngine();
    const outcome = await engine.inspect({ version: 1, root: nested, query: 'nestedSnapshotNeedle' }, { version: 1, root: nested }).then(packet => ({ packet }), error => ({ error }));
    assert.equal(readFileSync(join(nested, 'new.ts'), 'utf8'), 'export function nestedSnapshotNeedle() { return "new"; }\n');
    assert.equal(git(nested, ['status', '--porcelain=v2']), '');
    assert.equal(git(nested, ['rev-parse', '--show-toplevel']).trim(), parent);
    assert.equal(outcome.error?.code, 'snapshot_changed', 'must reject Git identity transition to ignored parent repository');
  } finally {
    await engine?.close();
    process.env.PATH = previousPath;
    rmSync(scratch, { recursive: true, force: true });
  }
});
