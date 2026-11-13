import type { ExcerptKind, OmissionGroup } from '../packet.ts';

export type SearchTerm = { original: string; lower: string; codeLike: boolean };
export type RetrievalFile = { path: string; text: string; lines: string[] };
export type RetrievalCandidate = {
  fileIndex: number;
  path: string;
  startLine: number;
  endLine: number;
  exact: boolean;
  contentTerms: number[];
  pathTerms: number[];
  contextTerms: number[];
  score: number;
};
export type RetrievalWindow = {
  fileIndex: number;
  path: string;
  startLine: number;
  endLine: number;
  candidates: RetrievalCandidate[];
  bodyComplete: boolean;
};
export type GitCandidate = { path: string; contentTerms: number[]; pathTerms: number[] };
export type MatchCategory = { kind: ExcerptKind; confidence: 'observed' | 'candidate'; reason: string };
export type ClassifyCandidate = (path: string, line: string, candidate: RetrievalCandidate, terms: SearchTerm[]) => MatchCategory[];
export type EvidenceInput = {
  query: string;
  cwd: string;
  repository: 'git' | 'filesystem';
  revision?: string;
  snapshotId: string;
  files: RetrievalFile[];
  scope: string;
  discoveredFiles: number;
  readFiles: number;
  bytesRead: number;
  omissions: OmissionGroup[];
  durationMs: number;
};
