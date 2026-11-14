import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvidencePacket, sourceLines } from '../../src/worker/retrieval.ts';
import { MAX_PACKET_BYTES, packetByteLength } from '../../src/packet.ts';
import { renderModelEvidence } from '../../src/session-model-evidence.ts';

test('timing diagnostics preserve evidence at the compact packet boundary', () => {
  const inputFor = padding => {
    const text = `needle ${'x'.repeat(padding)}\n`;
    return {
      query: 'needle', cwd: '.', scope: '.', repository: 'filesystem', snapshotId: 'snapshot',
      files: [{ path: 'source.txt', text, lines: sourceLines(text) }],
      discoveredFiles: 1, readFiles: 1, bytesRead: Buffer.byteLength(text), durationMs: 0, omissions: [],
    };
  };
  const overhead = packetByteLength(buildEvidencePacket(inputFor(0)));
  const input = inputFor(32_730 - overhead);
  const reference = buildEvidencePacket(input);
  assert.equal(reference.excerpts.length, 1);
  assert.ok(packetByteLength(reference) > 32_700);
  assert.ok(packetByteLength(reference) <= 32_768);
  const timed = buildEvidencePacket({ ...input, stageDurationsMs: { discovery: 1, directReads: 2, retrievalRanking: 3, finalSnapshot: 4 } });
  assert.equal(renderModelEvidence(timed), renderModelEvidence(reference));
  assert.deepEqual(timed.excerpts, reference.excerpts);
  assert.ok(packetByteLength(timed) <= MAX_PACKET_BYTES);
});
