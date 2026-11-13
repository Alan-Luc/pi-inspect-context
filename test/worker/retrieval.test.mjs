import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Value } from 'typebox/value';
import { RESEARCH_PACKET_V1_SCHEMA } from '../../src/packet.ts';
import { buildEvidencePacket, extractSearchTerms, matchingSearchTerms, matchingPathTerms, orderGitCandidates, exclusionReason, exclusionReasonForDirectory, governingName, sourceLines } from '../../src/worker/retrieval.ts';

function packet(query, sources, scope = '.') {
  const files = Object.entries(sources).map(([path, text]) => ({ path, text, lines: sourceLines(text) }));
  return buildEvidencePacket({ query, cwd: scope, repository: 'filesystem', snapshotId: 'verified-snapshot', files, scope, discoveredFiles: files.length, readFiles: files.length, bytesRead: files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0), omissions: [], durationMs: 0 });
}
function verify(packet) {
  assert.equal(Value.Check(RESEARCH_PACKET_V1_SCHEMA, packet), true, JSON.stringify([...Value.Errors(RESEARCH_PACKET_V1_SCHEMA, packet)]));
  assert.equal(packet.receipt.excerptCount, packet.excerpts.length);
  assert.equal(packet.receipt.omissionCount, packet.omissions.reduce((sum, group) => sum + group.count, 0));
  for (const reference of [...packet.governingArtifacts, ...packet.definitions, ...packet.callers, ...packet.imports, ...packet.tests, ...packet.configuration, ...packet.matches]) assert.ok(packet.excerpts.some(excerpt => excerpt.id === reference.excerptId));
}

test('lexical terms preserve Unicode tokenization, stop words, and slash boundaries', () => {
  assert.deepEqual(extractSearchTerms('the loadUser /health/ready cache_refresh'), [
    { original: 'loadUser', lower: 'loaduser', codeLike: true },
    { original: '/health/ready', lower: '/health/ready', codeLike: true },
    { original: 'cache_refresh', lower: 'cache_refresh', codeLike: true },
  ]);
  assert.deepEqual(extractSearchTerms('the and'), [{ original: 'the', lower: 'the', codeLike: false }]);
  assert.deepEqual(extractSearchTerms('İΣΟΣ café café CAFÉ').map(term => term.lower), ['iσοσ', 'café']);
  const terms = extractSearchTerms('/health');
  assert.deepEqual(matchingSearchTerms('x/health', terms), []);
  assert.deepEqual(matchingSearchTerms('x/health health /healthiness', terms), [0]);
  assert.deepEqual(matchingPathTerms('src/health.ts', terms), [0]);
});

test('Git ordering reserves exact paths and the best rare-term covering candidate', () => {
  const terms = extractSearchTerms('CacheWidget startup');
  const candidates = [
    { path: 'z-common.ts', contentTerms: [0], pathTerms: [] },
    { path: 'src/CacheWidget.ts', contentTerms: [], pathTerms: [0] },
    { path: 'a-startup.ts', contentTerms: [1], pathTerms: [] },
    { path: 'b-both.ts', contentTerms: [0, 1], pathTerms: [] },
  ];
  assert.deepEqual(orderGitCandidates(candidates, 'CacheWidget', terms, [3, 2], 3).map(item => item.path), ['src/CacheWidget.ts', 'b-both.ts', 'z-common.ts']);
  assert.deepEqual(orderGitCandidates(candidates, 'missing', terms, [3, 2], 0), []);
});

test('exclusions and source line endings match the frozen engine', () => {
  assert.equal(exclusionReason('vendor/lib/a.go'), 'dependency_or_vendor');
  assert.equal(exclusionReasonForDirectory('src/generated'), 'generated_or_build');
  assert.equal(exclusionReason('dist/vendor/a.go'), 'generated_or_build');
  assert.equal(exclusionReason('src/vendorish/a.go'), undefined);
  assert.equal(governingName('docs/README.md'), true);
  assert.equal(governingName('docs/readme.md'), false);
  assert.deepEqual(sourceLines('one\ntwo\n'), ['one\n', 'two\n']);
  assert.deepEqual(sourceLines('one\ntwo'), ['one\n', 'two']);
  assert.deepEqual(sourceLines('\n\n'), ['\n', '\n']);
  assert.deepEqual(sourceLines(''), []);
});

test('classifies the matched symbol rather than another declaration on the same line', () => {
  const result = packet('target', { 'service.ts': 'function other() { target(); }\n' });
  verify(result);
  assert.equal(result.definitions.length, 0);
  assert.equal(result.callers.length, 1);
  assert.deepEqual(result.excerpts.map(({ startLine, endLine, bodyComplete }) => [startLine, endLine, bodyComplete]), [[1, 1, true]]);
});

test('preserves complete definitions, callers, test labels, and stable evidence identities', () => {
  const result = packet('loadAccount', {
    'service.ts': 'export function loadAccount() {\n  return true;\n}\n',
    'route.ts': 'function route() {\n  return loadAccount();\n}\n',
    'feature_tests/account.ts': 'loadAccount();\n',
  });
  verify(result);
  assert.deepEqual(result.excerpts.map(excerpt => excerpt.path), ['service.ts', 'route.ts', 'feature_tests/account.ts']);
  assert.equal(result.definitions.length, 1);
  assert.equal(result.callers.length, 1);
  assert.equal(result.tests.length, 1);
  assert.equal(result.excerpts[0].bodyComplete, true);
  assert.equal(result.excerpts[1].bodyComplete, true);
  const expectedKey = ['definition', 'service.ts', 1, 3, 'export function loadAccount() {\n  return true;\n}\n'].join('\0');
  assert.equal(result.excerpts[0].id, `e-${createHash('sha256').update(expectedKey).digest('hex').slice(0, 16)}`);
});

test('declines long uncertain expansion and keeps matched lines in the fallback', () => {
  const result = packet('target', { 'service.ts': 'function target() {\n  return /}/;\n}\n' + 'function unrelated() {}\n'.repeat(90) });
  verify(result);
  assert.deepEqual(result.excerpts.map(({ startLine, endLine, bodyComplete }) => [startLine, endLine, bodyComplete]), [[1, 3, false]]);
});

test('documentation cannot satisfy the package source threshold', () => {
  const result = packet('target', {
    'pkg/README.md': 'target\n', 'pkg/guide.md': 'target\n', 'pkg/notes.md': 'target\n',
    'pkg/service.ts': 'function target() {}\n', 'sibling.ts': 'function target() {}\n',
  }, 'pkg');
  verify(result);
  assert.ok(result.excerpts.some(excerpt => excerpt.path === 'sibling.ts'));
  assert.ok(result.unknowns.includes('Thin package "pkg": repository fallback.'));
  assert.equal(result.omissions.some(omission => omission.reason === 'package_scope'), false);
});

test('a substantial package omits sibling evidence while retaining ancestor governing text', () => {
  const result = packet('target', {
    'README.md': 'target\n', 'pkg/a.ts': 'function target() {}\n', 'pkg/b.ts': 'target();\n',
    'pkg/c.py': 'target()\n', 'sibling.ts': 'function target() {}\n',
  }, 'pkg');
  verify(result);
  assert.equal(result.excerpts.some(excerpt => excerpt.path === 'sibling.ts'), false);
  assert.ok(result.excerpts.some(excerpt => excerpt.path === 'README.md'));
  assert.deepEqual(result.omissions.find(omission => omission.reason === 'package_scope'), { reason: 'package_scope', count: 1, examples: ['sibling.ts'] });
});

test('a late code anchor survives the per-file evaluation cap', () => {
  const result = packet('configuration LateAnchor', { 'source.ts': 'configuration\n'.repeat(100) + 'function LateAnchor() {}\n' });
  verify(result);
  assert.ok(result.definitions.some(reference => reference.startLine <= 101 && reference.endLine >= 101));
  assert.ok(result.excerpts.some(excerpt => excerpt.text.includes('function LateAnchor() {}')));
  assert.ok(result.excerpts.every(excerpt => excerpt.endLine - excerpt.startLine + 1 <= 80));
});

test('multiline literal spans preserve source line ranges', () => {
  const result = packet('needle\ncontinuation', { 'source.txt': 'before\nneedle\ncontinuation\nafter\n' });
  verify(result);
  assert.deepEqual(result.excerpts.map(({ startLine, endLine, text }) => [startLine, endLine, text]), [[2, 3, 'needle\ncontinuation\n']]);
});

test('category and packet caps retain valid references and accurate omissions', () => {
  const sources = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`file${String(index).padStart(2, '0')}.ts`, `function target() {\n  return '${'<&>'.repeat(500)}';\n}\n`]));
  const result = packet('target', sources);
  verify(result);
  const encoded = JSON.stringify(result).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  assert.ok(Buffer.byteLength(encoded) <= 32_768);
  assert.ok(result.definitions.length <= 32);
  assert.ok(result.excerpts.length <= 64);
  assert.ok(result.omissions.some(omission => omission.reason === 'packet_limit'));
});
