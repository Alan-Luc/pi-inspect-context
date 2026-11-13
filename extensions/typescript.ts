import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInspectContextTool, resolveInspectionRoot, type InspectContextToolOptions } from '../src/adapter.ts';
import { normalizeQuery } from '../src/packet.ts';
import { renderModelEvidence } from '../src/session-model-evidence.ts';
import { PersistentWorkerSession } from '../src/worker/worker-session.ts';

export function registerSessionInspectContext(pi: ExtensionAPI, options: Pick<InspectContextToolOptions, 'timeoutMs'> = {}): void {
  const session = new PersistentWorkerSession({ workerPath: fileURLToPath(new URL('../dist/worker.mjs', import.meta.url)), timeoutMs: options.timeoutMs });
  pi.on('session_shutdown', async () => { await session.close(); });
  pi.registerTool({
    ...createInspectContextTool(),
    execute: async (_id: string, params: unknown, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionToolContext) => {
      const query = normalizeQuery(params);
      const root = await resolveInspectionRoot(ctx.cwd, signal);
      const cwd = relative(root, realpathSync(ctx.cwd)).split(sep).join('/') || '.';
      const packet = await session.run({ root, query, cwd }, { signal });
      return { content: [{ type: 'text' as const, text: renderModelEvidence(packet) }], details: packet, structuredContent: packet };
    },
  });
}
export default registerSessionInspectContext;
