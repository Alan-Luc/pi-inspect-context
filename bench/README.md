# Context measurements

Run commands from the package root with Node 24, Bun 1.3.14 and Go 1.27 for legacy controls.
Install the locked dependency with `npm ci --ignore-scripts --legacy-peer-deps`.
The lockfile omits the host Pi peer dependency, so plain `npm ci` fails.
Build the default worker with `npm run build:typescript`.
Build the retained Go control with `npm run build`.

## Public fixtures

Run `mkdir -p bench/local` before writing reports.
Run `npm run bench -- --samples 10 --output bench/local/fixture.json`.
The runner initializes disposable Git repositories from the committed fixtures.
It performs one warmup per query before at least ten measured calls.
It measures the default extension when that entry exists, including validation, worker transport and model content rendering.
It closes the registered session lifecycle after measurement.
For historical runtime copies without an extension entry, it retains the adapter factory interface.
It reports JSON instead of committing machine-specific results.

The runner records every timed call, including failures.
Failed calls contribute zero recall and label accuracy.
Case failure counts cover timed samples; the summary also counts failed warmups.
Byte and token fields describe the last successful sample, or remain null when none succeeds.
Aggregate byte and token costs remain null if any case has no successful sample.
Any failed call makes the CLI exit nonzero after writing its report.

Interpret recall@5 as expected-path coverage among the first five distinct non-governing excerpt paths.
Interpret label accuracy as expected source-line facts returned under their required roles.
Missing expected facts reduce accuracy instead of disappearing from its denominator.
These are lexical navigation checks, not semantic call-graph proof.
Treat bytes divided by four as a token estimate, not provider usage.

## CI comparison

The pull-request workflow checks out the base and head revisions on one runner.
It uses the head's benchmark and labeled fixtures for both adapters.
This bootstraps comparisons when the base has no fixture benchmark.
It runs two paired measurements and reverses revision order in the second pair.
Each measurement contains at least ten samples per case after warmup.

Run the gate with:

```sh
node bench/compare.mjs BASE1.json CANDIDATE1.json BASE2.json CANDIDATE2.json
```

Any recall or label decrease fails immediately.
A case's p95 latency or model content bytes must exceed the base by more than 10% in both measurements to fail.
A missing or malformed measurement fails instead of passing silently.
Retain all four JSON reports when investigating noise.
Local noise measurements do not establish the hosted runner's noise floor.
Report that floor from repeated same-revision runs on the actual runner.
The workflow has not been executed on GitHub during local development.

## Private inputs

Keep work-repository configuration, queries, packets, session paths, and reports under ignored `bench/local/`.
Use `--config bench/local/config.json` with cases shaped as follows:

```json
{
  "cases": [{
    "id": "local-case",
    "root": "/absolute/repository",
    "cwd": "services/example",
    "query": "exampleSymbol",
    "expected": [{"path": "services/example/source.py", "line": 12, "kind": "definition"}]
  }]
}
```

Choose queries from bounded explorer-session evidence.
Confirm expected paths, lines, and roles directly in source before measuring.
Record source revisions and file hashes in private notes.
Recheck those identities before each phase comparison.
A changed source snapshot invalidates the comparison.
Do not copy private results into CI artifacts or tracked documentation.

## Session followups

Run `node bench/session-metrics.mjs --output bench/local/sessions.json SESSION.jsonl`.
Use explicit local session paths rather than scanning unrelated history.
The analyzer reads persisted tool payloads; it does not change telemetry collection.
It measures read overlap, certified complete-body rereads, unmentioned files opened later, followup calls, and model content bytes.
`redundantReadLines` retains all repeated excerpt lines, including partial context.
`completeBodyRereadLines` counts returned read lines overlapping definitions or callers with `bodyComplete=true`.
Merged ranges prevent duplicate excerpts from counting the same returned line twice.
Use zero complete-body reread lines as the approved read gate; retain partial-context overlap as a separate diagnostic.
This criterion does not establish a productivity improvement.
A file opened later is a coverage observation, not proof the packet should have included it.
Treat missing read ranges and incomplete sessions as unknown rather than zero.
The analyzer rejects missing session identities and inputs without inspect calls.
It refuses to overwrite existing reports.
Treat historical comparisons as observational unless task, source, model, tools, and prompt match.

The inspected installed telemetry collector records tool name, success, duration, derived error signature, session ID, and cwd.
It does not record tool arguments or packet payloads in tool-call events.
It cannot identify overlapping source reads or missed files.
Its timestamps and tool events also lack the final-answer boundary needed for exact followup windows.
Use persisted sessions for that boundary and for source-range analysis.
Use the existing native evaluation kit for fresh Pi observations.
Select the candidate extension explicitly; a working directory does not select the loaded runtime.
