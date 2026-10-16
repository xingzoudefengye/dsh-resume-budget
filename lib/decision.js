/**
 * The decision a resumed session's first model request has to make: is the
 * history about to be sent large enough that compacting it first is worth the
 * detour?
 *
 * Resuming a long session is the one moment where the harness knows the whole
 * history is about to be re-sent, and the one moment where a human is waiting
 * on a request that costs the most it ever will. The check is deliberately
 * narrow: it applies to the first normal request after a resume, it is spent
 * only once a compaction actually succeeded, and it never invents a budget it
 * cannot pay for.
 *
 * Nothing here calls a model or reads a session — the policy is a pure fold so
 * every branch is directly testable.
 *
 * @module dsh-resume-budget/decision
 */

/** Projected-input ceiling for the first request after a resume. */
export const DEFAULT_RESUME_INPUT_TOKENS = 100_000;

/** Why the check declined to compact. */
export const SKIP_REASONS = {
	notPending: "not-pending",
	disabled: "disabled",
	underThreshold: "under-threshold"
};

/**
 * @typedef {object} ResumeCheck
 * @property {boolean} compact - whether the caller must compact before sending.
 * @property {string} reason - `"compact"` or one of {@link SKIP_REASONS}.
 * @property {number} estimatedInputTokens - the projection the decision used.
 * @property {number} thresholdTokens - the ceiling the decision applied.
 */

/**
 * Decide whether a resumed session's first request must compact first.
 *
 * `pending` is the one-shot state the caller owns: it is set when a session is
 * restored and cleared only after a compaction succeeded, so a failed or
 * cancelled attempt leaves it set and the next step re-checks rather than
 * sending the expensive history anyway.
 *
 * Whether there is anything to compact is deliberately *not* an input here.
 * The projection cannot tell the system prefix and tool schemas apart from the
 * history, so the only authority on that question is the compaction backend
 * itself, which answers `null` when it finds no compactable range. Guessing
 * here would either skip a real opportunity or delete the current request to
 * hit a number.
 *
 * @param input - `{ pending, estimatedInputTokens }`.
 * @param options - `{ thresholdTokens }`; `0` disables the check, and a
 *   negative or non-finite value is treated as the default.
 * @returns a {@link ResumeCheck}.
 */
export function shouldCompactOnResume(input, options = {}) {
	const thresholdTokens = normaliseThreshold(options.thresholdTokens);
	const estimatedInputTokens = Math.max(0, Number(input.estimatedInputTokens) || 0);
	const verdict = (compact, reason) => ({ compact, reason, estimatedInputTokens, thresholdTokens });
	if (input.pending !== true) return verdict(false, SKIP_REASONS.notPending);
	if (thresholdTokens === 0) return verdict(false, SKIP_REASONS.disabled);
	if (estimatedInputTokens < thresholdTokens) return verdict(false, SKIP_REASONS.underThreshold);
	return verdict(true, "compact");
}

/**
 * Resolve the configured threshold.
 *
 * @param value - the configured value, if any.
 * @returns `0` to disable, otherwise a positive token count.
 */
export function normaliseThreshold(value) {
	if (value === undefined || value === null) return DEFAULT_RESUME_INPUT_TOKENS;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric < 0) return DEFAULT_RESUME_INPUT_TOKENS;
	return Math.floor(numeric);
}
