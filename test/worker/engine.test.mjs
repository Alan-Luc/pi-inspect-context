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
      assert.equal(packet.receipt.bytesRead, 15 + 65_537);
    } finally { await engine.close(); }
  });
});

function oversizedSource(definitionLine, filler = 'const filler = 1;\n') {
  const lines = Array.from({ length: 4000 }, () => filler);
  lines[definitionLine - 1] = 'export function oversizedNeedle() {\n';
  return lines.join('');
}

test('excerpts a match inside an oversized file with its true line number', async () => {
  await fixture(async (root) => {
    const source = oversizedSource(1500);
    assert.ok(Buffer.byteLength(source) > 65_536);
    await writeFile(join(root, 'big.ts'), source);
    const engine = new InspectionEngine();
    try {
      const packet = await engine.inspect({ version: 1, root, query: 'oversizedNeedle' }, { version: 1, root });
      const found = packet.excerpts.find((item) => item.path === 'big.ts');
      assert.ok(found, 'oversized file must produce an excerpt');
      assert.ok(found.startLine <= 1500 && found.endLine >= 1500);
      assert.equal(found.text.split('\n')[1500 - found.startLine], 'export function oversizedNeedle() {');
      assert.equal(found.bodyComplete, false);
      assert.notEqual(packet.unknowns[0], 'No lexical matches; retry with an exact symbol, route, config key, or path fragment.');
    } finally { await engine.close(); }
  });
});

test('oversized excerpts keep every text line at its true line number', async () => {
  await fixture(async (root) => {
    const source = oversizedSource(5).split('\n').map((line, index) => line === 'const filler = 1;' ? `const filler${index + 1} = 1;` : line).join('\n');
    await writeFile(join(root, 'big.ts'), source);
    const actual = source.split('\n');
    const engine = new InspectionEngine();
    try {
      const packet = await engine.inspect({ version: 1, root, query: 'big oversizedNeedle' }, { version: 1, root });
      const excerpts = packet.excerpts.filter((item) => item.path === 'big.ts');
      assert.ok(excerpts.length > 0);
      for (const excerpt of excerpts) {
        excerpt.text.split('\n').forEach((line, offset) => { if (line) assert.equal(line, actual[excerpt.startLine - 1 + offset], `${excerpt.kind} ${excerpt.startLine}+${offset}`); });
      }
    } finally { await engine.close(); }
  });
});

test('stops scanning oversized files once the per-request oversized budget is spent', async () => {
  await fixture(async (root) => {
    const source = oversizedSource(1500, 'const fillerValue = 1; // padding padding padding\n');
    assert.ok(Buffer.byteLength(source) > 180_000 && Buffer.byteLength(source) < 262_144);
    for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await writeFile(join(root, name), source);
    const engine = new InspectionEngine();
    try {
      const packet = await engine.inspect({ version: 1, root, query: 'oversizedNeedle' }, { version: 1, root });
      assert.deepEqual([...new Set(packet.excerpts.map((item) => item.path))].sort(), ['a.ts', 'b.ts']);
      assert.equal(packet.omissions.find((item) => item.reason === 'oversized_file')?.count, 2);
      assert.ok(packet.receipt.bytesRead <= 524_288);
    } finally { await engine.close(); }
  });
});

test('excerpts an oversized tracked file in a Git repository', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'big.ts'), oversizedSource(3000));
    await execute('git', ['init', '--quiet'], { cwd: root });
    await execute('git', ['add', '-A'], { cwd: root });
    await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial'], { cwd: root });
    const engine = new InspectionEngine();
    try {
      const packet = await engine.inspect({ version: 1, root, query: 'oversizedNeedle' }, { version: 1, root });
      assert.ok(packet.excerpts.some((item) => item.path === 'big.ts' && item.startLine <= 3000 && item.endLine >= 3000));
    } finally { await engine.close(); }
  });
});

test('omits oversized files that are binary, undecodable, beyond the scan cap, or one huge line', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'binary.bin'), Buffer.concat([Buffer.from('oversizedNeedle\0'), Buffer.alloc(70_000, 0x61)]));
    await writeFile(join(root, 'invalid.txt'), Buffer.concat([Buffer.from('oversizedNeedle\n'), Buffer.alloc(70_000, 0xff)]));
    await writeFile(join(root, 'huge.txt'), Buffer.alloc(1_048_577, 0x61));
    await writeFile(join(root, 'line.js'), `oversizedNeedle ${'a'.repeat(70_000)}`);
    const engine = new InspectionEngine();
    try {
      const packet = await engine.inspect({ version: 1, root, query: 'oversizedNeedle' }, { version: 1, root });
      assert.equal(packet.excerpts.length, 0);
      assert.equal(packet.omissions.find((item) => item.reason === 'oversized_file')?.count, 4);
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

test('ignores untracked symlinks under excluded directories while keeping real candidates', async () => {
  await fixture(async (root, parent) => {
    await writeFile(join(parent, 'elsewhere.md'), 'outside\n');
    await writeFile(join(root, 'source.ts'), 'export function keptNeedle() {}\n');
    await mkdir(join(root, '.harness', 'reports'), { recursive: true });
    await symlink(join(parent, 'elsewhere.md'), join(root, '.harness', 'reports', 'x.md'));
    await execute('git', ['init', '--quiet'], { cwd: root });
    await execute('git', ['add', 'source.ts'], { cwd: root });
    await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial'], { cwd: root });
    const engine = new InspectionEngine();
    try {
      const packet = await engine.inspect({ version: 1, root, query: 'keptNeedle' }, { version: 1, root });
      assert.ok(packet.excerpts.some(item => item.path === 'source.ts'));
    } finally { await engine.close(); }
  });
});

for (const { query, pattern } of [{ query: 'DIAL_ID', pattern: 'dial_id\n' }, { query: 'WebSocketHeaders', pattern: 'websocketheaders\n' }]) {
  test(`sends Git grep the lowercase pattern for ${query} and keeps case-insensitive matches`, async () => {
    await fixture(async root => {
      await writeFile(join(root, 'upper.py'), `VALUE = "${query.toUpperCase()}"\n`);
      await writeFile(join(root, 'lower.py'), `value = "${query.toLowerCase()}"\n`);
      await execute('git', ['init', '--quiet'], { cwd: root });
      await execute('git', ['add', '-A'], { cwd: root });
      await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial'], { cwd: root });
      const childProcess = await import('node:child_process');
      const { syncBuiltinESMExports } = await import('node:module');
      const original = childProcess.default.spawn;
      const grepInputs = [];
      childProcess.default.spawn = (file, args, options) => {
        const child = original(file, args, options);
        if (args.includes('grep')) {
          const end = child.stdin.end.bind(child.stdin);
          child.stdin.end = (chunk, ...rest) => { grepInputs.push(String(chunk)); return end(chunk, ...rest); };
        }
        return child;
      };
      syncBuiltinESMExports();
      const engine = new InspectionEngine();
      try {
        const packet = await engine.inspect({ version: 1, root, query }, { version: 1, root });
        assert.deepEqual(grepInputs, [pattern]);
        assert.deepEqual(packet.excerpts.map(item => item.path).sort(), ['lower.py', 'upper.py']);
      } finally {
        childProcess.default.spawn = original;
        syncBuiltinESMExports();
        await engine.close();
      }
    });
  });
}

test('starts a Git grep for every search term before any of them finishes', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'source.py'), 'alpha bravo charlie delta echo foxtrot\n');
    await execute('git', ['init', '--quiet'], { cwd: root });
    await execute('git', ['add', '-A'], { cwd: root });
    await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial'], { cwd: root });
    const childProcess = await import('node:child_process');
    const { syncBuiltinESMExports } = await import('node:module');
    const original = childProcess.default.spawn;
    let started = 0;
    let startedBeforeFirstClose;
    childProcess.default.spawn = (file, args, options) => {
      const child = original(file, args, options);
      if (args.includes('grep')) {
        started++;
        child.once('close', () => { startedBeforeFirstClose ??= started; });
      }
      return child;
    };
    syncBuiltinESMExports();
    const engine = new InspectionEngine();
    try {
      await engine.inspect({ version: 1, root, query: 'alpha bravo charlie delta echo foxtrot' }, { version: 1, root });
      assert.equal(started, 6);
      assert.equal(startedBeforeFirstClose, 6);
    } finally {
      childProcess.default.spawn = original;
      syncBuiltinESMExports();
      await engine.close();
    }
  });
});

test('reads metadata for untracked files across nested, sibling and root directories', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'tracked.py'), 'tracked = True\n');
    await execute('git', ['init', '--quiet'], { cwd: root });
    await execute('git', ['add', '-A'], { cwd: root });
    await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial'], { cwd: root });
    const paths = ['a/b/one.py', 'a/b/two.py', 'a/c/three.py', 'a/four.py', 'd/e/f/five.py', 'six.py', 'd/seven.py'];
    for (const path of paths) {
      await mkdir(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
      await writeFile(join(root, path), `nestedNeedle = "${path}"\n`);
    }
    const engine = new InspectionEngine();
    try {
      const packet = await engine.inspect({ version: 1, root, query: 'nestedNeedle' }, { version: 1, root });
      assert.deepEqual(packet.excerpts.map(item => item.path).sort(), [...paths].sort());
      assert.equal(packet.snapshot.validated, true);
    } finally { await engine.close(); }
  });
});

async function recordGitSpawns(root, query, requests = 1) {
  const childProcess = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const original = childProcess.default.spawn;
  const events = [];
  childProcess.default.spawn = (file, args, options) => {
    const child = original(file, args, options);
    const command = args.find(argument => ['grep', 'ls-files', 'status', 'rev-parse'].includes(argument)) ?? 'other';
    const label = command === 'rev-parse' && args.includes('--show-toplevel') ? 'toplevel' : command;
    events.push(`start ${label}`);
    child.once('close', () => events.push(`close ${label}`));
    return child;
  };
  syncBuiltinESMExports();
  const engine = new InspectionEngine();
  try {
    for (let request = 0; request < requests; request++) {
      events.push(`request ${request}`);
      await engine.inspect({ version: 1, root, query }, { version: 1, root });
    }
  } finally {
    childProcess.default.spawn = original;
    syncBuiltinESMExports();
    await engine.close();
  }
  return events;
}

async function committedFixture(root) {
  await writeFile(join(root, 'source.py'), 'overlapNeedle = True\n');
  await execute('git', ['init', '--quiet'], { cwd: root });
  await execute('git', ['add', '-A'], { cwd: root });
  await execute('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial'], { cwd: root });
}

test('starts Git grep before the inventory listing finishes on a fresh worker and while a root exceeds native admission', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'many'));
    await Promise.all(Array.from({ length: 2001 }, (_, index) => writeFile(join(root, 'many', `file${index}.txt`), `${index}\n`)));
    await committedFixture(root);
    const events = await recordGitSpawns(root, 'overlapNeedle', 2);
    const first = events.slice(0, events.indexOf('request 1'));
    const second = events.slice(events.indexOf('request 1'));
    assert.ok(first.indexOf('start grep') >= 0 && first.indexOf('start grep') < first.indexOf('close ls-files'), first.join(', '));
    assert.ok(second.indexOf('start grep') >= 0 && second.indexOf('start grep') < second.indexOf('close ls-files'), second.join(', '));
  });
});

test('checks the Git top-level alongside the snapshot commands', async () => {
  await fixture(async root => {
    await committedFixture(root);
    const events = await recordGitSpawns(root, 'overlapNeedle');
    const finalStatus = events.lastIndexOf('start status');
    const initialTop = events.indexOf('close toplevel');
    const finalTop = events.lastIndexOf('close toplevel');
    assert.ok(finalStatus < finalTop && finalStatus > initialTop, events.join(', '));
  });
});

test('walks untracked files once per inventory, through Git status', async () => {
  await fixture(async root => {
    await committedFixture(root);
    await writeFile(join(root, 'untracked.py'), 'overlapNeedle = 1\n');
    const events = [];
    const childProcess = await import('node:child_process');
    const { syncBuiltinESMExports } = await import('node:module');
    const original = childProcess.default.spawn;
    childProcess.default.spawn = (file, args, options) => {
      if (args.includes('ls-files')) events.push(args.includes('--others') ? 'ls-files others' : 'ls-files cached');
      return original(file, args, options);
    };
    syncBuiltinESMExports();
    const engine = new InspectionEngine();
    try {
      const packet = await engine.inspect({ version: 1, root, query: 'overlapNeedle' }, { version: 1, root });
      assert.ok(packet.excerpts.some(item => item.path === 'untracked.py'));
      assert.deepEqual(events, ['ls-files cached', 'ls-files cached']);
    } finally {
      childProcess.default.spawn = original;
      syncBuiltinESMExports();
      await engine.close();
    }
  });
});
