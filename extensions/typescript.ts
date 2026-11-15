import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectContextToolDefinition, resolveInspectionRoot, type InspectContextToolOptions } from '../src/adapter.ts';
import { normalizeQuery } from '../src/packet.ts';
import { renderModelEvidence } from '../src/session-model-evidence.ts';
import { PersistentWorkerSession } from '../src/worker/worker-session.ts';

export function registerSessionInspectContext(pi: ExtensionAPI, options: Pick<InspectContextToolOptions, 'timeoutMs'> = {}): void {
  const session = new PersistentWorkerSession({ workerPath: fileURLToPath(new URL('../dist/worker.mjs', import.meta.url)), timeoutMs: options.timeoutMs });
  pi.on('session_shutdown', async () => { await session.close(); });
  pi.registerTool({
    ...inspectContextToolDefinition,
    execute: async (_id: string, params: unknown, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionToolContext) => {
      const query = normalizeQuery(params);
      const rootResolutionStarted = performance.now();
      const root = await resolveInspectionRoot(ctx.cwd, signal);
      const cwd = relative(root, realpathSync(ctx.cwd)).split(sep).join('/') || '.';
      const rootResolutionMs = Math.max(0, performance.now() - rootResolutionStarted);
      const packet = await session.run({ root, query, cwd }, { signal });
      packet.receipt.stageDurationsMs = { ...packet.receipt.stageDurationsMs, rootResolution: rootResolutionMs };
      const renderingStarted = performance.now();
      const text = renderModelEvidence(packet);
      packet.receipt.stageDurationsMs.rendering = Math.max(0, performance.now() - renderingStarted);
      return { content: [{ type: 'text' as const, text }], details: packet, structuredContent: packet };
    },
  });
}
export default registerSessionInspectContext;
