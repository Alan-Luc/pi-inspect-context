import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkerResponse } from '../../src/adapter.ts';
import { MAX_PACKET_BYTES } from '../../src/packet.ts';

export function invokeGoOracle(binaryPath, { root, cwd, query }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'inspect-go-oracle-')));
  const manifestPath = join(directory, 'manifest.json');
  try {
    chmodSync(directory, 0o700);
    writeFileSync(manifestPath, JSON.stringify({ version: 1, root }), { mode: 0o600 });
    const request = { version: 1, root, ...(cwd === undefined ? {} : { cwd }), query };
    const result = spawnSync(binaryPath, [], {
      cwd: directory,
      env: {
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
        HOME: '/nonexistent',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        GIT_OPTIONAL_LOCKS: '0',
        INSPECT_CONTEXT_MANIFEST: manifestPath,
      },
      input: JSON.stringify(request),
      maxBuffer: MAX_PACKET_BYTES + 64 * 1024,
      timeout: 2_000,
      shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || result.signal !== null) {
      throw new Error(`Go oracle failed with ${result.signal ?? `exit ${result.status}`}: ${result.stderr.toString('utf8').trim()}`);
    }
    return parseWorkerResponse(result.stdout, query);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
