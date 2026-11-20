import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InspectionEngine } from '../../src/worker/engine.ts';
import { FileFinder } from '@ff-labs/fff-node';
import { MAX_AGGREGATE_READ_BYTES, MAX_DISCOVERED_FILES, MAX_FILE_BYTES, MAX_OVERSIZED_SCAN_BYTES } from '../../src/packet.ts';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inspect-resident-')));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'needle.ts'), 'export function residentNeedle() { return "fresh"; }\n');
  return root;
}

async function gitFixture() {
  const root = await fixture();
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '--', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Resident Test', '-c', 'user.email=resident@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  return root;
}

async function committedFixture(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inspect-coverage-')));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Resident Test', '-c', 'user.email=resident@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  return root;
}

async function withGitSpy(run) {
  const original = cp.spawn;
  const calls = [];
  cp.spawn = (file, args, options) => {
    calls.push(args);
    return original(file, args, options);
  };
  syncBuiltinESMExports();
  try { await run(calls); }
  finally { cp.spawn = original; syncBuiltinESMExports(); }
}

function finderHarness({ failCreate = false, failSearch = false, ready = true, readiness = Promise.resolve(ready), paths = ['src/needle.ts'], indexedPaths = paths, resultMetadata = { totalFiles: 1, filteredFileCount: 1, totalFilesSearched: 1, nextCursor: null }, onSearch, onReady } = {}) {
  const calls = { created: [], searched: [], destroyed: 0 };
  const createFinder = (options) => {
    calls.created.push(options);
    if (failCreate === 'throw') throw new Error('private native load detail');
    if (failCreate) return { ok: false, error: 'private native detail' };
    return { ok: true, value: {
      isScanning: () => false,
      waitForIndexReady: async () => { onReady?.(); return { ok: true, value: await readiness }; },
      getScanProgress: () => ({ ok: true, value: { isScanning: false, isWatcherReady: ready, isWarmupComplete: ready } }),
      glob: () => ({ ok: true, value: { items: [...new Set(indexedPaths)].map(relativePath => ({ relativePath })) } }),
      multiGrep(options) {
        calls.searched.push(options);
        onSearch?.();
        if (failSearch) return { ok: false, error: 'private search detail' };
        return { ok: true, value: { items: paths.map(relativePath => ({ relativePath, lineContent: 'forgedNeedle', lineNumber: 900, isDefinition: true })), ...resultMetadata } };
      },
      destroy() { calls.destroyed++; },
    } };
  };
  return { calls, createFinder };
}

test('reuses one root-bound finder and derives evidence from fresh anchored source', async () => {
  const root = await gitFixture();
  const harness = finderHarness();
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    const inspect = () => engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root });
    const first = await inspect();
    const second = await inspect();
    assert.equal(harness.calls.created.length, 1);
    assert.equal(harness.calls.searched.length, 2);
    assert.ok(first.excerpts.some(item => item.path === 'src/needle.ts' && item.text.includes('residentNeedle')));
    assert.ok(!JSON.stringify(first).includes('forgedNeedle'));
    assert.deepEqual(harness.calls.created[0], { basePath: root, followSymlinks: false, disableMmapCache: true, disableContentIndexing: true });
    assert.equal(harness.calls.searched[0].enforceTimeBudget, true);
    assert.equal(harness.calls.searched[0].smartCase, true);
    assert.equal(harness.calls.searched[0].pageSize, 64);
    assert.equal(harness.calls.searched[0].maxFileSize, MAX_OVERSIZED_SCAN_BYTES);
    assert.equal(harness.calls.searched[0].maxMatchesPerFile, 1);
    assert.equal(harness.calls.searched[0].beforeContext, 0);
    assert.equal(harness.calls.searched[0].afterContext, 0);
    assert.equal(harness.calls.searched[0].classifyDefinitions, false);
    assert.ok(second.excerpts.length);
  } finally {
    await engine.close();
    assert.equal(harness.calls.destroyed, 1);
    await rm(root, { recursive: true, force: true });
  }
});

test('falls back when native readiness is incomplete', async () => {
  const root = await gitFixture();
  const harness = finderHarness({ ready: false });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    await withGitSpy(async calls => {
      const packet = await engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root });
      assert.ok(packet.excerpts.some(item => item.path === 'src/needle.ts'));
      assert.equal(harness.calls.searched.length, 0);
      assert.ok(calls.some(args => args.includes('grep')));
    });
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('waits for an active inspection before destroying the finder on close', async () => {
  const root = await gitFixture();
  let finishReadiness;
  const readiness = new Promise(resolveReady => { finishReadiness = resolveReady; });
  const harness = finderHarness({ readiness });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  const pending = engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root });
  const closing = engine.close();
  await Promise.resolve();
  assert.equal(harness.calls.destroyed, 0);
  finishReadiness(true);
  try {
    await pending;
    await closing;
    assert.equal(harness.calls.destroyed, 1);
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('serializes a pending ready finder across concurrent root switches', async () => {
  const firstRoot = await gitFixture();
  const secondRoot = await gitFixture();
  let finishReadiness;
  let enteredReadiness;
  const readiness = new Promise(resolveReady => { finishReadiness = resolveReady; });
  const entered = new Promise(resolveEntered => { enteredReadiness = resolveEntered; });
  const harness = finderHarness({ readiness, onReady: enteredReadiness });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    const first = engine.inspect({ version: 1, root: firstRoot, query: 'residentNeedle' }, { version: 1, root: firstRoot });
    await entered;
    const second = engine.inspect({ version: 1, root: secondRoot, query: 'residentNeedle' }, { version: 1, root: secondRoot });
    assert.equal(harness.calls.created.length, 1);
    finishReadiness(true);
    const [firstPacket, secondPacket] = await Promise.all([first, second]);
    assert.ok(firstPacket.excerpts.some(item => item.path === 'src/needle.ts'));
    assert.ok(secondPacket.excerpts.some(item => item.path === 'src/needle.ts'));
    assert.deepEqual(harness.calls.created.map(options => options.basePath), [firstRoot, secondRoot]);
    assert.equal(harness.calls.destroyed, 1);
  } finally { await engine.close(); await rm(firstRoot, { recursive: true, force: true }); await rm(secondRoot, { recursive: true, force: true }); }
});

test('surfaces sanitized finder cleanup errors while closing the engine', async () => {
  const root = await gitFixture();
  const harness = finderHarness();
  const original = harness.createFinder;
  harness.createFinder = options => {
    const result = original(options);
    if (result.ok) result.value.destroy = () => { throw new Error('private native teardown'); };
    return result;
  };
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    await engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root });
    await assert.rejects(engine.close(), error => error.code === 'cleanup' && !error.message.includes('private native teardown'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('destroys the prior finder when the root inode changes', async () => {
  const root = await gitFixture();
  const moved = `${root}.old`;
  const harness = finderHarness();
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    const inspect = () => engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root });
    await inspect();
    await rename(root, moved);
    await mkdir(root);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'needle.ts'), 'export function residentNeedle() { return "replacement"; }\n');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '--', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Resident Test', '-c', 'user.email=resident@example.invalid', 'commit', '--quiet', '-m', 'replacement'], { cwd: root });
    await inspect();
    assert.equal(harness.calls.created.length, 2);
    assert.equal(harness.calls.destroyed, 1);
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true }); }
});

test('falls back when native search returns an error', async () => {
  const root = await gitFixture();
  const harness = finderHarness({ failSearch: true });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    await withGitSpy(async calls => {
      const packet = await engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root });
      assert.ok(packet.excerpts.some(item => item.path === 'src/needle.ts'));
      assert.equal(JSON.stringify(packet).includes('private search detail'), false);
      assert.ok(calls.some(args => args.includes('grep')));
    });
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('rejects symlink and outside native nominations while preserving admitted source evidence', async () => {
  const root = await fixture();
  const outside = `${root}.secret.ts`;
  await writeFile(outside, 'export function residentNeedle() { return "outside secret"; }\n');
  await rename(join(root, 'src', 'needle.ts'), join(root, 'safe.ts'));
  await rm(join(root, 'src'), { recursive: true, force: true });
  await symlink(outside, join(root, 'link.ts'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '--', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Resident Test', '-c', 'user.email=resident@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const harness = finderHarness({ paths: ['link.ts', '../secret.ts', 'safe.ts'], indexedPaths: ['link.ts', 'safe.ts'], resultMetadata: { totalFiles: 2, filteredFileCount: 2, totalFilesSearched: 2, nextCursor: null } });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    await withGitSpy(async calls => {
      const packet = await engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root });
      assert.equal(calls.filter(args => args.includes('grep')).length, 0);
      assert.ok(packet.excerpts.some(item => item.path === 'safe.ts' && item.text.includes('residentNeedle')));
      assert.ok(!JSON.stringify(packet).includes('outside secret'));
      assert.ok(!packet.excerpts.some(item => item.path === 'link.ts'));
    });
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { force: true }); }
});

test('destroys the finder after root replacement invalidates the active snapshot', async () => {
  const root = await gitFixture();
  const moved = `${root}.old`;
  const harness = finderHarness({ onSearch: () => {
    renameSync(root, moved);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'needle.ts'), 'replacement root content\n');
  } });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    await withGitSpy(async calls => {
      await assert.rejects(engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root }), error => error.code === 'snapshot_changed');
      assert.equal(calls.filter(args => args.includes('grep')).length, 0);
    });
    assert.equal(harness.calls.destroyed, 1);
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true }); }
});

test('rejects a tracked source mutation after real native nomination', async () => {
  const root = await gitFixture();
  const created = FileFinder.create({ basePath: root, followSymlinks: false, disableMmapCache: true, disableContentIndexing: true });
  assert.equal(created.ok, true);
  try {
    const ready = await created.value.waitForIndexReady(5000);
    assert.equal(ready.ok && ready.value, true);
    for (let attempt = 0; attempt < 100 && !created.value.getScanProgress().value?.isWatcherReady; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(created.value.getScanProgress().value?.isWatcherReady, true);
    const nativeMultiGrep = created.value.multiGrep.bind(created.value);
    created.value.multiGrep = options => {
      const result = nativeMultiGrep(options);
      writeFileSync(join(root, 'src', 'needle.ts'), 'export function residentNeedle() { return "mutated"; }\n');
      return result;
    };
    const engine = new InspectionEngine({ createFinder: () => created });
    try {
      await withGitSpy(async calls => {
        await assert.rejects(engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root }), error => error.code === 'snapshot_changed');
        assert.equal(calls.filter(args => args.includes('grep')).length, 0);
      });
      assert.ok(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).includes('src/needle.ts'));
    } finally { await engine.close(); }
  } finally { if (!created.value.isDestroyed) created.value.destroy(); await rm(root, { recursive: true, force: true }); }
});

test('uses native Git nominations without running Git grep or reading a path twice', async () => {
  const root = await gitFixture();
  const source = 'export function residentNeedle() { return "fresh"; }\n';
  const harness = finderHarness({ paths: ['src/needle.ts', 'src/needle.ts'] });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    await withGitSpy(async calls => {
      const packet = await engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root });
      assert.equal(calls.filter(args => args.includes('grep')).length, 0);
      assert.equal(packet.receipt.readFiles, 1);
      assert.equal(packet.receipt.bytesRead, Buffer.byteLength(source));
      assert.ok(packet.excerpts.some(item => item.path === 'src/needle.ts' && item.startLine === 1 && item.text === source));
      assert.ok(packet.definitions.some(item => item.path === 'src/needle.ts' && item.startLine === 1));
    });
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('uses fresh dirty and untracked source ahead of stale native nominations', async () => {
  const root = await gitFixture();
  const dirty = 'export function dirtyFreshNeedle() { return "worktree"; }\n';
  const untracked = 'export function untrackedFreshNeedle() { return "new"; }\n';
  await writeFile(join(root, 'src', 'needle.ts'), dirty);
  await writeFile(join(root, 'fresh-untracked.ts'), untracked);
  const harness = finderHarness({ paths: ['src/needle.ts'] });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    await withGitSpy(async calls => {
      const packet = await engine.inspect({ version: 1, root, query: 'dirtyFreshNeedle untrackedFreshNeedle' }, { version: 1, root });
      assert.equal(calls.filter(args => args.includes('grep')).length, 0);
      assert.equal(harness.calls.searched.length, 1);
      assert.equal(packet.receipt.readFiles, 2);
      assert.equal(packet.receipt.bytesRead, Buffer.byteLength(dirty) + Buffer.byteLength(untracked));
      assert.ok(packet.excerpts.some(item => item.path === 'src/needle.ts' && item.text === dirty));
      assert.ok(packet.excerpts.some(item => item.path === 'fresh-untracked.ts' && item.text === untracked));
    });
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('retains repository candidates for scoped requests', async () => {
  const root = await gitFixture();
  await mkdir(join(root, 'pkg', 'src'), { recursive: true });
  await writeFile(join(root, 'pkg', 'package.json'), '{"name":"pkg"}\n');
  await writeFile(join(root, 'pkg', 'src', 'stale.ts'), 'export const unrelated = 1;\n');
  await writeFile(join(root, 'repositoryNeedle.ts'), 'export function repositoryNeedle() { return "fresh"; }\n');
  execFileSync('git', ['add', '--', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Resident Test', '-c', 'user.email=resident@example.invalid', 'commit', '--quiet', '-m', 'scope fixture'], { cwd: root });
  const harness = finderHarness({ paths: ['repositoryNeedle.ts'], indexedPaths: ['src/needle.ts', 'pkg/package.json', 'pkg/src/stale.ts', 'repositoryNeedle.ts'], resultMetadata: { totalFiles: 4, filteredFileCount: 4, totalFilesSearched: 4, nextCursor: null } });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    await withGitSpy(async calls => {
      const packet = await engine.inspect({ version: 1, root, cwd: 'pkg/src', query: 'repositoryNeedle' }, { version: 1, root });
      assert.equal(harness.calls.searched.length, 1);
      assert.equal(harness.calls.searched[0].constraints, undefined);
      assert.equal(calls.filter(args => args.includes('grep')).length, 0);
      assert.ok(packet.excerpts.some(item => item.path === 'repositoryNeedle.ts' && item.text.includes('repositoryNeedle')));
    });
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('uses the installed stock finder for native success on a committed Git repository', async () => {
  const root = await gitFixture();
  const engine = new InspectionEngine();
  try {
    let nativePacket;
    for (let attempt = 0; attempt < 4 && !nativePacket; attempt++) {
      await withGitSpy(async calls => {
        const packet = await engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root });
        if (!calls.some(args => args.includes('grep'))) nativePacket = packet;
      });
    }
    assert.ok(nativePacket, 'stock native search never became ready within bounded attempts');
    assert.equal(nativePacket.receipt.readFiles, 1);
    assert.equal(nativePacket.receipt.bytesRead, Buffer.byteLength('export function residentNeedle() { return "fresh"; }\n'));
    assert.ok(nativePacket.excerpts.some(item => item.path === 'src/needle.ts' && item.startLine === 1 && item.text === 'export function residentNeedle() { return "fresh"; }\n'));
    assert.ok(nativePacket.definitions.some(item => item.path === 'src/needle.ts' && item.startLine === 1));
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('uses Git fallback when finder loading throws', async () => {
  const root = await gitFixture();
  const harness = finderHarness({ failCreate: 'throw' });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    await withGitSpy(async calls => {
      const packet = await engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root });
      assert.ok(packet.excerpts.some(item => item.path === 'src/needle.ts'));
      assert.ok(calls.some(args => args.includes('grep')));
      assert.equal(JSON.stringify(packet).includes('private native load detail'), false);
    });
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('uses Git fallback when native creation fails', async () => {
  const root = await gitFixture();
  const harness = finderHarness({ failCreate: true });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    await withGitSpy(async calls => {
      const packet = await engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root });
      assert.ok(packet.excerpts.some(item => item.path === 'src/needle.ts'));
      assert.equal(JSON.stringify(packet).includes('private native detail'), false);
      assert.ok(calls.some(args => args.includes('grep')));
    });
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('keeps lowercase camel-case matches in real stock native search', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inspect-case-')));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'src', 'store.ts'), 'export function loadUserProfile() {}\\n');
  await writeFile(join(root, 'docs', 'notes.md'), 'profile\\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Resident Test', '-c', 'user.email=resident@example.invalid', 'commit', '--quiet', '-m', 'case fixture'], { cwd: root });
  const native = FileFinder.create({ basePath: root, followSymlinks: false, disableMmapCache: true, disableContentIndexing: true });
  assert.equal(native.ok, true);
  const ready = await native.value.waitForIndexReady(5000);
  assert.equal(ready.ok && ready.value, true);
  for (let attempt = 0; attempt < 100 && !native.value.getScanProgress().value?.isWatcherReady; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const engine = new InspectionEngine({ createFinder: () => native });
  try {
    for (const query of ['profile', 'PROFILE', 'pRoFiLe']) {
      const packet = await engine.inspect({ version: 1, root, query }, { version: 1, root });
      assert.ok(packet.excerpts.some(item => item.path === 'src/store.ts'), `${query} must retain case-insensitive definition coverage`);
      assert.ok(packet.excerpts.some(item => item.path === 'docs/notes.md'));
    }
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('keeps native and path-only candidates within one clean-read budget', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inspect-clean-cap-')));
  const nominated = [];
  await mkdir(join(root, 'src'));
  for (let index = 0; index < 64; index++) {
    const path = `src/content-${String(index).padStart(3, '0')}.ts`;
    nominated.push(path);
    await writeFile(join(root, path), `export function boundNeedle${index}() {}\\n`);
    await writeFile(join(root, `boundNeedle-path-${String(index).padStart(3, '0')}.ts`), `export const unrelated${index} = 0;\\n`);
  }
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Resident Test', '-c', 'user.email=resident@example.invalid', 'commit', '--quiet', '-m', 'cap fixture'], { cwd: root });
  const harness = finderHarness({ paths: nominated, indexedPaths: [...nominated, ...Array.from({ length: 64 }, (_, index) => `boundNeedle-path-${String(index).padStart(3, '0')}.ts`)], resultMetadata: { totalFiles: 128, filteredFileCount: 128, totalFilesSearched: 128, nextCursor: null } });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    const packet = await engine.inspect({ version: 1, root, query: 'boundNeedle' }, { version: 1, root });
    assert.ok(packet.receipt.readFiles <= 64, 'native and path-only admissions share the 64-clean-candidate cap');
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('retains shared definitions after a useful scoped hit', async () => {
  const root = await committedFixture({
    'pkg/package.json': '{"name":"pkg"}\\n',
    'pkg/src/caller.ts': 'export function caller() { return sharedNeedle(); }\\n',
    'shared/source.ts': 'export function sharedNeedle() { return 1; }\\n',
  });
  const createFinder = () => ({ ok: true, value: {
    isScanning: () => false,
    waitForIndexReady: async () => ({ ok: true, value: true }),
    getScanProgress: () => ({ ok: true, value: { isScanning: false, isWatcherReady: true, isWarmupComplete: true } }),
    glob: () => ({ ok: true, value: { items: ['pkg/package.json', 'pkg/src/caller.ts', 'shared/source.ts'].map(relativePath => ({ relativePath })) } }),
    multiGrep: options => ({ ok: true, value: {
      items: (options.constraints ? ['pkg/src/caller.ts'] : ['pkg/src/caller.ts', 'shared/source.ts']).map(relativePath => ({ relativePath })),
      totalFiles: 3, filteredFileCount: 3, totalFilesSearched: 3, nextCursor: null,
    } }),
    destroy() {},
  } });
  const engine = new InspectionEngine({ createFinder });
  try {
    const packet = await engine.inspect({ version: 1, root, cwd: 'pkg/src', query: 'sharedNeedle' }, { version: 1, root });
    assert.ok(packet.excerpts.some(item => item.path === 'shared/source.ts'));
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('falls back after a partial native page to retain the rare-term candidate', async () => {
  const files = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`src/a-${String(index).padStart(3, '0')}.ts`, `export function pageNeedle${index}() {}\\n`]));
  files['src/z.ts'] = 'export function pageNeedle() { return rareTerm; }\\n';
  const root = await committedFixture(files);
  const createFinder = () => ({ ok: true, value: {
    isScanning: () => false,
    waitForIndexReady: async () => ({ ok: true, value: true }),
    getScanProgress: () => ({ ok: true, value: { isScanning: false, isWatcherReady: true, isWarmupComplete: true } }),
    glob: () => ({ ok: true, value: { items: Object.keys(files).map(relativePath => ({ relativePath })) } }),
    multiGrep: () => ({ ok: true, value: {
      items: Object.keys(files).filter(path => path !== 'src/z.ts').map(relativePath => ({ relativePath })),
      totalFiles: 65, filteredFileCount: 65, totalFilesSearched: 64, nextCursor: { _offset: 64 },
    } }),
    destroy() {},
  } });
  const engine = new InspectionEngine({ createFinder });
  try {
    const packet = await engine.inspect({ version: 1, root, query: 'pageNeedle rareTerm' }, { version: 1, root });
    assert.ok(packet.excerpts.some(item => item.path === 'src/z.ts'));
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('falls back when native filtering would hide an oversized-file omission', async () => {
  const root = await committedFixture({ 'src/small.ts': 'sizeNeedle\\n', 'src/big.ts': `sizeNeedle\\n${'x'.repeat(MAX_FILE_BYTES)}` });
  const harness = finderHarness({ paths: ['src/small.ts'], indexedPaths: ['src/small.ts', 'src/big.ts'], resultMetadata: { totalFiles: 2, filteredFileCount: 1, totalFilesSearched: 1, nextCursor: null } });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    const packet = await engine.inspect({ version: 1, root, query: 'sizeNeedle' }, { version: 1, root });
    assert.ok(packet.omissions.some(item => item.reason === 'oversized_file' && item.examples?.includes('src/big.ts')));
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('recreates native discovery after a committed revision changes', async () => {
  const root = await committedFixture({ 'src/a.ts': 'export function freshnessNeedle() {}\\n' });
  const created = [];
  const createFinder = () => {
    const revision = created.length;
    const paths = revision ? ['src/a.ts', 'src/z.ts'] : ['src/a.ts'];
    const totalFiles = revision ? 2 : 1;
    const finder = finderHarness({ paths, indexedPaths: paths, resultMetadata: { totalFiles, filteredFileCount: totalFiles, totalFilesSearched: totalFiles, nextCursor: null } }).createFinder({});
    created.push(finder.value);
    return finder;
  };
  const engine = new InspectionEngine({ createFinder });
  try {
    await engine.inspect({ version: 1, root, query: 'freshnessNeedle rareTerm' }, { version: 1, root });
    await writeFile(join(root, 'src/z.ts'), 'export function freshnessNeedle() { return rareTerm; }\\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Resident Test', '-c', 'user.email=resident@example.invalid', 'commit', '--quiet', '-m', 'new native candidate'], { cwd: root });
    const packet = await engine.inspect({ version: 1, root, query: 'freshnessNeedle rareTerm' }, { version: 1, root });
    assert.equal(created.length, 2);
    assert.ok(packet.excerpts.some(item => item.path === 'src/z.ts'));
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('falls back when excluded native paths compensate for a missing tracked source', async () => {
  const root = await committedFixture({
    '.gitignore': 'src/tracked-ignored.ts\n',
    'src/visible.ts': 'export function visibleNeedle() {}\n',
    'src/tracked-ignored.ts': 'export function rareTrackedNeedle() {}\n',
    '.claude/policy.md': 'visibleNeedle rareTrackedNeedle EXCLUDED_POLICY_SENTINEL\n',
  });
  let engine;
  let native;
  try {
    execFileSync('git', ['add', '-f', '--', 'src/tracked-ignored.ts'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Resident Test', '-c', 'user.email=resident@example.invalid', 'commit', '--quiet', '-m', 'tracked ignored source'], { cwd: root });
    native = FileFinder.create({ basePath: root, followSymlinks: false, disableMmapCache: true, disableContentIndexing: true });
    assert.equal(native.ok, true);
    const ready = await native.value.waitForIndexReady(5000);
    assert.equal(ready.ok && ready.value, true);
    for (let attempt = 0; attempt < 100 && !native.value.getScanProgress().value?.isWatcherReady; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(native.value.getScanProgress().value?.isWatcherReady, true);
    engine = new InspectionEngine({ createFinder: () => native });
    await withGitSpy(async calls => {
      const packet = await engine.inspect({ version: 1, root, query: 'visibleNeedle rareTrackedNeedle' }, { version: 1, root });
      assert.ok(packet.excerpts.some(item => item.path === 'src/visible.ts'));
      assert.ok(packet.excerpts.some(item => item.path === 'src/tracked-ignored.ts'), 'native index counts cannot conceal a missing tracked source');
      assert.ok(packet.excerpts.every(item => !item.path.startsWith('.claude/') && !item.text.includes('EXCLUDED_POLICY_SENTINEL')));
      assert.ok(calls.some(args => args.includes('grep')), 'incomplete native inventory must select Git fallback');
    });
  } finally {
    try { await engine?.close(); }
    finally {
      if (native?.ok && !native.value.isDestroyed) native.value.destroy();
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  }
});

test('skips native initialization when excluded paths exceed the inventory budget', async () => {
  const root = await gitFixture();
  const harness = finderHarness({ failCreate: true });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    await mkdir(join(root, 'vendor'));
    for (let index = 0; index < MAX_DISCOVERED_FILES; index++) writeFileSync(join(root, 'vendor', `dependency-${index}.ts`), 'export const dependency = 1;\n');
    execFileSync('git', ['add', '--', 'vendor'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Resident Test', '-c', 'user.email=resident@example.invalid', 'commit', '--quiet', '-m', 'vendor fixture'], { cwd: root });
    const packet = await engine.inspect({ version: 1, root, query: 'residentNeedle' }, { version: 1, root });
    assert.ok(packet.excerpts.some(item => item.path === 'src/needle.ts'));
    assert.equal(harness.calls.created.length, 0, 'excluded inventory entries must prevent native initialization');
  } finally { await engine.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }); }
});

test('preserves ranked rare-term evidence when dirty files leave one clean-file byte budget', async () => {
  const root = await gitFixture();
  const dirtyPaths = Array.from({ length: Math.floor(MAX_AGGREGATE_READ_BYTES / MAX_FILE_BYTES) - 1 }, (_, index) => `src/dirty-${index}.ts`);
  const cleanPaths = ['src/a.ts', 'src/z.ts'];
  const indexedPaths = ['src/needle.ts', ...dirtyPaths, ...cleanPaths];
  const harness = finderHarness({ paths: cleanPaths, indexedPaths, resultMetadata: { totalFiles: indexedPaths.length, filteredFileCount: indexedPaths.length, totalFilesSearched: indexedPaths.length, nextCursor: null } });
  const engine = new InspectionEngine({ createFinder: harness.createFinder });
  try {
    for (const path of dirtyPaths) await writeFile(join(root, path), 'export const unrelated = 0;\n'.padEnd(MAX_FILE_BYTES, ' '));
    await writeFile(join(root, cleanPaths[0]), 'export function commonNeedle() { return 0; }\n'.padEnd(MAX_FILE_BYTES, ' '));
    await writeFile(join(root, cleanPaths[1]), 'export function commonNeedle() { return rareTerm; }\n'.padEnd(MAX_FILE_BYTES, ' '));
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Resident Test', '-c', 'user.email=resident@example.invalid', 'commit', '--quiet', '-m', 'byte budget fixture'], { cwd: root });
    for (const path of dirtyPaths) await writeFile(join(root, path), 'export const unrelated = 1;\n'.padEnd(MAX_FILE_BYTES, ' '));
    await withGitSpy(async calls => {
      const packet = await engine.inspect({ version: 1, root, query: 'commonNeedle rareTerm' }, { version: 1, root });
      assert.ok(packet.excerpts.some(item => item.path === 'src/z.ts' && item.text.includes('rareTerm')), 'native admission must not spend the remaining bytes before ranked rare-term evidence');
      assert.ok(calls.some(args => args.includes('grep')), 'insufficient byte capacity must retain ranked Git admission');
      assert.ok(packet.receipt.bytesRead <= MAX_AGGREGATE_READ_BYTES);
    });
  } finally { await engine.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }); }
});
