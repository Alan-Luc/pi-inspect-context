import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { constants as operatingSystemConstants } from 'node:os';
import { posix, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import { acquireNativeFiles, NativeFileError, openAt, readDirectory, statAt, type FileMetadata } from './native-files.ts';
import { parseGitLine, parseGitPaths, parseGitMatchPaths, parseGitStatusPaths, runGit, safeRepositoryPath } from './git.ts';
import { buildEvidencePacket, extractSearchTerms, matchingSearchTerms, matchingPathTerms, orderGitCandidates, exclusionReason, exclusionReasonForDirectory, lowercaseSearchText, Omissions, sourceLines } from './retrieval.ts';
import type { GitCandidate, RetrievalFile } from './contracts.ts';
import { AUTHORIZATION_MANIFEST_SCHEMA, WORKER_REQUEST_SCHEMA, MAX_AGGREGATE_READ_BYTES, MAX_DISCOVERED_FILES, MAX_FILE_BYTES, MAX_QUERY_BYTES, InspectContextError, type AuthorizationManifest, type OmissionReason, type ResearchPacketV1, type WorkerRequest } from '../packet.ts';

const fileTypeMask = 0o170000n;
const directoryType = 0o040000n;
const regularType = 0o100000n;
const symlinkType = 0o120000n;
const maxFilesystemEntries = 100_000;
const maxGitCleanCandidates = 64;
const maxGitSearchWorkers = 4;
const packageMarkers = new Set(['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle']);
type InventoryEntry = { path: string; metadata?: FileMetadata; excluded?: OmissionReason };
type Inventory = { kind: 'git' | 'filesystem'; entries: InventoryEntry[]; fingerprint: string; revision?: string; worktree: Set<string> };

function compareText(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hasErrorCode(error: unknown, code: keyof typeof operatingSystemConstants.errno): boolean {
  return error instanceof NativeFileError ? error.errnoCode === operatingSystemConstants.errno[code] : error instanceof Error && 'code' in error && error.code === code;
}
function isType(metadata: FileMetadata, type: bigint): boolean { return (metadata.mode & fileTypeMask) === type; }
function sameMetadata(left: FileMetadata, right: FileMetadata): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size && left.mtimeNs === right.mtimeNs;
}
function sameRoot(left: FileMetadata, right: FileMetadata): boolean { return left.dev === right.dev && left.ino === right.ino; }
function descriptorMetadata(descriptor: number): FileMetadata {
  const stat = fstatSync(descriptor, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeNs: stat.mtimeNs };
}
function goFileMode(metadata: FileMetadata): number {
  const mode = Number(metadata.mode);
  let result = mode & 0o777;
  if (mode & 0o4000) result += 2 ** 23;
  if (mode & 0o2000) result += 2 ** 22;
  if (mode & 0o1000) result += 2 ** 20;
  switch (mode & 0o170000) {
    case 0o040000: result += 2 ** 31; break;
    case 0o120000: result += 2 ** 27; break;
    case 0o060000: result += 2 ** 26; break;
    case 0o020000: result += 2 ** 26 + 2 ** 21; break;
    case 0o010000: result += 2 ** 25; break;
    case 0o140000: result += 2 ** 24; break;
    case 0o100000: break;
    default: result += 2 ** 19;
  }
  return result;
}
function openRoot(root: string): number {
  let descriptor = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of root.slice(1).split('/').filter(Boolean)) {
      const next = openAt(descriptor, component, true);
      closeSync(descriptor);
      descriptor = next;
    }
    return descriptor;
  } catch (error) { closeSync(descriptor); throw error; }
}
function withParent<Result>(root: number, path: string, action: (parent: number, name: string) => Result): Result {
  if (!safeRepositoryPath(path)) throw new InspectContextError('root', `unsafe repository path ${JSON.stringify(path)}`);
  const components = path.split('/');
  let parent = root;
  let owned = false;
  try {
    for (const component of components.slice(0, -1)) {
      const next = openAt(parent, component, true);
      if (owned) closeSync(parent);
      parent = next;
      owned = true;
    }
    return action(parent, components[components.length - 1]);
  } finally { if (owned) closeSync(parent); }
}
function metadataAt(root: number, path: string): FileMetadata {
  const metadata = withParent(root, path, statAt);
  if (isType(metadata, symlinkType)) throw new InspectContextError('root', `repository path ${JSON.stringify(path)} is a symlink`);
  return metadata;
}
function openPath(root: number, path: string, directory = false): number {
  return withParent(root, path, (parent, name) => openAt(parent, name, directory));
}
function readBounded(descriptor: number): Buffer {
  const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(descriptor, bytes, length, bytes.length - length, null);
    if (count === 0) return bytes.subarray(0, length);
    length += count;
  }
  throw new InspectContextError('snapshot_changed', 'file grew beyond the admitted read bound');
}
function fileFingerprint(entry: InventoryEntry): string {
  const metadata = entry.metadata;
  return metadata ? `${entry.path}\0${goFileMode(metadata)}\0${metadata.size}\0${metadata.mtimeNs}\0${entry.excluded ?? ''}\0` : `${entry.path}\0missing\0${entry.excluded ?? ''}\0`;
}
function nearestScope(root: number, cwd: string, inventory: Inventory): string {
  if (!cwd || cwd === '.') return '.';
  if (!isType(metadataAt(root, cwd), directoryType)) throw new InspectContextError('root', `cwd ${JSON.stringify(cwd)} is not a directory`);
  const packages = new Set(inventory.entries.filter(entry => !entry.excluded && packageMarkers.has(posix.basename(entry.path))).map(entry => posix.dirname(entry.path)));
  for (let directory = cwd; directory !== '.'; directory = posix.dirname(directory)) if (packages.has(directory)) return directory;
  return '.';
}
function localPath(path: string, scope: string): boolean { return scope === '.' || path.startsWith(`${scope}/`); }
async function collectInventory(rootPath: string, root: number, signal?: AbortSignal): Promise<Inventory> {
  signal?.throwIfAborted();
  let marker: FileMetadata | undefined;
  try { marker = metadataAt(root, '.git'); }
  catch (error) { if (!hasErrorCode(error, 'ENOENT')) throw error; }
  const entries: InventoryEntry[] = [];
  if (!marker) {
    let visited = 0;
    const walk = (descriptor: number, directory: string) => {
      signal?.throwIfAborted();
      for (const name of readDirectory(descriptor).sort(compareText)) {
        const path = directory ? `${directory}/${name}` : name;
        if (++visited > maxFilesystemEntries) throw new InspectContextError('inventory', 'filesystem entry traversal exceeded 100000 entries');
        if (!safeRepositoryPath(path)) throw new InspectContextError('inventory', `unsafe filesystem path ${JSON.stringify(path)}`);
        const metadata = statAt(descriptor, name);
        if (isType(metadata, symlinkType)) throw new InspectContextError('inventory', `filesystem candidate path ${JSON.stringify(path)} is a symlink`);
        if (isType(metadata, directoryType)) {
          const excluded = exclusionReasonForDirectory(path);
          if (excluded) { entries.push({ path, metadata, excluded }); continue; }
          const child = openAt(descriptor, name, true);
          try {
            if (!sameMetadata(metadata, descriptorMetadata(child))) throw new InspectContextError('snapshot_changed', `directory changed before traversal: ${path}`);
            walk(child, path);
          } finally { closeSync(child); }
        } else {
          if (!isType(metadata, regularType)) throw new InspectContextError('inventory', `filesystem candidate path ${JSON.stringify(path)} is not a regular file`);
          entries.push({ path, metadata, excluded: exclusionReason(path) });
        }
      }
    };
    walk(root, '');
    const fingerprint = createHash('sha256').update(entries.map(fileFingerprint).join('')).digest('hex');
    return { kind: 'filesystem', entries: entries.sort((a, b) => compareText(a.path, b.path)), fingerprint, worktree: new Set() };
  }
  const top = await runGit(root, ['rev-parse', '--show-toplevel'], '', 4096, signal);
  if (top.code !== 0) throw new InspectContextError('inventory', `Git top-level discovery failed: ${top.stderr.toString().trim()}`);
  const topPath = parseGitLine(top.stdout, 'Git top-level');
  if (resolve(topPath) !== topPath || realpathSync(topPath) !== rootPath) throw new InspectContextError('root', 'Git top-level does not match the authorized root');
  const outcomes = await Promise.allSettled([
    runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], '', 4096, signal),
    runGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], '', undefined, signal),
    runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames'], '', undefined, signal),
  ]);
  const [head, listing, status] = outcomes.map(outcome => {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });
  let revision: string | undefined;
  if (head.code !== 1 || head.stdout.length || head.stderr.length) {
    if (head.code !== 0) throw new InspectContextError('inventory', `Git HEAD failed: ${head.stderr.toString().trim()}`);
    revision = parseGitLine(head.stdout, 'Git HEAD');
  }
  if (listing.code !== 0) throw new InspectContextError('inventory', `Git inventory failed: ${listing.stderr.toString().trim()}`);
  const paths = parseGitPaths(listing.stdout);
  const known = new Set<string>();
  for (const path of paths) {
    if (known.has(path)) throw new InspectContextError('inventory', `Git inventory contains duplicate path ${JSON.stringify(path)}`);
    known.add(path);
    entries.push({ path, excluded: exclusionReason(path) });
  }
  if (status.code !== 0) throw new InspectContextError('inventory', `Git status failed: ${status.stderr.toString().trim()}`);
  const worktree = new Set(parseGitStatusPaths(status.stdout, known));
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const path of worktree) {
    const entry = byPath.get(path);
    if (!entry) throw new InspectContextError('inventory', 'Git status path is absent from inventory');
    try { entry.metadata = metadataAt(root, path); }
    catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
      entry.excluded ??= 'ineligible_file';
      continue;
    }
    if (!entry.excluded && !isType(entry.metadata, regularType)) throw new InspectContextError('inventory', `candidate path ${JSON.stringify(path)} is not a regular file`);
  }
  const fingerprint = createHash('sha256');
  fingerprint.update(revision === undefined ? 'unborn\0' : `HEAD\0${revision}\0`);
  fingerprint.update(`inventory\0${listing.stdout.length}\0`).update(listing.stdout);
  fingerprint.update(`status\0${status.stdout.length}\0`).update(status.stdout);
  for (const entry of entries) fingerprint.update(`worktree\0${fileFingerprint(entry)}`);
  return { kind: 'git', entries: entries.sort((a, b) => compareText(a.path, b.path)), fingerprint: fingerprint.digest('hex'), revision, worktree };
}

export class InspectionEngine {
  private readonly release = acquireNativeFiles();
  private closed = false;
  private active = 0;
  private readonly idle: (() => void)[] = [];
  private closing?: Promise<void>;
  async close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = (async () => {
        if (this.active > 0) await new Promise<void>(resolveIdle => this.idle.push(resolveIdle));
        this.release();
      })();
    }
    await this.closing;
  }
  async inspect(request: unknown, authorization: unknown, signal?: AbortSignal): Promise<ResearchPacketV1> {
    if (this.closed) throw new InspectContextError('closed', 'inspection engine is closed');
    signal?.throwIfAborted();
    if (!Value.Check(AUTHORIZATION_MANIFEST_SCHEMA, authorization)) throw new InspectContextError('authorization', 'invalid authorization manifest');
    if (!Value.Check(WORKER_REQUEST_SCHEMA, request)) throw new InspectContextError('protocol', 'request failed the closed worker schema');
    this.active++;
    try { return await this.inspectSnapshot(request, authorization, signal); }
    finally {
      this.active--;
      if (this.active === 0) for (const resolveIdle of this.idle.splice(0)) resolveIdle();
    }
  }
  private async inspectSnapshot(request: WorkerRequest, authorization: AuthorizationManifest, signal?: AbortSignal): Promise<ResearchPacketV1> {
    if (request.root !== authorization.root) throw new InspectContextError('authorization', 'request root is not authorized by manifest');
    const query = request.query;
    if (!query || query.includes('\0') || Buffer.byteLength(query) > MAX_QUERY_BYTES || !/[\p{L}\p{N}_]/u.test(query) || Buffer.from(query).toString('utf8') !== query) throw new InspectContextError('protocol', 'query is not valid bounded searchable UTF-8');
    if (!request.root.startsWith('/') || resolve(request.root) !== request.root || request.root.includes('\0') || realpathSync(request.root) !== request.root) throw new InspectContextError('root', 'authorized root must be clean, canonical and symlink-free');
    const cwd = request.cwd ?? '';
    if (cwd !== '' && cwd !== '.' && !safeRepositoryPath(cwd)) throw new InspectContextError('root', 'cwd must be a safe root-relative directory');
    const started = performance.now();
    const root = openRoot(request.root);
    try {
      const rootIdentity = descriptorMetadata(root);
      const initial = await collectInventory(request.root, root, signal);
      const scope = nearestScope(root, cwd, initial);
      const terms = extractSearchTerms(query);
      if (!terms.length) throw new InspectContextError('protocol', 'query has no searchable terms');
      const omissions = new Omissions();
      const eligible = initial.entries.filter(entry => {
        if (!entry.excluded) return true;
        omissions.add(entry.excluded, 1, [entry.path]);
        return false;
      });
      const files: RetrievalFile[] = [];
      const accepted = new Map<string, FileMetadata>();
      let discoveredFiles = 0;
      let readFiles = 0;
      let bytesRead = 0;
      const admit = (entry: InventoryEntry): RetrievalFile | undefined => {
        signal?.throwIfAborted();
        discoveredFiles++;
        let expected: FileMetadata;
        try { expected = entry.metadata ?? metadataAt(root, entry.path); }
        catch (error) { throw new InspectContextError('snapshot_changed', `inspect ${JSON.stringify(entry.path)} before read: ${errorMessage(error)}`); }
        if (!isType(expected, regularType)) throw new InspectContextError('snapshot_changed', `file is not regular: ${entry.path}`);
        if (expected.size > BigInt(MAX_FILE_BYTES)) { omissions.add('oversized_file', 1, [entry.path]); return; }
        if (BigInt(bytesRead) + expected.size > BigInt(MAX_AGGREGATE_READ_BYTES)) { omissions.add('aggregate_byte_limit', 1, [entry.path]); return; }
        let descriptor: number;
        try { descriptor = openPath(root, entry.path); }
        catch (error) {
          if (hasErrorCode(error, 'ELOOP') || hasErrorCode(error, 'ENOTDIR')) throw new InspectContextError('snapshot_changed', `file changed before open: ${entry.path}`);
          omissions.add('read_error', 1, [entry.path]);
          return;
        }
        let bytes: Buffer;
        let after: FileMetadata;
        try {
          if (!sameMetadata(descriptorMetadata(descriptor), expected)) throw new InspectContextError('snapshot_changed', `file changed before read: ${entry.path}`);
          try { bytes = readBounded(descriptor); }
          catch (error) {
            if (error instanceof InspectContextError) throw error;
            omissions.add('read_error', 1, [entry.path]);
            return;
          }
          after = descriptorMetadata(descriptor);
          if (!sameMetadata(after, expected) || BigInt(bytes.length) !== after.size) throw new InspectContextError('snapshot_changed', `file changed during read: ${entry.path}`);
        } finally { closeSync(descriptor); }
        readFiles++;
        bytesRead += bytes.length;
        accepted.set(entry.path, after);
        if (bytes.includes(0)) { omissions.add('binary_file', 1, [entry.path]); return; }
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { omissions.add('invalid_utf8', 1, [entry.path]); return; }
        const file = { path: entry.path, text, lines: sourceLines(text) };
        files.push(file);
        return file;
      };
      if (initial.kind === 'git' && terms.every(term => /^[\x00-\x7f]*$/.test(term.original))) {
        const byPath = new Map(initial.entries.map(entry => [entry.path, entry]));
        const worktree = eligible.filter(entry => initial.worktree.has(entry.path)).sort((a, b) => Number(localPath(b.path, scope)) - Number(localPath(a.path, scope)) || Number(matchingPathTerms(lowercaseSearchText(b.path), terms).length > 0) - Number(matchingPathTerms(lowercaseSearchText(a.path), terms).length > 0) || compareText(a.path, b.path));
        const worktreeContent = new Map<string, number[]>();
        for (const entry of worktree) {
          if (discoveredFiles >= MAX_DISCOVERED_FILES) { omissions.add('file_limit', 1, [entry.path]); continue; }
          const file = admit(entry);
          if (file) worktreeContent.set(file.path, matchingSearchTerms(lowercaseSearchText(file.text), terms));
        }
        const known = new Set(byPath.keys());
        const contentByPath = new Map<string, number[]>();
        for (let start = 0; start < terms.length; start += maxGitSearchWorkers) {
          const outcomes = await Promise.all(terms.slice(start, start + maxGitSearchWorkers).map(term => runGit(root, ['grep', '--cached', '-F', '-i', '-I', '-l', '-z', '-f', '-', '--'], `${term.original}\n`, undefined, signal)));
          for (const [offset, outcome] of outcomes.entries()) {
            if (outcome.code === 1) continue;
            if (outcome.code !== 0) throw new InspectContextError('scan', `Git grep failed: ${outcome.stderr.toString().trim()}`);
            for (const path of parseGitMatchPaths(outcome.stdout, known)) {
              if (initial.worktree.has(path) || byPath.get(path)?.excluded) continue;
              contentByPath.set(path, [...(contentByPath.get(path) ?? []), start + offset]);
            }
          }
        }
        const candidates: GitCandidate[] = eligible.filter(entry => !initial.worktree.has(entry.path)).map(entry => ({ path: entry.path, contentTerms: contentByPath.get(entry.path) ?? [], pathTerms: matchingPathTerms(lowercaseSearchText(entry.path), terms) })).filter(candidate => candidate.contentTerms.length || candidate.pathTerms.length);
        const frequencies = terms.map((_, index) => [...candidates, ...worktree.map(entry => ({ path: entry.path, contentTerms: worktreeContent.get(entry.path) ?? [], pathTerms: matchingPathTerms(lowercaseSearchText(entry.path), terms) }))].filter(candidate => new Set([...candidate.contentTerms, ...candidate.pathTerms]).has(index)).length);
        const ordered = orderGitCandidates(candidates, query, terms, frequencies, candidates.length).sort((a, b) => Number(localPath(b.path, scope)) - Number(localPath(a.path, scope)));
        const remaining = Math.max(0, Math.min(maxGitCleanCandidates, MAX_DISCOVERED_FILES - discoveredFiles));
        for (const [index, candidate] of ordered.entries()) {
          if (index >= remaining) { omissions.add('file_limit', 1, [candidate.path]); continue; }
          const entry = byPath.get(candidate.path);
          if (!entry) throw new InspectContextError('scan', 'ordered candidate is absent from inventory');
          admit(entry);
        }
      } else {
        const ordered = [...eligible].sort((a, b) => (initial.kind === 'git' ? Number(initial.worktree.has(b.path)) - Number(initial.worktree.has(a.path)) : 0) || compareText(a.path, b.path))
          .sort((a, b) => Number(localPath(b.path, scope)) - Number(localPath(a.path, scope)));
        for (const [index, entry] of ordered.entries()) {
          if (index >= MAX_DISCOVERED_FILES) { omissions.add('file_limit', 1, [entry.path]); continue; }
          admit(entry);
        }
      }
      signal?.throwIfAborted();
      let final: Inventory;
      try { final = await collectInventory(request.root, root, signal); }
      catch (error) { throw new InspectContextError('snapshot_changed', `final inventory: ${errorMessage(error)}`); }
      if (initial.kind !== final.kind || initial.revision !== final.revision || initial.fingerprint !== final.fingerprint) throw new InspectContextError('snapshot_changed', 'repository snapshot changed during scan');
      try {
        const currentRoot = openRoot(request.root);
        try { if (!sameRoot(rootIdentity, descriptorMetadata(currentRoot))) throw new InspectContextError('snapshot_changed', 'authorized root changed during scan'); }
        finally { closeSync(currentRoot); }
        for (const [path, expected] of accepted) {
          if (!sameMetadata(metadataAt(root, path), expected)) throw new InspectContextError('snapshot_changed', `accepted file changed during scan: ${path}`);
        }
      } catch (error) {
        if (error instanceof InspectContextError && error.code === 'snapshot_changed') throw error;
        throw new InspectContextError('snapshot_changed', `verify accepted snapshot: ${errorMessage(error)}`);
      }
      return buildEvidencePacket({ query, cwd, repository: initial.kind, revision: initial.revision, snapshotId: initial.fingerprint, files, scope, discoveredFiles, readFiles, bytesRead, omissions: omissions.values(), durationMs: performance.now() - started });
    } finally { closeSync(root); }
  }
}
