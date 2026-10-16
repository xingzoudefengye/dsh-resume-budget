/**
 * Resume input budget: before a restored session re-sends its whole history,
 * check the projection and compact first when it is over the ceiling.
 *
 * Resuming is the one moment where the harness knows the entire history is
 * about to be paid for again. The official pressure policy already compacts
 * when a turn crosses a share of the window, but it measures *after* a step is
 * under way, so a session restored at 300k tokens sends that 300k once before
 * anything reacts. This policy moves that single decision forward to the first
 * step of the resumed session and makes it a configurable ceiling rather than
 * a share of the model window.
 *
 * It is deliberately one-shot and non-fatal: the check is spent once a
 * compaction succeeds (or once the projection is under the ceiling), a failure
 * leaves it pending so the next step retries instead of sending the expensive
 * history anyway, and no failure ever breaks the turn.
 *
 * @module dsh-resume-budget
 */

import z from "@deepseek-ai/schemastery";
import { DEFAULT_RESUME_INPUT_TOKENS, shouldCompactOnResume } from "./decision.js";

/** Loader row identity. */
export const name = "resume-budget";

/** The compaction seam and the meter that prices the projection. */
export const inject = ["compaction", "tokenMeter"];

/** Row configuration. */
export const Config = z.object({
	thresholdTokens: z.number().step(1).min(0).default(DEFAULT_RESUME_INPUT_TOKENS)
});

/** One session's position in the check's lifecycle. */
const PENDING = "pending";
const SETTLED = "settled";

/**
 * Whether this session object began with a restored prefix in this process.
 *
 * A session created fresh starts its live log at zero; a restored (or forked)
 * one starts after a stored prefix, which is exactly the state whose first
 * request re-sends history. This is an in-process fact, so it also means the
 * check runs once per process rather than once per session lifetime.
 *
 * @param session - the live session.
 * @returns `true` when the session was restored or forked here.
 */
export function isRestored(session) {
	const live = Number(session?.firstLiveSeq ?? 0);
	const lifecycle = Number(session?.firstLifecycleSeq ?? 0);
	return live > 0 || lifecycle > 0;
}

/**
 * Run the one-shot check for one session, if it is still pending.
 *
 * @param ctx - plugin context carrying the compaction seam and the meter.
 * @param agent - the agent whose step is about to assemble a request.
 * @param signal - the turn's cancellation.
 * @param settings - `{ thresholdTokens }`.
 * @param phases - per-session lifecycle map owned by {@link apply}.
 */
async function checkResumeBudget(ctx, agent, signal, settings, phases) {
	const session = agent.session;
	const id = String(session.id);
	let phase = phases.get(id);
	if (phase === undefined) {
		phase = isRestored(session) ? PENDING : SETTLED;
		phases.set(id, phase);
	}
	if (phase !== PENDING) return;

	const measurement = ctx.tokenMeter.measure(session);
	const verdict = shouldCompactOnResume({ pending: true, estimatedInputTokens: measurement.totalTokens }, settings);
	if (!verdict.compact) {
		phases.set(id, SETTLED);
		return;
	}

	const result = await ctx.compaction.compactNow(agent, signal);
	// A cancelled compaction changed nothing, so the check stays pending and
	// the next step re-decides rather than treating cancellation as consent.
	if (signal.aborted) return;
	phases.set(id, SETTLED);
	if (result === null) {
		ctx.logger.info(`resume budget: projected ${verdict.estimatedInputTokens} tokens exceeds ${verdict.thresholdTokens}, but there was no compactable history`);
		return;
	}
	ctx.logger.info(`resume budget: compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens) before the first request of a resumed session (projected ${verdict.estimatedInputTokens}, threshold ${verdict.thresholdTokens})`);
}

/**
 * Install the resume check.
 *
 * The hook runs before `next()` so the request assembled for this very step
 * sees the compacted surface, and it swallows its own failures: a policy that
 * could fail a turn would be worse than the cost it is trying to avoid.
 *
 * @param ctx - owning cordis context.
 * @param config - row configuration.
 */
export function apply(ctx, config = {}) {
	const settings = { thresholdTokens: config.thresholdTokens ?? DEFAULT_RESUME_INPUT_TOKENS };
	const phases = new Map();
	ctx.effect(() => () => phases.clear());
	ctx.on("session/disposed", (session) => {
		phases.delete(String(session.id));
	});
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		if (!signal.aborted) {
			try {
				await checkResumeBudget(ctx, agent, signal, settings, phases);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.logger.warn(`resume budget: ${message}; continuing the turn`);
			}
		}
		return next();
	});
}
