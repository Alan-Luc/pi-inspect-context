import type { FileFinderApi, InitOptions, MultiGrepOptions, Result } from '@ff-labs/fff-node';
import { MAX_DISCOVERED_FILES, MAX_OVERSIZED_SCAN_BYTES, InspectContextError } from '../packet.ts';
import type { SearchTerm } from './contracts.ts';
import { safeRepositoryPath } from './git.ts';

type FinderResult = Result<FileFinderApi>;
export type FinderFactory = (options: Pick<InitOptions, 'basePath' | 'followSymlinks' | 'disableMmapCache' | 'disableContentIndexing'>) => FinderResult;
type ReadyFinder = Extract<FinderResult, { ok: true }>['value'];
type NativeSearchOptions = Pick<MultiGrepOptions, 'patterns' | 'pageSize' | 'maxFileSize' | 'maxMatchesPerFile' | 'timeBudgetMs' | 'enforceTimeBudget' | 'smartCase' | 'beforeContext' | 'afterContext' | 'classifyDefinitions'>;

type Owner = { root: string; identity: string; finder?: ReadyFinder };

const readyTimeoutMs = 150;
const searchBudgetMs = 75;
const maxPatterns = 8;
const maxPageSize = 64;

export class ResidentDiscovery {
  private owner?: Owner;
  private createFinder?: FinderFactory;
  private tail: Promise<void> = Promise.resolve();

  constructor(createFinder?: FinderFactory) {
    if (createFinder) this.createFinder = createFinder;
  }

  async search(root: string, identity: string, terms: SearchTerm[], allowedPaths: ReadonlySet<string>, inventoryEntryCount: number): Promise<string[] | undefined> {
    return this.exclusive(async () => {
      if (!this.owner || this.owner.root !== root || this.owner.identity !== identity) {
        this.destroyOwned();
        this.owner = { root, identity };
      }
      const owner = this.owner;
      if (inventoryEntryCount > MAX_DISCOVERED_FILES) return undefined;
      try {
        if (!this.createFinder) {
          const { FileFinder } = await import('@ff-labs/fff-node');
          this.createFinder = options => FileFinder.create(options);
        }
        if (!owner.finder) {
          const loaded = this.createFinder({ basePath: root, followSymlinks: false, disableMmapCache: true, disableContentIndexing: true });
          if (!loaded.ok) return undefined;
          owner.finder = loaded.value;
        }
        const finder: FileFinderApi = owner.finder;
        if (finder.isScanning()) return undefined;
        const ready = await finder.waitForIndexReady(readyTimeoutMs);
        const progress = finder.getScanProgress();
        if (!ready.ok || !ready.value || !progress.ok || !progress.value || finder.isScanning() || progress.value.isScanning || !progress.value.isWarmupComplete || !progress.value.isWatcherReady) return undefined;
        const patterns = terms.map(term => term.lower);
        if (!patterns.length || patterns.length > maxPatterns || patterns.some(pattern => !pattern.length || Buffer.byteLength(pattern) > 128)) return undefined;
        const options: NativeSearchOptions = {
          patterns,
          pageSize: maxPageSize,
          maxFileSize: MAX_OVERSIZED_SCAN_BYTES,
          maxMatchesPerFile: 1,
          timeBudgetMs: searchBudgetMs,
          enforceTimeBudget: true,
          smartCase: true,
          beforeContext: 0,
          afterContext: 0,
          classifyDefinitions: false,
        };
        const result = finder.multiGrep(options);
        if (!result.ok || result.value.nextCursor !== null || result.value.totalFilesSearched !== allowedPaths.size || result.value.filteredFileCount !== allowedPaths.size || result.value.totalFiles !== allowedPaths.size) return undefined;
        const indexed = finder.glob('**', { pageSize: allowedPaths.size + 1 });
        if (!indexed.ok) return undefined;
        const indexedPaths = new Set(indexed.value.items.map(item => item.relativePath));
        if (indexedPaths.size !== allowedPaths.size || [...indexedPaths].some(path => !allowedPaths.has(path))) return undefined;
        return [...new Set(result.value.items.map(item => item.relativePath).filter(path => safeRepositoryPath(path) && allowedPaths.has(path)))];
      } catch {
        return undefined;
      }
    });
  }

  async discard(root: string, identity: string): Promise<void> {
    await this.exclusive(() => {
      if (this.owner?.root === root && this.owner.identity === identity) this.destroyOwned();
    });
  }

  async close(): Promise<void> {
    await this.exclusive(() => this.destroyOwned());
  }

  private destroyOwned(): void {
    const finder = this.owner?.finder;
    this.owner = undefined;
    if (!finder) return;
    try { finder.destroy(); }
    catch { throw new InspectContextError('cleanup', 'native finder cleanup failed'); }
  }

  private async exclusive<T>(action: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let unlock = () => {};
    this.tail = new Promise<void>(resolveUnlock => { unlock = resolveUnlock; });
    await previous;
    try { return await action(); }
    finally { unlock(); }
  }
}
