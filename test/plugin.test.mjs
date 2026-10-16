import assert from "node:assert/strict";
import test from "node:test";
import { apply, isRestored } from "../lib/index.js";

/** A cordis-shaped context that records what the plugin does. */
function fakeContext({ totalTokens = 0, compactIfNeeded } = {}) {
	const handlers = new Map();
	const warnings = [];
	const infos = [];
	const compactions = [];
	return {
		handlers,
		warnings,
		infos,
		compactions,
		logger: { warn: (message) => warnings.push(message), info: (message) => infos.push(message) },
		effect: (body) => {
			const disposer = body();
			return typeof disposer === "function" ? disposer : () => {};
		},
		on: (event, handler) => handlers.set(event, handler),
		tokenMeter: { measure: () => ({ totalTokens }) },
		compaction: {
			compactIfNeeded: async (agent, trigger, signal) => {
				compactions.push({ agent, trigger, signal });
				return compactIfNeeded === undefined ? null : compactIfNeeded(agent, trigger, signal);
			}
		}
	};
}

/** An agent whose session is restored at a given projection. */
const restoredAgent = (id = "s1") => ({ session: { id, firstLiveSeq: 12, firstLifecycleSeq: 12 } });

/** An agent whose session was created in this process. */
const freshAgent = (id = "s2") => ({ session: { id, firstLiveSeq: 0, firstLifecycleSeq: 0 } });

/** Drive one `agent/pre-step` through the registered handler. */
async function step(ctx, agent, signal = new AbortController().signal) {
	const handler = ctx.handlers.get("agent/pre-step");
	let continued = false;
	const decision = await handler({ agent, signal }, async () => {
		continued = true;
		return { kind: "enter", messages: [] };
	});
	return { decision, continued };
}

test("isRestored reads the in-process lifecycle offsets", () => {
	assert.equal(isRestored(restoredAgent().session), true);
	assert.equal(isRestored(freshAgent().session), false);
	assert.equal(isRestored(undefined), false);
	assert.equal(isRestored({}), false);
});

test("a fresh session is settled on first sight and never compacted", async () => {
	let calls = 0;
	const ctx = fakeContext({ totalTokens: 10_000_000, compactIfNeeded: async () => { calls += 1; return null; } });
	apply(ctx, {});
	await step(ctx, freshAgent());
	assert.equal(calls, 0);
});

test("compaction uses the pre-step-safe overflow entry, not the idle-only manual one", async () => {
	// compactNow wraps its work in agent.runMaintenance, which refuses to start
	// mid-turn; at agent/pre-step it fails with "manual compaction requires an
	// idle agent with no waking queued work". The overflow trigger is the branch
	// the official pressure policy uses at this same seam.
	const ctx = fakeContext({
		totalTokens: 150_000,
		compactIfNeeded: async () => ({ shadowedSeqs: [1], shadowedTokenCount: 1 })
	});
	apply(ctx, {});
	await step(ctx, restoredAgent());
	assert.equal(ctx.compactions.length, 1, "exactly one compaction was requested");
	assert.equal(ctx.compactions[0].trigger, "context-overflow");
	assert.equal(ctx.compactions[0].signal instanceof AbortSignal, true, "the turn's signal is forwarded");
});

test("a restored session over the ceiling compacts once, before the step continues", async () => {
	const order = [];
	const ctx = fakeContext({
		totalTokens: 150_000,
		compactIfNeeded: async () => {
			order.push("compact");
			return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 120_000 };
		}
	});
	apply(ctx, {});
	const { continued } = await step(ctx, restoredAgent());
	order.push(`continued:${continued}`);
	assert.deepEqual(order, ["compact", "continued:true"], "compaction lands before the request is assembled");
	assert.match(ctx.infos.join("\n"), /compacted 3 history items/);
});

test("the check is spent after it fires, so later steps do not re-compact", async () => {
	let calls = 0;
	const ctx = fakeContext({ totalTokens: 150_000, compactIfNeeded: async () => { calls += 1; return { shadowedSeqs: [1], shadowedTokenCount: 1 }; } });
	apply(ctx, {});
	const agent = restoredAgent();
	await step(ctx, agent);
	await step(ctx, agent);
	await step(ctx, agent);
	assert.equal(calls, 1);
});

test("a projection under the ceiling settles without compacting", async () => {
	let calls = 0;
	const ctx = fakeContext({ totalTokens: 20_000, compactIfNeeded: async () => { calls += 1; return null; } });
	apply(ctx, {});
	await step(ctx, restoredAgent());
	await step(ctx, restoredAgent());
	assert.equal(calls, 0);
});

test("a custom threshold moves the trigger", async () => {
	let calls = 0;
	const ctx = fakeContext({ totalTokens: 50_000, compactIfNeeded: async () => { calls += 1; return { shadowedSeqs: [], shadowedTokenCount: 0 }; } });
	apply(ctx, { thresholdTokens: 40_000 });
	await step(ctx, restoredAgent());
	assert.equal(calls, 1);
});

test("a threshold of zero disables the policy", async () => {
	let calls = 0;
	const ctx = fakeContext({ totalTokens: 10_000_000, compactIfNeeded: async () => { calls += 1; return null; } });
	apply(ctx, { thresholdTokens: 0 });
	await step(ctx, restoredAgent());
	assert.equal(calls, 0);
});

test("nothing to compact settles the check instead of retrying forever", async () => {
	let calls = 0;
	const ctx = fakeContext({ totalTokens: 150_000, compactIfNeeded: async () => { calls += 1; return null; } });
	apply(ctx, {});
	await step(ctx, restoredAgent());
	await step(ctx, restoredAgent());
	assert.equal(calls, 1);
	assert.match(ctx.infos.join("\n"), /no compactable history/);
});

test("a failed compaction warns, keeps the check pending, and lets the turn continue", async () => {
	let calls = 0;
	const ctx = fakeContext({
		totalTokens: 150_000,
		compactIfNeeded: async () => {
			calls += 1;
			throw new Error("another compaction is active");
		}
	});
	apply(ctx, {});
	const agent = restoredAgent();
	const first = await step(ctx, agent);
	assert.equal(first.continued, true, "the turn is never broken by the policy");
	assert.match(ctx.warnings.join("\n"), /another compaction is active/);
	await step(ctx, agent);
	assert.equal(calls, 2, "a failed attempt is retried on the next step");
});

test("a cancelled compaction leaves the check pending rather than spending it", async () => {
	const controller = new AbortController();
	let calls = 0;
	const ctx = fakeContext({
		totalTokens: 150_000,
		compactIfNeeded: async () => {
			calls += 1;
			controller.abort();
			return { shadowedSeqs: [1], shadowedTokenCount: 1 };
		}
	});
	apply(ctx, {});
	const agent = restoredAgent();
	await step(ctx, agent, controller.signal);
	await step(ctx, agent);
	assert.equal(calls, 2, "the next step re-decides");
});

test("an aborted signal skips the check entirely", async () => {
	let calls = 0;
	const controller = new AbortController();
	controller.abort();
	const ctx = fakeContext({ totalTokens: 150_000, compactIfNeeded: async () => { calls += 1; return null; } });
	apply(ctx, {});
	await step(ctx, restoredAgent(), controller.signal);
	assert.equal(calls, 0);
});

test("each session is tracked separately", async () => {
	const compacted = [];
	const ctx = fakeContext({
		totalTokens: 150_000,
		compactIfNeeded: async (agent) => {
			compacted.push(agent.session.id);
			return { shadowedSeqs: [1], shadowedTokenCount: 1 };
		}
	});
	apply(ctx, {});
	await step(ctx, restoredAgent("a"));
	await step(ctx, restoredAgent("b"));
	await step(ctx, restoredAgent("a"));
	assert.deepEqual(compacted, ["a", "b"]);
});

test("a disposed session forgets its phase", async () => {
	let calls = 0;
	const ctx = fakeContext({ totalTokens: 150_000, compactIfNeeded: async () => { calls += 1; return { shadowedSeqs: [1], shadowedTokenCount: 1 }; } });
	apply(ctx, {});
	const agent = restoredAgent();
	await step(ctx, agent);
	ctx.handlers.get("session/disposed")(agent.session);
	await step(ctx, agent);
	assert.equal(calls, 2, "a re-created session is checked again");
});
