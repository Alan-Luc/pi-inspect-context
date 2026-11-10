import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const qualityFields = ["recallAt5", "labelAccuracy"];
const costFields = ["p95Ms", "contentBytes"];

function casesById(report) {
	if (!Array.isArray(report?.cases) || report.cases.length === 0) throw new Error("measurement requires cases");
	if (!Number.isInteger(report.samplesPerCase) || report.samplesPerCase < 10 || !Number.isInteger(report.warmupsPerCase) || report.warmupsPerCase < 1) {
		throw new Error("measurement requires at least ten samples after warmup");
	}
	for (const field of costFields) {
		if (!Number.isFinite(report.summary?.[field]) || report.summary[field] < 0) throw new Error(`invalid summary ${field}`);
	}
	const cases = new Map();
	for (const entry of report.cases) {
		if (typeof entry.id !== "string" || !entry.id || cases.has(entry.id)) throw new Error("case IDs must be nonempty and unique");
		if (typeof entry.contractHash !== "string" || !entry.contractHash) throw new Error("case requires a query contract hash");
		for (const field of [...qualityFields, ...costFields]) {
			if (!Number.isFinite(entry[field]) || entry[field] < 0 || (qualityFields.includes(field) && entry[field] > 1)) {
				throw new Error(`invalid ${field} for ${entry.id}`);
			}
		}
		cases.set(entry.id, entry);
	}
	return cases;
}

export function compareMeasurements(measurements) {
	if (!Array.isArray(measurements) || measurements.length !== 2) throw new Error("provide two consecutive paired measurements");
	const failures = [];
	const costRegressions = new Map();
	const recordCosts = (scope, id, before, after, round) => {
		for (const field of costFields) {
			if (after[field] * 10 > before[field] * 11) {
				const key = JSON.stringify([scope, id, field]);
				costRegressions.set(key, [...(costRegressions.get(key) ?? []), { scope, id, field, round: round + 1, base: before[field], candidate: after[field] }]);
			}
		}
	};
	let expectedCases;
	let expectedIds;
	for (const [round, measurement] of measurements.entries()) {
		const base = casesById(measurement.base);
		const candidate = casesById(measurement.candidate);
		const ids = JSON.stringify([...base.keys()].sort());
		if (ids !== JSON.stringify([...candidate.keys()].sort()) || (expectedIds !== undefined && expectedIds !== ids)) {
			throw new Error("measurements must contain identical case IDs");
		}
		expectedIds = ids;
		for (const [id, before] of base) {
			const after = candidate.get(id);
			if (after.contractHash !== before.contractHash || (expectedCases && expectedCases.get(id).contractHash !== before.contractHash)) {
				throw new Error(`query contract changed for ${id}`);
			}
			for (const field of qualityFields) {
				if (after[field] < before[field]) failures.push({ id, field, round: round + 1, base: before[field], candidate: after[field] });
			}
			recordCosts("case", id, before, after, round);
		}
		recordCosts("summary", "all", measurement.base.summary, measurement.candidate.summary, round);
		expectedCases ??= base;
	}
	for (const rounds of costRegressions.values()) {
		if (rounds.length === 2) failures.push(...rounds);
	}
	return { passed: failures.length === 0, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const paths = process.argv.slice(2);
	if (paths.length !== 4) throw new Error("usage: compare.mjs BASE1 CANDIDATE1 BASE2 CANDIDATE2");
	const [base1, candidate1, base2, candidate2] = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
	const result = compareMeasurements([{ base: base1, candidate: candidate1 }, { base: base2, candidate: candidate2 }]);
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	if (!result.passed) process.exitCode = 1;
}
