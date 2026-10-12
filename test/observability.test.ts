import assert from "node:assert/strict";
import test from "node:test";
import { Runtime, createSessionPlugin, services, type JsonValue, type SessionEvent } from "../src/index.js";
import { createObservabilityPlugin, observabilityService, projectObservability } from "../src/observability/index.js";
import { definitions, intercept, journalFixture, start, toolRef, versions } from "./session-helpers.js";
import { code, deferred } from "./helpers.js";

const response = (usage: { prompt: number; completion: number; total: number } | null, format = "coding-agent-v1"): JsonValue => ({
  format, completion: { usage, message: { role: "assistant", content: "PRIVATE_RESPONSE" }, finishReason: "stop", providerId: "PRIVATE_PROVIDER_ID" },
});
const timed = (events: readonly SessionEvent[]) => events.map(event => ({ ...event, timestamp: new Date(Date.UTC(2026, 0, 1) + event.seq * 1_000).toISOString() }));

test("observability separates provider usage, fallback estimates, unknown failures and compaction model requests", async t => {
  const { log } = await (await journalFixture(t)).open(), run = await start(log);
  await run.record([
    { callId: "model-observed", data: { type: "model.requested", request: { secret: "PRIVATE_REQUEST" }, purpose: "agent" } },
    { callId: "model-observed", data: { type: "model.completed", response: response({ prompt: 80, completion: 20, total: 100 }), text: "PRIVATE_RESPONSE", chargedTokens: 100 } },
    { callId: "model-estimated", data: { type: "model.requested", request: null, purpose: "agent" } },
    { callId: "model-estimated", data: { type: "model.completed", response: response(null), text: "", chargedTokens: 300 } },
    { data: { type: "context.compaction", id: "summary-1", phase: "started", trigger: "pressure", sourceEventSeqs: [], detail: { secret: "PRIVATE_DETAIL" } } },
    { callId: "summary-model", data: { type: "model.requested", request: null, purpose: "compaction" } },
    { callId: "summary-model", data: { type: "model.completed", response: response({ prompt: 40, completion: 10, total: 50 }, "coding-summary-v1"), text: "PRIVATE_SUMMARY", chargedTokens: 50 } },
    { data: { type: "context.compaction", id: "summary-1", phase: "completed", trigger: "pressure", sourceEventSeqs: [], detail: { summaryCallId: "summary-model" } } },
    { data: { type: "context.compaction", id: "summary-2", phase: "started", trigger: "context-overflow", sourceEventSeqs: [], detail: null } },
    { callId: "failed-summary", data: { type: "model.requested", request: null, purpose: "compaction" } },
    { callId: "failed-summary", data: { type: "model.failed", reason: "PRIVATE_ERROR" } },
    { data: { type: "context.compaction", id: "summary-2", phase: "failed", trigger: "context-overflow", sourceEventSeqs: [], detail: { code: "PRIVATE_ERROR" } } },
    { data: { type: "context.measured", measurement: { promptTokens: 200, contextWindow: 4096, unknown: "PRIVATE_METRIC" } } },
    { data: { type: "context.measured", measurement: { promptTokens: 80, contextWindow: 4096 } } },
    { data: { type: "run.finished", status: "failed" } },
  ]);
  const events = timed(log.events()), report = projectObservability(events), metrics = report.runs[0]!;
  assert.deepEqual(metrics.model.all, {
    requests: 4, completed: 3, failed: 1, unfinished: 0, withUsage: 2, missingUsage: 2, completedWithoutUsage: 1,
    observedTokens: { prompt: 120, completion: 30, total: 150 }, chargedTokens: 450, chargedTokenSamples: 3,
    fallbackEstimatedTokens: 300, fallbackEstimatedSamples: 1, unclassifiedChargedTokens: null,
  });
  assert.equal(metrics.model.agent.requests, 2); assert.equal(metrics.model.compaction.requests, 2);
  assert.deepEqual(metrics.model.compaction.observedTokens, { prompt: 40, completion: 10, total: 50 });
  assert.equal(metrics.model.compaction.missingUsage, 1); assert.equal(metrics.model.unspecified.requests, 0);
  assert.deepEqual(metrics.compaction, { attempts: 2, completed: 1, failed: 1, unfinished: 0 });
  assert.deepEqual(metrics.context, { measurements: 2, latestPromptTokens: 80, peakPromptTokens: 200, contextWindow: 4096, prunedToolResults: 0 });
  const observed = report.calls.find(call => call.callId === "model-observed")!;
  assert.equal(observed.durationMs, 1_000); assert.equal(observed.chargedTokensSource, "provider-usage");
  assert.equal(report.calls.find(call => call.callId === "model-estimated")!.chargedTokensSource, "fallback-estimate");
  assert.equal(report.calls.find(call => call.callId === "failed-summary")!.chargedTokens, null);
  assert.equal(report.throughSeq, events.length); assert.equal(metrics.lastSeq, events.length);
  assert.equal(metrics.durationMs, (metrics.lastSeq - metrics.firstSeq) * 1_000);
  assert.equal(report.timingBasis, "committed-event-timestamps");
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|dollar|cost|billing/);
  assert.deepEqual(projectObservability(events), report);
  assert.ok(Object.isFrozen(report)); assert.ok(Object.isFrozen(metrics.model.all.observedTokens));
});

test("trace correlates native/PTC child calls, rejected IDs, permission decisions and unconfirmed cleanup without payloads", async t => {
  const { log } = await (await journalFixture(t)).open(), run = await start(log);
  await run.record([
    { callId: "model", data: { type: "model.requested", request: null } },
    { callId: "model", data: { type: "model.completed", response: null, text: "", childCallIds: ["native", "rejected", "never-dispatched"] } },
    { callId: "native", parentCallId: "model", data: { type: "tool.planned", tool: toolRef, effect: "read", input: { path: "/PRIVATE_WORKSPACE" } } },
    { callId: "native", data: { type: "permission.decided", decision: "allow", reason: "PRIVATE_PERMISSION" } },
    { callId: "native", data: { type: "tool.started" } },
    { callId: "program", parentCallId: "native", data: { type: "ptc.started", program: "PRIVATE_PROGRAM", input: "PRIVATE_INPUT", bindings: ["PRIVATE_BINDING"], backend: "PRIVATE_BACKEND", isolation: { mount: "/PRIVATE_MOUNT" }, limits: { env: "PRIVATE_ENV" } } },
    { callId: "child-ok", parentCallId: "program", data: { type: "tool.planned", tool: toolRef, effect: "read", input: null } },
    { callId: "child-ok", data: { type: "permission.decided", decision: "allow", reason: "" } },
    { callId: "child-ok", data: { type: "tool.started" } },
    { callId: "child-ok", data: { type: "tool.completed", outcome: "success", result: "PRIVATE_TOOL_OUTPUT", confirmation: "direct" } },
    { callId: "child-uncertain", parentCallId: "program", data: { type: "tool.planned", tool: toolRef, effect: "non-idempotent-write", input: null } },
    { callId: "child-uncertain", data: { type: "permission.decided", decision: "allow", reason: "" } },
    { callId: "child-uncertain", data: { type: "tool.started" } },
    { callId: "child-uncertain", data: { type: "tool.uncertain", reason: "PRIVATE_FAILURE" } },
    { callId: "denied", parentCallId: "program", data: { type: "tool.planned", tool: toolRef, effect: "read", input: null } },
    { callId: "denied", data: { type: "permission.decided", decision: "deny", reason: "PRIVATE_POLICY" } },
    { callId: "denied", data: { type: "tool.cancelled", reason: "PRIVATE_POLICY" } },
    { data: { type: "pipeline.rejected", rejectedCallId: "rejected", parentCallId: "model", name: "PRIVATE_TOOL_NAME", code: "PRIVATE_REJECTION" } },
    { callId: "program", data: { type: "ptc.uncertain", result: { status: "unknown", cleanup: "unconfirmed", output: "PRIVATE_RESULT", children: [{ callId: "UNTRUSTED_CHILD" }], execution: { id: "PRIVATE_EXECUTION", profile: "PRIVATE_PROFILE" } } } },
    { callId: "native", data: { type: "tool.uncertain", reason: "PRIVATE_CHILD_ERROR" } },
    { data: { type: "run.finished", status: "failed" } },
  ]);
  const report = projectObservability(timed(log.events())), metrics = report.runs[0]!;
  assert.deepEqual(metrics.tools, { attempts: 5, started: 3, completed: 1, errors: 0, rejected: 1, cancelled: 1, notStarted: 0, unfinished: 2, unknown: 2, expectedButUnplanned: 1 });
  assert.deepEqual(metrics.permissions, { allow: 3, deny: 1 });
  assert.deepEqual(metrics.ptc, { attempts: 1, completed: 0, failed: 0, unknown: 1, unfinished: 1, cleanupVerified: 0, cleanupUnconfirmed: 1, cleanupUnreported: 0 });
  const program = report.calls.find(call => call.callId === "program")!;
  assert.equal(program.parentCallId, "native"); assert.equal(program.endedAt, null); assert.equal(program.endSeq, null); assert.equal(program.durationMs, null);
  const child = report.calls.find(call => call.callId === "child-ok")!;
  assert.equal(child.parentCallId, "program"); assert.equal(child.durationMs, 3_000); assert.equal(child.status, "completed");
  assert.equal(report.calls.find(call => call.callId === "rejected")!.status, "rejected");
  const absent = report.calls.find(call => call.callId === "never-dispatched")!;
  assert.equal(absent.startedAt, null); assert.equal(absent.startSeq, null); assert.equal(absent.durationMs, null); assert.equal(absent.parentCallId, "model");
  assert.equal(report.calls.some(call => call.callId === "UNTRUSTED_CHILD"), false);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|UNTRUSTED_CHILD/);
  // Reconciliation changes the current projection; it does not replay any effects.
  await run.record([
    { callId: "child-uncertain", data: { type: "tool.completed", outcome: "error", result: null, confirmation: "status-query", evidence: null } },
    { callId: "program", data: { type: "ptc.completed", result: { status: "failed", cleanup: "verified" } } },
    { callId: "native", data: { type: "tool.completed", outcome: "error", result: null, confirmation: "direct" } },
  ]);
  const reconciled = projectObservability(timed(log.events())).runs[0]!;
  assert.equal(reconciled.tools.unknown, 0); assert.equal(reconciled.tools.errors, 2);
  assert.equal(reconciled.ptc.failed, 1); assert.equal(reconciled.ptc.cleanupVerified, 1);
});

test("missing usage and unfinished calls stay unknown instead of zero consumption or successful completion", async t => {
  const { log } = await (await journalFixture(t)).open(), run = await start(log);
  await run.record([
    { callId: "custom", data: { type: "model.requested", request: null } },
    { callId: "custom", data: { type: "model.completed", response: { usage: { prompt: 10, completion: 10, total: 20 } }, text: "", chargedTokens: 20 } },
    { callId: "failed", data: { type: "model.requested", request: null, purpose: "agent" } },
    { callId: "failed", data: { type: "model.failed", reason: "TIMEOUT" } },
    { callId: "pending", data: { type: "model.requested", request: null, purpose: "agent" } },
    { callId: "tool", data: { type: "tool.planned", tool: toolRef, effect: "read", input: null } },
    { callId: "tool", data: { type: "permission.decided", decision: "allow", reason: "" } },
    { callId: "tool", data: { type: "tool.started" } },
    { data: { type: "context.compaction", id: "unfinished", phase: "started", trigger: "pressure", sourceEventSeqs: [], detail: null } },
    { data: { type: "run.finished", status: "failed" } },
  ]);
  const report = projectObservability(timed(log.events())), runMetrics = report.runs[0]!;
  assert.deepEqual(runMetrics.model.all.observedTokens, { prompt: null, completion: null, total: null });
  assert.equal(runMetrics.model.all.withUsage, 0); assert.equal(runMetrics.model.all.missingUsage, 3);
  assert.equal(runMetrics.model.all.unclassifiedChargedTokens, 20); assert.equal(runMetrics.model.all.fallbackEstimatedTokens, null);
  assert.equal(runMetrics.model.agent.chargedTokens, null); assert.equal(runMetrics.model.agent.unfinished, 1);
  assert.equal(runMetrics.compaction.unfinished, 1); assert.equal(runMetrics.tools.unknown, 1);
  const pending = report.calls.find(call => call.callId === "pending")!;
  assert.equal(pending.status, "unfinished"); assert.equal(pending.endedAt, null); assert.equal(pending.durationMs, null);
});

test("metadata projection rejects duplicate/mixed/mismatched journals and never fabricates elapsed time", async t => {
  const { log } = await (await journalFixture(t)).open(), run = await start(log);
  await run.record([
    { callId: "m", data: { type: "model.requested", request: null } },
    { callId: "m", data: { type: "model.completed", response: response({ prompt: 0, completion: 0, total: 0 }), text: "", chargedTokens: 0 } },
  ]);
  const events = timed(log.events()), last = events.at(-1)!;
  for (const bad of [
    [...events, last],
    events.slice(1),
    [...events.slice(0, -1), { ...last, sessionId: "other" }],
    [...events.slice(0, -1), { ...last, runId: "other" }],
    [...events.slice(0, -1), { ...last, callId: "other" }],
    [...events.slice(0, -1), { ...last, parentCallId: "other" }],
    [...events.slice(0, -1), { ...last, data: { type: "tool.completed" as const, outcome: "success" as const, result: null, confirmation: "direct" as const } }],
  ]) assert.throws(() => projectObservability(bad), code("INVALID_OBSERVABILITY_EVENTS"));
  const backwards = [...events.slice(0, -1), { ...last, timestamp: "2020-01-01T00:00:00.000Z" }];
  assert.equal(projectObservability(backwards).calls[0]!.durationMs, null);
  const report = projectObservability(events);
  assert.deepEqual(report.runs[0]!.model.all.observedTokens, { prompt: 0, completion: 0, total: 0 });
  assert.equal(report.runs[0]!.model.all.withUsage, 1);
  assert.deepEqual(projectObservability([]), { schemaVersion: 1, sessionId: null, throughSeq: 0, timingBasis: "committed-event-timestamps", runs: [], calls: [] });
});

test("observability plugin reads committed state only, ignores deltas and preserves Session isolation", async t => {
  const fixture = await journalFixture(t);
  const runtime = await Runtime.create({ plugins: [createSessionPlugin({ directory: fixture.directory }), createObservabilityPlugin()] });
  try {
  const session = await runtime.openSession("observed-session");
  let previousRun = "";
  await session.run(async run => {
    previousRun = run.id;
    const log = run.services.get(services.session), observe = run.services.get(observabilityService);
    assert.equal(observe.run("unknown"), null); assert.equal(observe.snapshot().throughSeq, 0);
    await log.retain(definitions); await log.start(versions, { secret: "PRIVATE_CONFIG" });
    await log.record([{ callId: "stream", data: { type: "model.requested", request: null, purpose: "agent" } }]);
    const before = observe.snapshot();
    log.publishDelta({ callId: "stream", channel: "model", text: "PRIVATE_DELTA" });
    assert.strictEqual(observe.snapshot(), before);
    assert.equal(observe.trace(run.id).length, 1); assert.equal(observe.trace("unknown").length, 0);
    await log.record([{ callId: "stream", data: { type: "model.failed", reason: "PRIVATE_ERROR" } }, { data: { type: "run.finished", status: "failed" } }]);
    assert.notStrictEqual(observe.snapshot(), before); assert.equal(observe.run(run.id)!.model.all.failed, 1);
    assert.doesNotMatch(JSON.stringify(observe.snapshot()), /PRIVATE_/);
  });
  await session.run(run => {
    assert.equal(run.services.get(observabilityService).run(previousRun)!.status, "failed");
    assert.equal(run.services.get(observabilityService).run(run.id), null);
  });
  const other = await runtime.openSession("unobserved-session");
  await other.run(run => assert.equal(run.services.get(observabilityService).snapshot().runs.length, 0));
  } finally { await runtime.close(); }
});

test("an in-flight journal append does not become an observed completed model call before commit", async t => {
  const fixture = await journalFixture(t), entered = deferred(), release = deferred();
  const { log } = await fixture.open({ wrap: journal => intercept(journal, { async before(events) {
    if (events.some(event => event.data.type === "model.completed")) { entered.resolve(); await release.promise; }
  } }) });
  const run = await start(log);
  await run.record([{ callId: "inflight", data: { type: "model.requested", request: null, purpose: "agent" } }]);
  const before = projectObservability(log.events());
  const commit = run.record([{ callId: "inflight", data: { type: "model.completed", response: response({ prompt: 1, completion: 1, total: 2 }), text: "", chargedTokens: 2 } }]);
  try {
    await entered.promise;
    assert.deepEqual(projectObservability(log.events()), before);
    assert.equal(before.runs[0]!.model.all.completed, 0);
    assert.equal(before.runs[0]!.model.all.observedTokens.total, null);
  } finally { release.resolve(); await commit; }
  const after = projectObservability(log.events());
  assert.equal(after.runs[0]!.model.all.completed, 1);
  assert.equal(after.runs[0]!.model.all.observedTokens.total, 2);
});
