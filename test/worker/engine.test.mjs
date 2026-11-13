import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { InspectionEngine } from '../../src/worker/engine.ts';
import { fixtureCases } from '../../bench/inspect-context.mjs';

const execute = promisify(execFile);

async function fixture(run) {
  const parent = await mkdtemp(join(tmpdir(), 'inspect-ts-engine-'));
  const requestedRoot = join(parent, 'repo');
  await mkdir(requestedRoot);
  const root = await realpath(requestedRoot);
  try { await run(root, parent); } finally { await rm(parent, { recursive: true, force: true }); }
}

test('omits missing sparse files while retaining present skip-worktree metadata', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'kept'));
    await mkdir(join(root, 'omitted'));
    await writeFile(join(root, 'kept', 'available.go'), 'package fixture\nfunc sparseNeedle() {}\n');
    await writeFile(join(root, 'omitted', 'absent.go'), 'package fixture\nfunc sparseNeedle() {}\n');
    await execute('git', ['init', '--quiet'], { cwd: root });
    await execute('git', ['add', '-A'], { cwd: root });
    await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial'], { cwd: root });
    await execute('git', ['sparse-checkout', 'set', '--cone', 'kept'], { cwd: root });
    const engine = new InspectionEngine();
    try {
      const packet = await engine.inspect({ version: 1, root, query: 'sparseNeedle' }, { version: 1, root });
      assert.ok(packet.excerpts.some(item => item.path === 'kept/available.go'));
      assert.ok(!packet.excerpts.some(item => item.path === 'omitted/absent.go'));
      assert.ok(packet.omissions.some(item => item.reason === 'ineligible_file' && item.examples?.includes('omitted/absent.go')));
    } finally { await engine.close(); }
  });
});

test('returns schema-shaped real evidence and rejects root authorization mismatch', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'service.ts'), 'export function loadAccount() { return true; }\n');
    const authorization = { version: 1, root };
    const engine = new InspectionEngine();
    try {
      const packet = await engine.inspect({ version: 1, root, query: 'loadAccount' }, authorization);
      assert.equal(packet.target.query, 'loadAccount');
      assert.ok(packet.excerpts.some((item) => item.path === 'service.ts' && item.text.includes('loadAccount')));
      assert.equal(packet.excerpts.find((item) => item.path === 'service.ts')?.bodyComplete, true);
      await assert.rejects(engine.inspect({ version: 1, root, query: 'loadAccount' }, { version: 1, root: root + '-other' }), /authorization/);
    } finally { await engine.close(); }
  });
});

test('retains every independently labeled public fixture fact', async () => {
  const base = fileURLToPath(new URL('../../bench/fixtures', import.meta.url));
  await fixture(async (_unused, parent) => {
    const engine = new InspectionEngine();
    try {
      for (const item of fixtureCases) {
        const destination = join(parent, item.id);
        await mkdir(destination);
        const root = await realpath(destination);
        await cp(join(base, item.root), root, { recursive: true });
        const packet = await engine.inspect({ version: 1, root, cwd: item.cwd, query: item.query }, { version: 1, root });
        for (const expected of item.expected) assert.ok(packet.excerpts.some((excerpt) => excerpt.path === expected.path && excerpt.startLine <= expected.line && excerpt.endLine >= expected.line && excerpt.kind === expected.kind), `${item.id} missing ${expected.path}:${expected.line} (${expected.kind})`);
      }
    } finally { await engine.close(); }
  });
});

test('uses repository fallback for a thin package and reports it as uncertain', async () => {
  await fixture(async (root) => {
    await mkdir(join(root, 'pkg'));
    await writeFile(join(root, 'pkg', 'package.json'), '{}');
    await writeFile(join(root, 'pkg', 'one.ts'), 'export function thinNeedle() {}\n');
    await writeFile(join(root, 'sibling.ts'), 'export function thinNeedle() {}\n');
    const engine = new InspectionEngine();
    try {
      const packet = await engine.inspect({ version: 1, root, cwd: 'pkg', query: 'thinNeedle' }, { version: 1, root });
      assert.ok(packet.excerpts.some((item) => item.path === 'sibling.ts'));
      assert.ok(packet.unknowns.includes('Thin package "pkg": repository fallback.'));
      assert.equal(packet.omissions.some((item) => item.reason === 'package_scope'), false);
    } finally { await engine.close(); }
  });
});

test('accounts for binary, invalid UTF-8, and oversized files', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'binary.txt'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 0x64]));
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0xff]));
    await writeFile(join(root, 'large.txt'), Buffer.alloc(65_537, 0x61));
    const engine = new InspectionEngine();
    try {
      const packet = await engine.inspect({ version: 1, root, query: 'needle' }, { version: 1, root });
      const reasons = new Map(packet.omissions.map((item) => [item.reason, item.count]));
      assert.equal(reasons.get('binary_file'), 1);
      assert.equal(reasons.get('invalid_utf8'), 1);
      assert.equal(reasons.get('oversized_file'), 1);
      assert.equal(packet.receipt.bytesRead, 15);
    } finally { await engine.close(); }
  });
});

test('rejects unsafe cwd and Unicode source names remain inspectable', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'café.ts'), 'export function caféNeedle() {}\n');
    const engine = new InspectionEngine();
    try {
      await assert.rejects(engine.inspect({ version: 1, root, cwd: '../outside', query: 'caféNeedle' }, { version: 1, root }), /cwd|unsafe/i);
      const packet = await engine.inspect({ version: 1, root, query: 'caféNeedle' }, { version: 1, root });
      assert.ok(packet.excerpts.some((item) => item.path === 'café.ts'));
    } finally { await engine.close(); }
  });
});

test('rejects final and ancestor candidate symlinks and a symlink-authorized root', async () => {
  await fixture(async (root, parent) => {
    const outside = join(parent, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.ts'), 'export function secretNeedle() {}\n');
    await symlink(outside, join(root, 'linked-directory'));
    const engine = new InspectionEngine();
    try {
      await assert.rejects(engine.inspect({ version: 1, root, query: 'secretNeedle' }, { version: 1, root }), /symlink/i);
      const alias = join(parent, 'root-alias');
      await symlink(root, alias);
      await assert.rejects(engine.inspect({ version: 1, root: alias, query: 'secretNeedle' }, { version: 1, root: alias }), /canonical|symlink/i);
    } finally { await engine.close(); }
  });
});

test('rejects symlink candidates instead of reading outside content', async () => {
  await fixture(async (root, parent) => {
    await writeFile(join(parent, 'secret.ts'), 'export function secretNeedle() {}\n');
    await symlink(join(parent, 'secret.ts'), join(root, 'linked.ts'));
    const engine = new InspectionEngine();
    try {
      await assert.rejects(engine.inspect({ version: 1, root, query: 'secretNeedle' }, { version: 1, root }), /symlink|snapshot/i);
    } finally { await engine.close(); }
  });
});
