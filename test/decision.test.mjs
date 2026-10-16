import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RESUME_INPUT_TOKENS, SKIP_REASONS, normaliseThreshold, shouldCompactOnResume } from "../lib/decision.js";

/** A pending check at a given projected size. */
const pending = (estimatedInputTokens) => ({ pending: true, estimatedInputTokens });

test("compacts when a pending check exceeds the default threshold", () => {
	const verdict = shouldCompactOnResume(pending(150_000));
	assert.equal(verdict.compact, true);
	assert.equal(verdict.reason, "compact");
	assert.equal(verdict.thresholdTokens, DEFAULT_RESUME_INPUT_TOKENS);
});

test("does nothing at exactly one token under the threshold", () => {
	assert.equal(shouldCompactOnResume(pending(99_999)).compact, false);
	assert.equal(shouldCompactOnResume(pending(99_999)).reason, SKIP_REASONS.underThreshold);
	assert.equal(shouldCompactOnResume(pending(100_000)).compact, true, "the threshold itself triggers");
});

test("honours a custom threshold", () => {
	assert.equal(shouldCompactOnResume(pending(50_000), { thresholdTokens: 40_000 }).compact, true);
	assert.equal(shouldCompactOnResume(pending(50_000), { thresholdTokens: 60_000 }).compact, false);
});

test("a threshold of zero disables the check entirely", () => {
	const verdict = shouldCompactOnResume(pending(10_000_000), { thresholdTokens: 0 });
	assert.equal(verdict.compact, false);
	assert.equal(verdict.reason, SKIP_REASONS.disabled);
});

test("an unusable threshold falls back to the default rather than to zero", () => {
	assert.equal(normaliseThreshold(undefined), DEFAULT_RESUME_INPUT_TOKENS);
	assert.equal(normaliseThreshold(null), DEFAULT_RESUME_INPUT_TOKENS);
	assert.equal(normaliseThreshold(-1), DEFAULT_RESUME_INPUT_TOKENS);
	assert.equal(normaliseThreshold(Number.NaN), DEFAULT_RESUME_INPUT_TOKENS);
	assert.equal(normaliseThreshold(Number.POSITIVE_INFINITY), DEFAULT_RESUME_INPUT_TOKENS);
	assert.equal(normaliseThreshold("50000"), 50_000, "a numeric string is usable");
	assert.equal(normaliseThreshold(0), 0, "an explicit zero still disables");
});

test("a session with no pending check never compacts", () => {
	const verdict = shouldCompactOnResume({ pending: false, estimatedInputTokens: 900_000 });
	assert.equal(verdict.compact, false);
	assert.equal(verdict.reason, SKIP_REASONS.notPending);
});

test("missing or nonsense projections are treated as zero rather than as a trigger", () => {
	assert.equal(shouldCompactOnResume({ pending: true }).compact, false);
	assert.equal(shouldCompactOnResume({ pending: true, estimatedInputTokens: Number.NaN }).compact, false);
	assert.equal(shouldCompactOnResume({ pending: true, estimatedInputTokens: -5 }).compact, false);
	assert.equal(shouldCompactOnResume({ pending: true, estimatedInputTokens: "120000" }).compact, true, "a numeric string is usable");
});

test("the check is one-shot: once the caller clears pending it stops firing", () => {
	assert.equal(shouldCompactOnResume(pending(150_000)).compact, true);
	assert.equal(shouldCompactOnResume({ ...pending(150_000), pending: false }).compact, false);
});
