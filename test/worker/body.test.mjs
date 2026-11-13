import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareEvidenceWindow, memberDefinitionPatterns } from '../../src/worker/body.ts';

const classify = (_path, _line, _candidate, _terms) => [{ kind: 'definition', confidence: 'candidate', reason: 'test classifier' }];
function makeWindow(path, text, line, kind = 'definition') {
  const lines = text === '' ? [] : text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const candidate = { fileIndex: 0, path, startLine: line, endLine: line, exact: true, contentTerms: [], pathTerms: [], contextTerms: [], score: 1 };
  const window = { fileIndex: 0, path, startLine: line, endLine: line, candidates: [candidate], bodyComplete: false };
  return { file: { path, text, lines }, window, kind };
}
function prepare(path, text, line, kind = 'definition', expanded = { count: 0 }, classifier = classify) {
  const { file, window } = makeWindow(path, text, line, kind);
  return { result: prepareEvidenceWindow(file, window, kind, [], expanded, classifier), expanded };
}

test('ports declaration patterns with Go-compatible matching groups', () => {
  assert.equal(memberDefinitionPatterns['.ts'].exec('async load(id: string) {')?.[1], 'load');
  assert.equal(memberDefinitionPatterns['.go'].exec('func (s *Store) load(')?.[1], 'load');
  assert.equal(memberDefinitionPatterns['.py'].exec('load: list[str]')?.[1], 'load');
  assert.equal(memberDefinitionPatterns['.java'].exec('public String load() {')?.[1], 'load');
});

test('returns exact complete body line spans and preserves CRLF', () => {
  const source = 'before\r\nfunction target() {\r\n  if (ready) {\r\n    work();\r\n  }\r\n}\r\nafter\r\n';
  const { result } = prepare('source.js', source, 2);
  assert.deepEqual([result.startLine, result.endLine, result.bodyComplete], [2, 6, true]);
});

test('keeps ambiguous regex bodies partial', () => {
  const { result } = prepare('source.js', 'function target() {\n  const pattern = /}/;\n  work();\n}\n', 1);
  assert.equal(result.bodyComplete, false);
  assert.equal(result.endLine, 4);
});

test('keeps JSX hidden lines uncertain', () => {
  const source = "function target() {\n  if (x) return <p>Don't</p>;\n  hidden();\n}\n";
  const { result } = prepare('source.tsx', source, 1);
  assert.equal(result.bodyComplete, false);
});

test('keeps Python f-string bodies uncertain', () => {
  const { result } = prepare('source.py', 'def target():\n    value = f"{item}"\n    return value\n\ndef next():\n    pass\n', 1);
  assert.equal(result.bodyComplete, false);
  assert.equal(result.endLine, 6);
});

test('returns a complete Java class body', () => {
  const { result } = prepare('Target.java', 'class Target {\n  int value;\n}\n', 1);
  assert.deepEqual([result.startLine, result.endLine, result.bodyComplete], [1, 3, true]);
});

test('keeps Java Unicode escape bodies uncertain', () => {
  const { result } = prepare('Target.java', 'class Target {\n  void run() {\n    if (ready) \\u007b\n      work();\n    }\n  }\n}\n', 2);
  assert.equal(result.bodyComplete, false);
});

test('declines capped uncertain definitions but retains the bounded default window', () => {
  const source = 'function target() {\n  return /}/;\n}\n' + 'function unrelated() { return 1; }\n'.repeat(90);
  const { result, expanded } = prepare('source.js', source, 1);
  assert.deepEqual([result.startLine, result.endLine, result.bodyComplete, expanded.count], [1, 3, false, 0]);
});

test('caller uncertainty fallback does not expand past an unenclosed caller', () => {
  const source = 'function serve() {\n  function helper() {\n    return /[{]/.test(input);\n  }\n  target();\n}\nafter();\n';
  const { file, window } = makeWindow('caller.js', source, 5, 'caller');
  const callerClassifier = () => [{ kind: 'caller', confidence: 'candidate', reason: 'test caller' }];
  const result = prepareEvidenceWindow(file, window, 'caller', [], { count: 0 }, callerClassifier);
  assert.deepEqual([result.startLine, result.endLine, result.bodyComplete], [3, 7, false]);
});

test('caps successful body expansions at three', () => {
  const expanded = { count: 0 };
  const source = 'function target() {\n  work();\n}\n';
  for (let index = 0; index < 4; index++) prepare('source.js', source, 1, 'definition', expanded);
  assert.equal(expanded.count, 3);
});

test('uses the provided candidate classifier when selecting an anchor', () => {
  const source = 'function first() {\n  work();\n}\nfunction target() {\n  work();\n}\n';
  const { file, window } = makeWindow('source.js', source, 1);
  window.candidates.push({ ...window.candidates[0], startLine: 4, endLine: 4 });
  const classifier = (_path, line) => [{ kind: line.includes('target') ? 'definition' : 'match', confidence: 'candidate', reason: 'anchor' }];
  const result = prepareEvidenceWindow(file, window, 'definition', [], { count: 0 }, classifier);
  assert.deepEqual([result.startLine, result.endLine], [1, 6]);
});
