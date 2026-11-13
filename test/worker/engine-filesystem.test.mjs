import assert from 'node:assert/strict';
import { constants, openSync, readFileSync, closeSync, chmodSync } from 'node:fs';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { open as openLibrary, close as closeLibrary, load, DataType } from 'ffi-rs';
import { openAt, readDirectory, statAt, acquireNativeFiles } from '../../src/worker/native-files.ts';

async function fixture(run) {
  const release = acquireNativeFiles();
  const root = await mkdtemp(join(tmpdir(), 'inspect-native-files-'));
  const descriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await run(root, descriptor); }
  finally { closeSync(descriptor); await rm(root, { recursive: true, force: true }); release(); }
}

test('repeated anchored directory enumeration returns the same snapshot', async () => {
  await fixture(async (root, descriptor) => {
    await writeFile(join(root, 'one.txt'), 'one');
    await writeFile(join(root, 'two.txt'), 'two');
    assert.deepEqual(readDirectory(descriptor).sort(), ['one.txt', 'two.txt']);
    assert.deepEqual(readDirectory(descriptor).sort(), ['one.txt', 'two.txt']);
  });
});

test('directory enumeration and file reads retain the opened parent after replacement', async () => {
  await fixture(async (root, descriptor) => {
    await mkdir(join(root, 'source'));
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'source', 'safe.txt'), 'authorized');
    await writeFile(join(root, 'outside', 'secret.txt'), 'outside');
    const source = openAt(descriptor, 'source', true);
    try {
      await rename(join(root, 'source'), join(root, 'moved'));
      await symlink(join(root, 'outside'), join(root, 'source'));
      assert.deepEqual(readDirectory(source), ['safe.txt']);
      const file = openAt(source, 'safe.txt');
      try { assert.equal(readFileSync(file, 'utf8'), 'authorized'); } finally { closeSync(file); }
      assert.throws(() => openAt(source, 'secret.txt'));
      assert.throws(() => openAt(descriptor, 'source', true));
    } finally { closeSync(source); }
  });
});

test('candidate symlinks and unsafe path components are rejected', async () => {
  await fixture(async (root, descriptor) => {
    await writeFile(join(root, 'source.txt'), 'authorized');
    await symlink(join(root, 'source.txt'), join(root, 'linked'));
    assert.throws(() => openAt(descriptor, 'linked'));
    for (const component of ['', '.', '..', '../source.txt', 'a/b', 'a\\b', 'a\0b']) assert.throws(() => openAt(descriptor, component));
  });
});

test('directory enumeration preserves a leading byte-order mark in a filename', async () => {
  await fixture(async (root, descriptor) => {
    const name = '\uFEFFsource.ts';
    await writeFile(join(root, name), 'authorized');
    assert.deepEqual(readDirectory(descriptor), [name]);
  });
});

test('native-opened descriptors carry the close-on-exec flag', async () => {
  await fixture(async (root, descriptor) => {
    await writeFile(join(root, 'source.txt'), 'authorized');
    const library = 'inspect-descriptor-flags-test';
    const getDescriptorFlags = 1;
    const closeOnExec = 1;
    openLibrary({ library, path: '' });
    try {
      const file = openAt(descriptor, 'source.txt');
      try {
        const flags = load({ library, funcName: 'fcntl', retType: DataType.I32, paramsType: [DataType.I32, DataType.I32], paramsValue: [file, getDescriptorFlags], errno: true });
        assert.ok(flags.value >= 0, flags.errnoMessage);
        assert.equal(flags.value & closeOnExec, closeOnExec, 'descriptor must close across exec');
      } finally { closeSync(file); }
    } finally { closeLibrary(library); }
  });
});

test('metadata checks handle unreadable files without following final symlinks', async () => {
  await fixture(async (root, descriptor) => {
    await writeFile(join(root, 'unreadable'), 'authorized');
    chmodSync(join(root, 'unreadable'), 0);
    const metadata = statAt(descriptor, 'unreadable');
    assert.equal(metadata.size, 10n);
    assert.equal(metadata.mode & 0o777n, 0n);
    assert.throws(() => openAt(descriptor, 'unreadable'));
    await symlink(join(root, 'unreadable'), join(root, 'linked'));
    assert.equal(statAt(descriptor, 'linked').mode & 0o170000n, 0o120000n);
  });
});

test('a second engine lease survives release of the first native lease', async () => {
  const first = acquireNativeFiles();
  const second = acquireNativeFiles();
  first();
  first();
  try {
    const descriptor = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY);
    try { assert.ok(readDirectory(descriptor).length > 0); } finally { closeSync(descriptor); }
  } finally { second(); }
});
