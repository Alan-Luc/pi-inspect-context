import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const worker = fileURLToPath(new URL('../../src/worker/worker-process.ts', import.meta.url));
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'inspect-context-worker-')));
  const root = join(directory, 'root');
  mkdirSync(root);
  writeFileSync(join(root, 'needle.txt'), 'needle appears here\n');
  const manifest = join(directory, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, root }));
  chmodSync(manifest, 0o600);
  return { directory, root, manifest };
}
function run(input, manifest, args = []) {
  return spawnSync(process.execPath, ['--experimental-strip-types', worker, ...args], {
    input, encoding: 'utf8', env: { ...process.env, INSPECT_CONTEXT_MANIFEST: manifest }, timeout: 20_000,
  });
}
function request(root, query = 'needle') { return JSON.stringify({ version: 1, root, query }); }
function clean(fixture) { rmSync(fixture.directory, { recursive: true, force: true }); }

test('one-shot accepts pretty JSON and writes one compact bounded packet', () => {
  const f = fixture();
  try {
    const result = run(`{\n  "version": 1,\n  "root": ${JSON.stringify(f.root)},\n  "query": "needle"\n}`, f.manifest);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.endsWith('\n'), false);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.target.query, 'needle');
    assert.ok(packet.excerpts.some(item => item.path === 'needle.txt' && item.text === 'needle appears here\n'));
    assert.ok(Buffer.byteLength(result.stdout) <= 49_152);
  } finally { clean(f); }
});

test('session handles sequential requests through one subprocess', () => {
  const f = fixture();
  try {
    const result = run(`${request(f.root)}\n${request(f.root, 'appears')}\n`, f.manifest, ['--session']);
    assert.equal(result.status, 0, result.stderr);
    const packets = result.stdout.trimEnd().split('\n').map(JSON.parse);
    assert.deepEqual(packets.map(packet => packet.target.query), ['needle', 'appears']);
  } finally { clean(f); }
});

test('malformed, duplicate, and oversized input fail without stdout packets', () => {
  const f = fixture();
  try {
    for (const input of ['{', '{"version":1,"version":1}', `${' '.repeat(65_537)}`]) {
      const result = run(input, f.manifest);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.notEqual(result.stderr, '');
    }
  } finally { clean(f); }
});

test('unauthorized root and unsafe manifests fail closed', () => {
  const f = fixture();
  const other = join(f.directory, 'other');
  mkdirSync(other);
  try {
    const denied = run(request(other), f.manifest);
    assert.notEqual(denied.status, 0);
    assert.equal(denied.stdout, '');
    chmodSync(f.manifest, 0o644);
    const permissive = run(request(f.root), f.manifest);
    assert.notEqual(permissive.status, 0);
    assert.equal(permissive.stdout, '');
    chmodSync(f.manifest, 0o600);
    const link = join(f.directory, 'manifest-link');
    symlinkSync(f.manifest, link);
    const linked = run(request(f.root), link);
    assert.notEqual(linked.status, 0);
    assert.equal(linked.stdout, '');
  } finally { clean(f); }
});

test('empty one-shot EOF exits cleanly after authorization', () => {
  const f = fixture();
  try {
    const result = run('', f.manifest);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /protocol/i);
  } finally { clean(f); }
});
