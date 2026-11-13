# pi-inspect-context

A bounded, read-only Pi extension that maps one short symbol, route, config key, path fragment, or concept query to likely governing files, definitions, references, tests, configuration, and complete-line excerpts.

`inspect_context` is a bounded lexical discovery aid, not a semantic call graph. Exact identifiers such as `loadUserProfile`, `/health/ready`, and `CACHE_CONFIG_PATH` work best. For investigations spanning multiple seams, combine 2-5 exact anchors in one query, use the returned paths first, and repeat only for a missing branch. Zero, weak, or materially omitted evidence is not proof of absence; continue with ordinary repository investigation when needed.

## Install

Requirements:

- macOS or Linux
- Node.js 22.19 or newer

Packed releases include the JavaScript worker and require neither Go nor Bun at installation or runtime.
For a local or Git checkout, install Bun 1.3.14 to build the worker during package preparation.

Install the package from a local path with Pi:

```bash
pi-bolt install /path/to/pi-inspect-context
```

Package preparation builds `dist/worker.mjs` with its schema library bundled.
The worker runs in a separate Node process and uses `ffi-rs` for anchored filesystem operations.
The Pi host supplies its peer dependencies; the child worker does not require them.

## Tool

The extension registers one direct, sequential, read-only tool:

```json
{ "query": "short symbol, route, config key, path fragment, or concept" }
```

The root is derived only from Pi's `ctx.cwd`: the containing Git worktree when available, otherwise the validated current directory. Callers cannot supply a root, path, glob, regular expression, or command.

Text `content` contains compact model evidence. `details` and `structuredContent` retain the full validated Research Packet V1. Paths are repository-relative POSIX paths. Candidate classifications are heuristic and omissions and unknowns describe incomplete coverage.

## Bounds

The extension lazily starts one isolated worker and reuses it within the Pi session.
Each call gathers fresh evidence and validates its snapshot; process reuse does not cache evidence.
Changing the authorized root replaces the worker. Session shutdown closes the worker and removes its private state.
V1 has no shared daemon, index, watcher, or dependency graph.

- 4,096 query bytes after Unicode NFC normalization
- 2,000 direct-read admissions; Git mode admits required non-clean/untracked probes first, then at most 64 clean tracked query candidates
- 64 KiB per file
- 8 MiB aggregate direct reads
- 64 excerpts
- 80 complete lines per excerpt
- 48 KiB compact packet
- 2-second worker timeout

For ASCII queries, Git repositories run one bounded fixed-string Git-index search per retained term (at most eight), with at most four searches concurrent, and select clean tracked candidates before direct reads. Query terms are sent through Git stdin, and Git-index scanning is bounded by process output and the worker timeout rather than included in `bytesRead`. Non-clean tracked and non-ignored untracked files are probed through the authorized repository root and count toward every direct-read limit. Queries requiring non-ASCII case folding retain the bounded worker scan.

Git-index search may miss local edits hidden by Git's `assume-unchanged` flag. For ASCII queries, it may also miss Unicode case variants in clean tracked files, such as `kelvin` matching `Kelvin`. Use direct file reads or another search when these limits matter.

Merge conflicts retain the available worktree text. Tracked files intentionally absent from a sparse checkout appear as `ineligible_file` omissions.

Both Git and filesystem modes exclude fixed dependency, generated, build, cache, and agent-state directories (`.pi`, `.opencode`, and `.harness`); non-Git walks do not claim `.gitignore` parity. Snapshot mutation fails the call instead of returning mixed evidence.

## Development

```bash
npm test
npm run bench
npm pack --dry-run --json
```

Development checks require Bun 1.3.14 and Go 1.27 for the retained comparison oracle.
`npm test` runs Node contracts, legacy Go checks, session-worker tests, installed-package acceptance, and registered-handler integration.
Go remains a development comparison dependency, not an installation or runtime requirement.
`npm run build:typescript` builds the default worker. `npm run build` retains the legacy Go build.

`npm run bench` is a small labeled offline retrieval and latency check. It reports relevant-path recall/rank, end-to-end and worker p50/p95 latency, and the ordinary reconnaissance calls each packet is expected to replace. It is not an agent A/B benchmark and does not by itself establish a material workflow speedup.
