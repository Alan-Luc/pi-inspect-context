import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeWorkerJSON } from '../../src/worker/worker-input.ts';

const bytes = text => Buffer.from(text);

test('decodes one UTF-8 object without interpreting quoted source text as keys', () => {
  const expected = { version: 1, root: '/owned/repo', query: 'loadAccount({"root":"source"})\nCafé' };
  assert.deepEqual(decodeWorkerJSON(bytes(JSON.stringify(expected))), expected);
});

test('rejects duplicate object keys including escaped names and nested objects', () => {
  for (const input of [
    '{"root":"first","root":"second"}',
    '{"root":"first","\\u0072oot":"second"}',
    '{"query":{"nested":1,"nested":2}}',
    '{"query":[{"nested":1,"nested":2}]}',
  ]) assert.throws(() => decodeWorkerJSON(bytes(input)), /duplicate object key/);
});

test('keeps object key sets separate across nesting and array items', () => {
  const expected = { first: { root: 'a' }, second: [{ root: 'b' }, { root: 'c' }] };
  assert.deepEqual(decodeWorkerJSON(bytes(JSON.stringify(expected))), expected);
});

test('rejects invalid UTF-8 before accepting replacement characters', () => {
  assert.throws(() => decodeWorkerJSON(Buffer.from([0x7b, 0x22, 0x71, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])), /UTF-8/);
});

test('rejects missing, malformed and trailing JSON', () => {
  for (const input of ['', '{', '{"root":1,}', '{} {}', '{} trailing', '\uFEFF{}']) {
    assert.throws(() => decodeWorkerJSON(bytes(input)), /JSON/);
  }
});

test('enforces the existing 64 KiB wire bound including surrounding whitespace', () => {
  const exact = bytes('{}' + ' '.repeat(65_534));
  assert.deepEqual(decodeWorkerJSON(exact), {});
  assert.throws(() => decodeWorkerJSON(Buffer.concat([exact, bytes(' ')])), /65536 bytes/);
});
