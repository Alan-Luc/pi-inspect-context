import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runGit, type GitOutput } from './git.ts';

const statusArgs = ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames'];
const untrackedCacheArgs = ['-c', 'core.untrackedCache=true', '-c', 'status.showUntrackedFiles=all', '-c', 'core.splitIndex=false'];
const gitlinkMode = 0o160000;

type RootIndex = { source: string; privatePath: string; copied?: Buffer; usable: boolean; queue: Promise<unknown> };

// Submodule status children inherit optional locks and would refresh the submodule's real index, so gitlinks disable the private path.
function hasGitlinks(index: Buffer): boolean {
  if (index.length < 12 || index.toString('latin1', 0, 4) !== 'DIRC') return true;
  const version = index.readUInt32BE(4);
  if (version < 2 || version > 4) return true;
  let offset = 12;
  for (let remaining = index.readUInt32BE(8); remaining > 0; remaining--) {
    if (offset + 62 > index.length) return true;
    if ((index.readUInt32BE(offset + 24) & 0o170000) === gitlinkMode) return true;
    const extended = version >= 3 && (index.readUInt16BE(offset + 60) & 0x4000) !== 0;
    const pathStart = offset + 62 + (extended ? 2 : 0);
    if (version === 4) {
      let cursor = pathStart;
      while (cursor < index.length && index[cursor] & 0x80) cursor++;
      const end = index.indexOf(0, cursor + 1);
      if (end < 0) return true;
      offset = end + 1;
    } else {
      const end = index.indexOf(0, pathStart);
      if (end < 0) return true;
      offset += (end - offset + 8) & ~7;
    }
  }
  return false;
}

// Status runs against a worker-owned copy of the index so Git may persist its untracked cache without touching the repository.
export class PrivateStatusIndex {
  private directory?: string;
  private counter = 0;
  private readonly roots = new Map<string, Promise<RootIndex | undefined>>();

  async status(rootPath: string, root: number, signal?: AbortSignal): Promise<GitOutput> {
    let cached: GitOutput | undefined;
    try {
      const index = await this.locate(rootPath, root, signal);
      if (index) {
        // Git writes the private index back after status, so overlapping calls would overwrite a fresher copy with a stale one.
        const run = index.queue.then(async () => {
          const privatePath = await this.refresh(index);
          return privatePath ? runGit(root, [...untrackedCacheArgs, ...statusArgs], '', undefined, signal, privatePath) : undefined;
        });
        index.queue = run.catch(() => {});
        const result = await run;
        if (result?.code === 0) cached = result;
      }
    } catch { signal?.throwIfAborted(); }
    return cached ?? runGit(root, statusArgs, '', undefined, signal);
  }

  close(): void {
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
    this.directory = undefined;
    this.roots.clear();
  }

  private locate(rootPath: string, root: number, signal?: AbortSignal): Promise<RootIndex | undefined> {
    let located = this.roots.get(rootPath);
    if (!located) {
      located = runGit(root, ['rev-parse', '--git-path', 'index'], '', 4096, signal).then(result => {
        if (result.code !== 0) return undefined;
        this.directory ??= mkdtempSync(join(tmpdir(), 'inspect-status-index-'));
        return { source: resolve(rootPath, result.stdout.toString().replace(/\n$/, '')), privatePath: join(this.directory, `index-${this.counter++}`), usable: false, queue: Promise.resolve() };
      });
      located.catch(() => this.roots.delete(rootPath));
      this.roots.set(rootPath, located);
    }
    return located;
  }

  private async refresh(index: RootIndex): Promise<string | undefined> {
    const bytes = await readFile(index.source);
    if (!index.copied?.equals(bytes)) {
      index.usable = !hasGitlinks(bytes) && !(await readdir(dirname(index.source))).some(name => name.startsWith('sharedindex.'));
      if (index.usable) {
        const staging = `${index.privatePath}.${this.counter++}`;
        await writeFile(staging, bytes, { mode: 0o600 });
        await rename(staging, index.privatePath);
      }
      index.copied = bytes;
    }
    if (!index.usable) return undefined;
    return index.privatePath;
  }
}
