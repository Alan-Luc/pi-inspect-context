# pi-inspect-context

A bounded, read-only Pi extension that maps one short symbol, route, config key, path fragment, or concept query to likely governing files, definitions, references, tests, configuration, and complete-line excerpts.

`inspect_context` is a bounded lexical discovery aid, not a semantic call graph. Exact identifiers such as `loadUserProfile`, `/health/ready`, and `CACHE_CONFIG_PATH` work best. For investigations spanning multiple seams, combine 2-5 exact anchors in one query, use the returned paths first, and repeat only for a missing branch. Zero, weak, or materially omitted evidence is not proof of absence; continue with ordinary repository investigation when needed.

## Install

Requirements:

- macOS or Linux
- Node.js 22.19 or newer
- Go 1.27 or a compatible toolchain available during installation

Install the package from a local path with Pi:

```bash
pi install /path/to/pi-inspect-context
```

Installation runs the Go tests and builds `bin/inspect-context` for the current platform. The binary is generated locally and is not committed or packaged.

## Tool

The extension registers one direct, sequential, read-only tool:

```json
{ "query": "short symbol, route, config key, path fragment, or concept" }
```

The root is derived only from Pi's `ctx.cwd`: the containing Git worktree when available, otherwise the validated current directory. Callers cannot supply a root, path, glob, regular expression, or command.

The result is the same Research Packet V1 in text `content`, `details`, and `structuredContent`. Paths are repository-relative POSIX paths. Candidate classifications are heuristic and omissions and unknowns describe incomplete coverage.

## Bounds

Each call starts one isolated Go worker, returns one packet, and exits. V1 has no cache, daemon, index, watcher, or dependency graph.

- 4,096 query bytes after Unicode NFC normalization
- 2,000 direct-read admissions; Git mode admits required non-clean/untracked probes first, then at most 64 clean tracked query candidates
- 64 KiB per file
- 8 MiB aggregate direct reads
- 64 excerpts
- 80 complete lines per excerpt
- 48 KiB compact packet
- 2-second worker timeout

For ASCII queries, Git repositories run one bounded fixed-string Git-index search per retained term (at most eight), with at most four searches concurrent, and select clean tracked candidates before direct reads. Query terms are sent through Git stdin, and Git-index scanning is bounded by process output and the worker timeout rather than included in `bytesRead`. Non-clean tracked and non-ignored untracked files are probed through the authorized repository root and count toward every direct-read limit. Queries requiring non-ASCII case folding retain the bounded Go scan.

Both Git and filesystem modes exclude fixed dependency, generated, build, cache, and agent-state directories (`.pi`, `.opencode`, and `.harness`); non-Git walks do not claim `.gitignore` parity. Snapshot mutation fails the call instead of returning mixed evidence.

## Development

```bash
npm test
npm run bench
npm pack --dry-run --json
```

`npm test` runs the Node contract/lifecycle tests, tests and rebuilds the Go worker, then executes the registered Pi handler against the packaged binary.

`npm run bench` is a small labeled offline retrieval and latency check. It reports relevant-path recall/rank, end-to-end and worker p50/p95 latency, and the ordinary reconnaissance calls each packet is expected to replace. It is not an agent A/B benchmark and does not by itself establish a material workflow speedup.
