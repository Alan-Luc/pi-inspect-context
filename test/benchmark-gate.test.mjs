import assert from "node:assert/strict";
import test from "node:test";
import { compareMeasurements } from "../bench/compare.mjs";

function report(overrides = {}) {
	return { samplesPerCase: 10, warmupsPerCase: 1, summary: {p95Ms: 100, contentBytes: 1000}, cases: [{ id: "fixture", contractHash: "fixture-v1", recallAt5: 1, labelAccuracy: 1, p95Ms: 100, contentBytes: 1000, ...overrides }] };
}
const pair = (overrides) => ({ base: report(), candidate: report(overrides) });

test("allow unchanged results and a single noisy cost regression", () => {
	assert.equal(compareMeasurements([pair({}), pair({})]).passed, true);
	assert.equal(compareMeasurements([pair({ p95Ms: 120 }), pair({})]).passed, true);
});
test("reject any quality regression, even in only one measurement", () => {
	for (const field of ["recallAt5", "labelAccuracy"]) {
		assert.equal(compareMeasurements([pair({ [field]: 0.99 }), pair({})]).passed, false);
	}
});
test("reject costs over ten percent only in both consecutive measurements", () => {
	for (const field of ["p95Ms", "contentBytes"]) {
		const value = field === "p95Ms" ? 111 : 1101;
		assert.equal(compareMeasurements([pair({ [field]: value }), pair({ [field]: value })]).passed, false);
	}
	assert.equal(compareMeasurements([pair({ p95Ms: 110, contentBytes: 1100 }), pair({ p95Ms: 110, contentBytes: 1100 })]).passed, true);
});
test("do not merge unrelated noisy costs into consecutive failure", () => {
	assert.equal(compareMeasurements([pair({ p95Ms: 120 }), pair({ contentBytes: 1200 })]).passed, true);
});
test("reject repeated aggregate regressions even when different cases cause them", () => {
	const measurements = [pair({}), pair({})];
	for (const measurement of measurements) measurement.candidate.summary.p95Ms = 120;
	assert.equal(compareMeasurements(measurements).passed, false);
});
test("reject comparisons that change query contracts or omit sufficient sampling", () => {
	assert.throws(() => compareMeasurements([pair({contractHash:"different-query"}), pair({})]));
	const measurement = pair({});
	measurement.base.samplesPerCase = 5;
	assert.throws(() => compareMeasurements([measurement, pair({})]));
});
test("fail closed for missing, duplicate, malformed, or incomparable measurements", () => {
	assert.throws(() => compareMeasurements([pair({})]));
	for (const value of [NaN, Infinity, -1, undefined]) {
		assert.throws(() => compareMeasurements([pair({ p95Ms: value }), pair({})]));
	}
	assert.throws(() => compareMeasurements([{ base: report(), candidate: { cases: [] } }, pair({})]));
	const duplicate = report();
	duplicate.cases.push({ ...duplicate.cases[0] });
	assert.throws(() => compareMeasurements([{ base: duplicate, candidate: report() }, pair({})]));
});
