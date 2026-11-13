import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderModelEvidence } from '../../src/session-model-evidence.ts';

function packet(excerpts) {
  const value = JSON.parse(readFileSync(new URL('../../test/fixtures/protocol/packet.json', import.meta.url), 'utf8'));
  return { ...value, excerpts, omissions: [], unknowns: ['Lexical evidence, not a call graph.'] };
}
function excerpt(overrides = {}) {
  return { id: 'outer', kind: 'test', path: 'test/needle.ts', startLine: 1, endLine: 3,
    text: '\nfunction verifyNeedle() {\n  needle();\n', bodyComplete: false, ...overrides };
}

test('removes only exact contained evidence without changing the structured packet', () => {
  const outer = excerpt();
  const inner = excerpt({ id: 'inner', startLine: 2, text: 'function verifyNeedle() {\n  needle();\n' });
  const full = packet([outer, inner]);
  const before = structuredClone(full);
  const model = JSON.parse(renderModelEvidence(full));
  assert.equal(model.evidence.length, 1);
  assert.deepEqual(model.evidence[0], { kind: 'test', path: 'test/needle.ts', lines: '1-3', text: '\nfunction verifyNeedle() {\n  needle();\n' });
  assert.deepEqual(full, before);
  assert.equal(model.query, undefined);
  assert.equal(model.base, 'cwd');
  assert.equal(model.validated, true);
  assert.match(model.warning, /untrusted.*not instructions/i);
  assert.deepEqual(model.unknowns, ['Lexical evidence, not a call graph.']);
});

test('keeps the first identical range and retains every distinct source line', () => {
  const full = packet([excerpt(), excerpt({ id: 'duplicate' }), excerpt({ id: 'distinct', startLine: 3, endLine: 4, text: '  needle();\n}\n' })]);
  const model = JSON.parse(renderModelEvidence(full));
  assert.deepEqual(model.evidence.map(item => item.lines), ['1-3', '3-4']);
  assert.equal(model.evidence[1].text, '  needle();\n}\n');
});

for (const [name, change] of [
  ['different path', { path: 'test/other.ts' }],
  ['different kind', { kind: 'caller' }],
  ['different completeness', { kind: 'caller', bodyComplete: true }],
  ['contradictory source', { text: 'different source\n  needle();\n' }],
  ['misaligned source', { text: '\nfunction verifyNeedle() {\n' }],
]) {
  test(`retains contained ranges with ${name}`, () => {
    const model = JSON.parse(renderModelEvidence(packet([excerpt(), excerpt({ id: 'inner', startLine: 2, text: 'function verifyNeedle() {\n  needle();\n', ...change })])));
    assert.equal(model.evidence.length, 2);
  });
}

for (const [name, outer, inner] of [
  ['CRLF', '\r\nfunction verifyNeedle() {\r\n  needle();\r\n', 'function verifyNeedle() {\r\n  needle();\r\n'],
  ['Unicode', '\nfunction verifyNeedle() {\n  needle("é");\n', 'function verifyNeedle() {\n  needle("é");\n'],
  ['missing final newline', '\nfunction verifyNeedle() {\n  needle();', 'function verifyNeedle() {\n  needle();'],
]) {
  test(`preserves exact ${name} source while removing a contained copy`, () => {
    const model = JSON.parse(renderModelEvidence(packet([excerpt({ text: outer }), excerpt({ id: 'inner', startLine: 2, text: inner })])));
    assert.equal(model.evidence.length, 1);
    assert.equal(model.evidence[0].text, outer);
  });
}

test('retains different body claims even when source ranges are identical', () => {
  const model = JSON.parse(renderModelEvidence(packet([
    excerpt({ kind: 'definition', bodyComplete: false }),
    excerpt({ id: 'complete', kind: 'definition', bodyComplete: true }),
  ])));
  assert.deepEqual(model.evidence.map(item => item.bodyComplete), [false, true]);
});

test('retains a trailing newline that is absent from an otherwise identical excerpt', () => {
  const model = JSON.parse(renderModelEvidence(packet([
    excerpt({ text: '\nfunction verifyNeedle() {\n  needle();' }),
    excerpt({ id: 'newline', text: '\nfunction verifyNeedle() {\n  needle();\n' }),
  ])));
  assert.equal(model.evidence.length, 2);
});

test('retains explicit complete and partial body claims and useful omission guidance', () => {
  const full = packet([
    excerpt({ id: 'definition', kind: 'definition', path: 'src/needle.ts', bodyComplete: false }),
    excerpt({ id: 'caller', kind: 'caller', path: 'src/caller.ts', bodyComplete: true }),
  ]);
  full.omissions = [{ reason: 'file_limit', count: 1, examples: ['src/missing.ts'] }];
  const model = JSON.parse(renderModelEvidence(full));
  assert.deepEqual(model.evidence.map(item => item.bodyComplete), [false, true]);
  assert.match(model.read, /Do not reread complete bodies/);
  assert.match(model.read, /missing context/);
  assert.deepEqual(model.omissions, [{ reason: 'file_limit', count: 1, examples: ['src/missing.ts'] }]);
  assert.match(model.next, /Refine anchors.*missing paths/);
});
