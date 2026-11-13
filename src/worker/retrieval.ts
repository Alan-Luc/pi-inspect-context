import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { MAX_EVIDENCE_PER_CATEGORY, MAX_EXCERPTS, MAX_EXCERPT_LINES, MAX_OMISSION_EXAMPLES, MAX_UNKNOWNS, POLICY_VERSION, InspectContextError, type EvidenceRef, type Excerpt, type ExcerptKind, type OmissionGroup, type OmissionReason, type ResearchPacketV1 } from '../packet.ts';
import { memberDefinitionPatterns, prepareEvidenceWindow } from './body.ts';
import type { EvidenceInput, GitCandidate, MatchCategory, RetrievalCandidate, RetrievalFile, RetrievalWindow, SearchTerm } from './contracts.ts';

const maxSearchTerms = 8;
const maxCandidatesPerFile = 8;
const maxWindowsPerFile = 3;
const maxEvaluationsPerFile = 64;
const maxCandidates = MAX_EXCERPTS * 4;
const maxEvaluations = 2_000 * (maxEvaluationsPerFile + maxSearchTerms);
const contextRadius = 2;
const primaryWindowLimit = 24;
const targetPacketBytes = 32_768;
const stopWords = new Set('a an and are as at be by for from how in is it its of on or that the this through to under what where which with'.split(' '));
const dependencyDirectories = new Set(['.git', '.harness', '.opencode', '.pi', '.claude', '.cursor', 'node_modules', 'vendor', 'third_party', 'deps', 'Pods']);
const generatedDirectories = new Set(['dist', 'build', 'out', 'target', 'coverage', '.cache', '.next', 'tmp', 'bin', 'generated']);
const governingNames = new Set(['AGENTS.md', 'README', 'README.md', 'README.txt', 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'Makefile', 'CMakeLists.txt', 'pom.xml', 'build.gradle']);
const categoryKinds: ExcerptKind[] = ['governing', 'definition', 'caller', 'import', 'test', 'configuration', 'match'];
const primaryKinds: ExcerptKind[] = ['governing', 'test', 'configuration', 'definition', 'caller', 'import'];

function lower(value: string): string {
  return Array.from(value, character => [...character.toLowerCase()][0]).join('');
}
export { lower as lowercaseSearchText };
function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function merge(left: number[], right: number[]): number[] {
  return [...new Set([...left, ...right])].sort((a, b) => a - b);
}
export function sourceLines(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
export function exclusionReasonForDirectory(value: string): OmissionReason | undefined {
  for (const component of value.split('/')) {
    if (dependencyDirectories.has(component)) return 'dependency_or_vendor';
    if (generatedDirectories.has(component)) return 'generated_or_build';
  }
  return undefined;
}
export function exclusionReason(value: string): OmissionReason | undefined {
  return exclusionReasonForDirectory(value.split('/').slice(0, -1).join('/'));
}
export function governingName(value: string): boolean {
  return governingNames.has(posix.basename(value));
}
export function extractSearchTerms(query: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  let current = '';
  let fallback: SearchTerm | undefined;
  const flush = () => {
    if (!current) return;
    const original = current;
    current = '';
    if (!/[\p{L}\p{N}_]/u.test(original)) return;
    const term = { original, lower: lower(original), codeLike: original.startsWith('/') || original.includes('_') || /[\p{Lu}\p{N}]/u.test(original) };
    if (stopWords.has(term.lower)) {
      fallback ??= term;
      return;
    }
    if (terms.length < maxSearchTerms && !terms.some(existing => existing.lower === term.lower)) terms.push(term);
  };
  for (const character of query) {
    if (/[\p{L}\p{N}_]/u.test(character)) current += character;
    else if (character === '/') {
      if (current && !current.startsWith('/')) flush();
      current += character;
    } else if (current.startsWith('/') && [':', '-', '.'].includes(character)) current += character;
    else flush();
  }
  flush();
  if (!terms.length && fallback) terms.push(fallback);
  return terms;
}
function containsSearchTerm(value: string, term: SearchTerm): boolean {
  if (!term.lower.startsWith('/')) return value.includes(term.lower);
  for (let offset = value.indexOf(term.lower); offset >= 0; offset = value.indexOf(term.lower, offset + 1)) {
    if (offset === 0) return true;
    const previous = [...value.slice(0, offset)].at(-1) ?? '';
    if (!/[\p{L}\p{N}_/.:\-]/u.test(previous)) return true;
  }
  return false;
}
export function matchingSearchTerms(value: string, terms: SearchTerm[]): number[] {
  return terms.flatMap((term, index) => containsSearchTerm(value, term) ? [index] : []);
}
export function matchingPathTerms(value: string, terms: SearchTerm[]): number[] {
  return terms.flatMap((term, index) => value.includes(term.lower) ? [index] : []);
}
function candidateTerms(candidate: GitCandidate): number[] {
  return merge(candidate.contentTerms, candidate.pathTerms);
}
function coverageTerms(terms: SearchTerm[], frequencies: number[], includeRare: boolean): number[] {
  const highest = Math.max(0, ...frequencies);
  return terms.flatMap((term, index) => frequencies[index] > 0 && (term.codeLike || includeRare && frequencies[index] < highest) ? [index] : [])
    .sort((a, b) => frequencies[a] - frequencies[b] || Number(terms[b].codeLike) - Number(terms[a].codeLike) || a - b);
}
export function orderGitCandidates(candidates: GitCandidate[], query: string, terms: SearchTerm[], frequencies: number[], limit: number): GitCandidate[] {
  const byPath = new Map<string, GitCandidate>();
  for (const candidate of candidates) {
    const current = byPath.get(candidate.path);
    byPath.set(candidate.path, { path: candidate.path, contentTerms: merge(current?.contentTerms ?? [], candidate.contentTerms), pathTerms: merge(current?.pathTerms ?? [], candidate.pathTerms) });
  }
  const highest = Math.max(0, ...frequencies);
  const rarity = (candidate: GitCandidate) => candidateTerms(candidate).reduce((sum, index) => sum + (frequencies[index] > 0 ? highest - frequencies[index] + 1 : 0), 0);
  const codeTerms = (candidate: GitCandidate) => candidate.contentTerms.filter(index => terms[index]?.codeLike).length;
  const base = [...byPath.values()].sort((a, b) => Number(b.path.includes(query)) - Number(a.path.includes(query)) || b.contentTerms.length - a.contentTerms.length || codeTerms(b) - codeTerms(a) || b.pathTerms.length - a.pathTerms.length || rarity(b) - rarity(a) || compareText(a.path, b.path));
  const selected = new Set<GitCandidate>();
  const covered = new Set<number>();
  const reserved: GitCandidate[] = [];
  const reserve = (candidate: GitCandidate) => {
    selected.add(candidate);
    reserved.push(candidate);
    for (const index of candidateTerms(candidate)) covered.add(index);
  };
  for (const candidate of base) if (candidate.path.includes(query)) reserve(candidate);
  for (const index of coverageTerms(terms, frequencies, true)) {
    if (covered.has(index)) continue;
    const candidate = base.find(candidate => !selected.has(candidate) && candidateTerms(candidate).includes(index));
    if (candidate) reserve(candidate);
  }
  return [...reserved, ...base.filter(candidate => !selected.has(candidate))].slice(0, Math.max(0, limit));
}
function isTestPath(value: string): boolean {
  const name = lower(value);
  const basename = posix.basename(name);
  return /(^|\/)(test|tests|__tests__|feature_tests|integration-tests|integration_tests)\//.test(name) || name.endsWith('_test.go') || name.includes('.test.') || name.includes('.spec.') || basename.endsWith('.py') && (basename.startsWith('test_') || basename.endsWith('_test.py'));
}
function isConfigurationPath(value: string): boolean {
  return /\.(json|yaml|yml|toml|ini|xml|config|env)$/.test(lower(value)) || governingName(value);
}
function isDefinitionLine(file: string, line: string, query: string): boolean {
  const normalizedLine = lower(line);
  const normalizedQuery = lower(query);
  const trimmed = normalizedLine.trim();
  let extension = lower(posix.extname(file));
  if (['.tsx', '.js', '.jsx'].includes(extension)) extension = '.ts';
  if (memberDefinitionPatterns[extension]?.exec(trimmed)?.[1] === normalizedQuery) return true;
  for (const keyword of ['func ', 'function ', 'class ', 'interface ', 'struct ', 'type ', 'const ', 'let ', 'var ', 'def ', 'fn ', 'export function ', 'export class ']) {
    if (trimmed.includes(keyword + normalizedQuery)) return true;
  }
  const index = normalizedLine.indexOf(normalizedQuery);
  if (index < 0) return false;
  const rest = normalizedLine.slice(index + normalizedQuery.length).trim();
  return rest.startsWith(':=') || rest.startsWith('=');
}
function classifyMatch(file: string, line: string, query: string): MatchCategory[] {
  if (isTestPath(file)) return [{ kind: 'test', confidence: 'observed', reason: 'test path match' }];
  if (isConfigurationPath(file)) return [{ kind: 'configuration', confidence: 'observed', reason: 'configuration path match' }];
  const categories: MatchCategory[] = [];
  if (['import ', 'import{', 'from ', '#include ', 'include ', 'using ', 'use ', 'require('].some(prefix => line.trim().startsWith(prefix))) categories.push({ kind: 'import', confidence: 'candidate', reason: 'import/include/use/require line' });
  const definition = isDefinitionLine(file, line, query);
  if (definition) categories.push({ kind: 'definition', confidence: 'candidate', reason: 'declaration-like definition' });
  const normalized = lower(line);
  const queryLower = lower(query);
  const index = normalized.indexOf(queryLower);
  if (!definition && index >= 0 && normalized.slice(index + queryLower.length).trim().startsWith('(')) categories.push({ kind: 'caller', confidence: 'candidate', reason: 'call shape' });
  return categories;
}
function appendCategory(categories: MatchCategory[], category: MatchCategory): void {
  if (!categories.some(existing => existing.kind === category.kind)) categories.push(category);
}
export function classifyRetrievedCandidate(file: string, line: string, candidate: RetrievalCandidate, terms: SearchTerm[]): MatchCategory[] {
  const categories: MatchCategory[] = [];
  if (governingName(file)) categories.push({ kind: 'governing', confidence: 'observed', reason: 'query-relevant governing artifact' });
  if (isTestPath(file)) {
    appendCategory(categories, { kind: 'test', confidence: 'observed', reason: 'test path match' });
    return categories;
  }
  if (isConfigurationPath(file)) {
    appendCategory(categories, { kind: 'configuration', confidence: 'observed', reason: 'configuration path match' });
    return categories;
  }
  for (const index of candidate.contentTerms) {
    for (const category of classifyMatch(file, line.replace(/\n$/, ''), terms[index].original)) appendCategory(categories, category);
  }
  return categories;
}
export class Omissions {
  private readonly groups = new Map<OmissionReason, OmissionGroup>();
  add(reason: OmissionReason, count = 1, examples: string[] = []): void {
    if (count <= 0) return;
    const group = this.groups.get(reason) ?? { reason, count: 0, examples: [] };
    group.count += count;
    const accepted = group.examples ?? [];
    for (const example of examples) {
      if (Buffer.byteLength(example) > 256 || !example || example.includes('\\') || example.includes('\0') || posix.isAbsolute(example) || posix.normalize(example) !== example || example === '.' || example === '..' || example.startsWith('../') || accepted.includes(example) || accepted.length >= MAX_OMISSION_EXAMPLES) continue;
      accepted.push(example);
    }
    accepted.sort(compareText);
    group.examples = accepted;
    this.groups.set(reason, group);
  }
  values(): OmissionGroup[] { return [...this.groups.values()].sort((a, b) => compareText(a.reason, b.reason)); }
  total(): number { return [...this.groups.values()].reduce((sum, group) => sum + group.count, 0); }
}
function inScope(file: string, scope: string): boolean { return scope === '.' || file.startsWith(`${scope}/`); }
function scopeFiles(files: RetrievalFile[], terms: SearchTerm[], scope: string, omissions: Omissions, unknowns: string[]): RetrievalFile[] {
  if (scope === '.') return files;
  const count = files.filter(file => inScope(file.path, scope) && /\.(ts|tsx|js|jsx|go|py|java)$/.test(lower(file.path)) && (matchingSearchTerms(lower(file.text), terms).length > 0 || matchingPathTerms(lower(file.path), terms).length > 0)).length;
  if (count < 3) {
    unknowns.push(`Thin package "${scope}": repository fallback.`);
    return files;
  }
  unknowns.push(`Package "${scope}"; sibling evidence omitted.`);
  return files.filter(file => {
    const directory = posix.dirname(file.path);
    if (inScope(file.path, scope) || governingName(file.path) && (directory === '.' || scope.startsWith(`${directory}/`))) return true;
    omissions.add('package_scope', 1, [file.path]);
    return false;
  });
}
function scoreCandidate(candidate: RetrievalCandidate, terms: SearchTerm[], frequencies: number[], highest: number): number {
  let score = candidateTerms(candidate).length * 1_000_000 + candidate.contextTerms.length * 400_000;
  for (const index of candidateTerms(candidate)) {
    score += Math.max(1, highest - frequencies[index] + 1) * 1_000;
    if (terms[index].codeLike && candidate.contentTerms.includes(index)) score += 1_500_000;
  }
  return score + candidate.pathTerms.length * 250_000 + (candidate.contentTerms.length > 0 ? 25_000 : 0) + (candidate.exact ? 1_000_000_000_000 : 0);
}
function compareCandidates(left: RetrievalCandidate, right: RetrievalCandidate): number {
  return right.score - left.score || left.path.split('/').length - right.path.split('/').length || compareText(left.path, right.path) || left.startLine - right.startLine || left.endLine - right.endLine || Number(right.exact) - Number(left.exact) || left.fileIndex - right.fileIndex;
}
function prioritizeCoverage(candidates: RetrievalCandidate[], terms: SearchTerm[], frequencies: number[], includeRare: boolean): RetrievalCandidate[] {
  const selected = new Set<RetrievalCandidate>();
  const covered = new Set<number>();
  const ordered: RetrievalCandidate[] = [];
  const select = (candidate: RetrievalCandidate) => {
    selected.add(candidate);
    ordered.push(candidate);
    for (const index of candidateTerms(candidate)) covered.add(index);
  };
  for (const candidate of candidates) if (candidate.exact) select(candidate);
  for (const index of coverageTerms(terms, frequencies, includeRare)) {
    if (covered.has(index)) continue;
    const candidate = candidates.find(candidate => !selected.has(candidate) && !candidate.exact && candidateTerms(candidate).includes(index));
    if (candidate) select(candidate);
  }
  return [...ordered, ...candidates.filter(candidate => !selected.has(candidate))];
}
function literalSpans(file: RetrievalFile, query: string, visit: (first: number, last: number, text: string) => void): void {
  const starts: number[] = [];
  let total = 0;
  for (const line of file.lines) { starts.push(total); total += line.length; }
  const lineNumber = (offset: number) => {
    let first = 0;
    let last = starts.length;
    while (first < last) {
      const middle = Math.floor((first + last) / 2);
      if (starts[middle] <= offset) first = middle + 1;
      else last = middle;
    }
    return first;
  };
  let previousFirst = 0;
  let previousLast = 0;
  for (let offset = file.text.indexOf(query); offset >= 0; offset = file.text.indexOf(query, offset + 1)) {
    const first = lineNumber(offset);
    const last = lineNumber(offset + query.length - 1);
    if (first !== previousFirst || last !== previousLast) visit(first, last, file.lines.slice(first - 1, last).join(''));
    previousFirst = first;
    previousLast = last;
  }
}
function collectCandidates(files: RetrievalFile[], query: string, terms: SearchTerm[]) {
  const frequencies = terms.map((_, index) => files.filter(file => candidateTerms({ path: file.path, contentTerms: matchingSearchTerms(lower(file.text), terms), pathTerms: matchingPathTerms(lower(file.path), terms) }).includes(index)).length);
  const highest = Math.max(0, ...frequencies);
  const candidates: RetrievalCandidate[] = [];
  let exactObserved = 0;
  let fallbackObserved = 0;
  let evaluations = 0;
  for (const [fileIndex, file] of files.entries()) {
    let fileCandidates: RetrievalCandidate[] = [];
    let fileEvaluations = 0;
    const evaluatedTerms = new Set<number>();
    const pathTerms = matchingPathTerms(lower(file.path), terms);
    const add = (first: number, last: number, exact: boolean, contentTerms: number[], directTerms: number[]) => {
      if ((evaluations >= maxEvaluations || fileEvaluations >= maxEvaluationsPerFile) && directTerms.every(index => evaluatedTerms.has(index))) return;
      evaluations++;
      fileEvaluations++;
      for (const index of directTerms) evaluatedTerms.add(index);
      const contextTerms = matchingSearchTerms(lower(file.lines.slice(Math.max(0, first - 1 - contextRadius), Math.min(file.lines.length, last + contextRadius)).join('')), terms);
      const incoming: RetrievalCandidate = { fileIndex, path: file.path, startLine: first, endLine: last, exact, contentTerms, pathTerms: exact ? [] : pathTerms, contextTerms, score: 0 };
      const current = fileCandidates.find(candidate => candidate.startLine === first && candidate.endLine === last);
      if (current) {
        current.exact ||= incoming.exact;
        current.contentTerms = merge(current.contentTerms, incoming.contentTerms);
        current.pathTerms = merge(current.pathTerms, incoming.pathTerms);
        current.contextTerms = merge(current.contextTerms, incoming.contextTerms);
        current.score = scoreCandidate(current, terms, frequencies, highest);
        return;
      }
      incoming.score = scoreCandidate(incoming, terms, frequencies, highest);
      fileCandidates.push(incoming);
      fileCandidates.sort(compareCandidates);
      if (fileCandidates.length > maxCandidatesPerFile) fileCandidates = prioritizeCoverage(fileCandidates, terms, frequencies, false).slice(0, maxCandidatesPerFile);
    };
    let boundedExact = false;
    literalSpans(file, query, (first, last, text) => {
      exactObserved++;
      if (last - first + 1 > MAX_EXCERPT_LINES) return;
      boundedExact = true;
      const contentTerms = matchingSearchTerms(lower(text), terms);
      add(first, last, true, contentTerms, contentTerms);
    });
    if (!boundedExact) {
      for (const [index, line] of file.lines.entries()) {
        const contentTerms = matchingSearchTerms(lower(line), terms);
        if (!contentTerms.length) continue;
        fallbackObserved++;
        add(index + 1, index + 1, false, contentTerms, merge(contentTerms, pathTerms));
      }
      if (pathTerms.length && file.lines.length && !matchingSearchTerms(lower(file.lines[0]), terms).length) {
        fallbackObserved++;
        add(1, 1, false, [], pathTerms);
      }
    }
    candidates.push(...fileCandidates);
  }
  candidates.sort(compareCandidates);
  return { candidates: prioritizeCoverage(candidates, terms, frequencies, true).slice(0, maxCandidates), exactObserved, fallbackObserved };
}
function buildWindows(files: RetrievalFile[], candidates: RetrievalCandidate[]): RetrievalWindow[] {
  let windows: RetrievalWindow[] = [];
  for (const candidate of candidates) {
    const lineCount = files[candidate.fileIndex].lines.length;
    if (!lineCount) continue;
    const incoming: RetrievalWindow = { fileIndex: candidate.fileIndex, path: candidate.path, startLine: Math.max(1, candidate.startLine - (candidate.exact ? 0 : contextRadius)), endLine: Math.min(lineCount, candidate.endLine + (candidate.exact ? 0 : contextRadius)), candidates: [candidate], bodyComplete: false };
    const overlaps = new Set<RetrievalWindow>();
    let previousCount;
    do {
      previousCount = overlaps.size;
      for (const window of windows) {
        if (overlaps.has(window) || window.path !== incoming.path || window.startLine > incoming.endLine || incoming.startLine > window.endLine) continue;
        overlaps.add(window);
        incoming.startLine = Math.min(incoming.startLine, window.startLine);
        incoming.endLine = Math.max(incoming.endLine, window.endLine);
      }
    } while (previousCount !== overlaps.size);
    if (!overlaps.size) {
      if (windows.length < maxCandidates) windows.push(incoming);
      continue;
    }
    if (incoming.endLine - incoming.startLine + 1 > MAX_EXCERPT_LINES) continue;
    for (const window of windows) if (overlaps.has(window)) incoming.candidates.push(...window.candidates);
    const merged: RetrievalWindow[] = [];
    let inserted = false;
    for (const window of windows) {
      if (!overlaps.has(window)) merged.push(window);
      else if (!inserted) { merged.push(incoming); inserted = true; }
    }
    windows = merged;
  }
  for (const window of windows) window.candidates.sort(compareCandidates);
  return windows;
}
function windowTerms(window: RetrievalWindow): number[] {
  return window.candidates.reduce<number[]>((indexes, candidate) => merge(indexes, candidate.contentTerms), []);
}
function prioritizeWindows(windows: RetrievalWindow[], terms: SearchTerm[]): RetrievalWindow[] {
  if (windows.length <= maxWindowsPerFile) return windows;
  const selected = new Set<RetrievalWindow>();
  const covered = new Set<number>();
  const select = (window: RetrievalWindow) => {
    if (selected.has(window) || selected.size >= maxWindowsPerFile) return;
    selected.add(window);
    for (const index of windowTerms(window)) covered.add(index);
  };
  for (const window of windows) if (window.candidates.some(candidate => candidate.exact)) select(window);
  for (const [index, term] of terms.entries()) {
    if (!term.codeLike || covered.has(index) || selected.size >= maxWindowsPerFile) continue;
    const window = windows.find(window => !selected.has(window) && windowTerms(window).includes(index));
    if (window) select(window);
  }
  while (selected.size < maxWindowsPerFile) {
    let best: RetrievalWindow | undefined;
    let bestGain = -1;
    for (const window of windows) {
      if (selected.has(window)) continue;
      const gain = windowTerms(window).filter(index => !covered.has(index)).length;
      if (gain > bestGain) { best = window; bestGain = gain; }
    }
    if (!best) break;
    select(best);
  }
  return windows.filter(window => selected.has(window));
}
function readingRole(window: RetrievalWindow, files: RetrievalFile[], terms: SearchTerm[]): string {
  if (isTestPath(window.path) || isConfigurationPath(window.path) || governingName(window.path)) return '';
  let role = '';
  for (const candidate of window.candidates) {
    for (const category of classifyRetrievedCandidate(candidate.path, files[candidate.fileIndex].lines[candidate.startLine - 1] ?? '', candidate, terms)) {
      if (category.kind === 'definition') return 'definition';
      if (category.kind === 'caller') role = 'caller';
    }
  }
  return role;
}
function selectWindows(ranked: RetrievalWindow[], files: RetrievalFile[], terms: SearchTerm[]): RetrievalWindow[] {
  let ordered = ranked;
  if (terms.length && terms.every(term => term.codeLike && !term.original.startsWith('/'))) {
    const definitions = ranked.filter(window => readingRole(window, files, terms) === 'definition');
    if (definitions.length) ordered = [...definitions, ...ranked.filter(window => readingRole(window, files, terms) === 'caller'), ...ranked.filter(window => !['definition', 'caller'].includes(readingRole(window, files, terms)))];
  }
  const byPath = new Map<string, RetrievalWindow[]>();
  for (const window of ordered) byPath.set(window.path, [...(byPath.get(window.path) ?? []), window]);
  const emitted = new Set<string>();
  const primary: RetrievalWindow[] = [];
  for (const window of ordered) {
    if (emitted.has(window.path)) continue;
    primary.push(...prioritizeWindows(byPath.get(window.path) ?? [], terms));
    emitted.add(window.path);
  }
  const result = primary.slice(0, primaryWindowLimit);
  for (const window of ranked) {
    if (result.length >= MAX_EXCERPTS) break;
    if (!result.some(current => current.path === window.path && current.startLine === window.startLine && current.endLine === window.endLine)) result.push(window);
  }
  return result;
}
class EvidenceStore {
  readonly excerpts: Excerpt[] = [];
  readonly categories = new Map<ExcerptKind, EvidenceRef[]>(categoryKinds.map(kind => [kind, []]));
  readonly ranks = new Map<string, number>();
  private readonly seen = new Map<string, string>();
  private readonly referenceSeen = new Set<string>();
  add(kind: ExcerptKind, window: RetrievalWindow, text: string, confidence: 'observed' | 'candidate', reason: string, rank: number, complete: boolean): boolean {
    const category = this.categories.get(kind);
    if (!category) throw new Error(`unknown evidence kind: ${kind}`);
    const key = [kind, window.path, window.startLine, window.endLine, text].join('\0');
    const existing = this.seen.get(key);
    const id = existing ?? `e-${hash(key).slice(0, 16)}`;
    const referenceKey = [kind, id, confidence, reason].join('\0');
    if (this.referenceSeen.has(referenceKey)) return true;
    if (category.length >= MAX_EVIDENCE_PER_CATEGORY) return false;
    if (!existing) {
      this.seen.set(key, id);
      this.ranks.set(id, rank);
      this.excerpts.push({ id, path: window.path, startLine: window.startLine, endLine: window.endLine, kind, text, bodyComplete: complete });
    }
    this.referenceSeen.add(referenceKey);
    category.push({ excerptId: id, path: window.path, startLine: window.startLine, endLine: window.endLine, confidence, reason });
    return true;
  }
  references(kind: ExcerptKind): EvidenceRef[] {
    return [...(this.categories.get(kind) ?? [])].sort((a, b) => (this.ranks.get(a.excerptId) ?? 0) - (this.ranks.get(b.excerptId) ?? 0) || compareText(a.path, b.path) || a.startLine - b.startLine || compareText(a.excerptId, b.excerptId));
  }
}
function retainReferences(packet: ResearchPacketV1): void {
  const known = new Set(packet.excerpts.map(excerpt => excerpt.id));
  packet.governingArtifacts = packet.governingArtifacts.filter(reference => known.has(reference.excerptId));
  packet.definitions = packet.definitions.filter(reference => known.has(reference.excerptId));
  packet.callers = packet.callers.filter(reference => known.has(reference.excerptId));
  packet.imports = packet.imports.filter(reference => known.has(reference.excerptId));
  packet.tests = packet.tests.filter(reference => known.has(reference.excerptId));
  packet.configuration = packet.configuration.filter(reference => known.has(reference.excerptId));
  packet.matches = packet.matches.filter(reference => known.has(reference.excerptId));
  const used = new Set([...packet.governingArtifacts, ...packet.definitions, ...packet.callers, ...packet.imports, ...packet.tests, ...packet.configuration, ...packet.matches].map(reference => reference.excerptId));
  packet.excerpts = packet.excerpts.filter(excerpt => used.has(excerpt.id));
}
function packetBytes(packet: ResearchPacketV1): number {
  const serialized = JSON.stringify(packet).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return Buffer.byteLength(serialized);
}
export function buildEvidencePacket(input: EvidenceInput): ResearchPacketV1 {
  const terms = extractSearchTerms(input.query);
  if (!terms.length) throw new InspectContextError('invalid_query', 'query has no searchable terms');
  const omissions = new Omissions();
  for (const group of input.omissions) omissions.add(group.reason, group.count, group.examples ?? []);
  const unknowns: string[] = [];
  const files = scopeFiles(input.files, terms, input.scope, omissions, unknowns);
  const collection = collectCandidates(files, input.query, terms);
  const windows = selectWindows(buildWindows(files, collection.candidates), files, terms);
  const store = new EvidenceStore();
  const expandedBodies = { count: 0 };
  let exactRepresented = 0;
  let fallbackRepresented = 0;
  let ambiguous = false;
  for (const [rank, original] of windows.entries()) {
    const categories: MatchCategory[] = [];
    for (const candidate of original.candidates) {
      for (const category of classifyRetrievedCandidate(candidate.path, files[candidate.fileIndex].lines[candidate.startLine - 1] ?? '', candidate, terms)) appendCategory(categories, category);
    }
    if (categories.length > 1) ambiguous = true;
    const top = original.candidates[0];
    const primary: MatchCategory = primaryKinds.map(kind => categories.find(category => category.kind === kind)).find(category => category !== undefined) ?? { kind: 'match', confidence: 'observed', reason: top.exact ? 'literal match' : top.contentTerms.length ? 'lexical match' : 'path match' };
    const window = prepareEvidenceWindow(files[original.fileIndex], original, primary.kind, terms, expandedBodies, classifyRetrievedCandidate);
    const text = files[window.fileIndex].lines.slice(window.startLine - 1, window.endLine).join('');
    if (!text) continue;
    let matched = store.add(primary.kind, window, text, primary.confidence, primary.reason, rank, window.bodyComplete);
    if (!matched && primary.kind !== 'match') matched = store.add('match', window, text, 'observed', 'lexical match', rank, false);
    if (matched) for (const candidate of window.candidates) {
      if (candidate.exact) exactRepresented++;
      else fallbackRepresented++;
    }
  }
  omissions.add('excerpt_limit', collection.exactObserved - exactRepresented);
  omissions.add('excerpt_limit', collection.fallbackObserved - fallbackRepresented);
  if (!store.excerpts.length) unknowns.push('No lexical matches; retry with an exact symbol, route, config key, or path fragment.');
  else {
    unknowns.push('Lexical evidence, not a call graph.');
    if (ambiguous) unknowns.push('Some matches fit more than one lexical heuristic; inspect surrounding code.');
  }
  if (omissions.total()) unknowns.push('Omissions: zero results do not prove absence.');
  const packet: ResearchPacketV1 = {
    version: 1,
    target: { query: input.query, root: '.', repository: input.repository },
    snapshot: { ...(input.revision === undefined ? {} : { revision: input.revision }), id: input.snapshotId, validated: true },
    governingArtifacts: store.references('governing'), definitions: store.references('definition'), callers: store.references('caller'), imports: store.references('import'), tests: store.references('test'), configuration: store.references('configuration'), matches: store.references('match'),
    excerpts: store.excerpts, unknowns: [...new Set(unknowns)].filter(Boolean).sort(compareText).slice(0, MAX_UNKNOWNS), omissions: omissions.values(),
    receipt: { packetId: hash(`${input.snapshotId}\0${input.query}\0${input.cwd}`), schemaVersion: 1, policyVersion: POLICY_VERSION, snapshotId: input.snapshotId, durationMs: Math.max(0, Math.floor(input.durationMs)), discoveredFiles: input.discoveredFiles, readFiles: input.readFiles, bytesRead: input.bytesRead, excerptCount: store.excerpts.length, omissionCount: omissions.total() },
  };
  retainReferences(packet);
  while (true) {
    packet.receipt.excerptCount = packet.excerpts.length;
    packet.receipt.omissionCount = packet.omissions.reduce((total, group) => total + group.count, 0);
    if (packetBytes(packet) <= targetPacketBytes) return packet;
    if (!packet.excerpts.length) throw new InspectContextError('packet_limit', `packet exceeds compact target of ${targetPacketBytes} bytes`);
    packet.excerpts.pop();
    retainReferences(packet);
    const current = packet.omissions.find(group => group.reason === 'packet_limit');
    if (current) current.count++;
    else packet.omissions.push({ reason: 'packet_limit', count: 1, examples: [] });
    packet.omissions.sort((a, b) => compareText(a.reason, b.reason));
  }
}
