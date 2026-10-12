import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, definition, reference } from "../src/index.js";
import { code, deferred, tick } from "./helpers.js";
import { definitions, intercept, journalFixture, start, toolRef, versions } from "./session-helpers.js";

test("model request reconstruction retains actual body, configuration, and exact definition contents", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  const request = { messages: [{ role: "user", content: "Do not delete files" }], tools: [{ name: "write-file", inputSchema: { type: "object" } }], temperature: 0 };
  await run.record([
    { data: { type: "user.input", content: "Do not delete files" } },
    { callId: "m1", data: { type: "model.requested", request } },
    { callId: "m1", data: { type: "model.completed", response: { toolCalls: ["t1"] }, text: "" } },
    { callId: "t1", parentCallId: "m1", data: { type: "tool.planned", tool: toolRef, input: { file: "a" }, effect: "non-idempotent-write" } },
    { callId: "t1", data: { type: "permission.decided", decision: "deny", reason: "User forbids writes" } },
    { callId: "t1", data: { type: "tool.cancelled", reason: "Denied" } },
    { data: { type: "budget.exited", budget: "tokens", limit: 100, used: 100, reason: "Budget exhausted" } },
    { data: { type: "task.status", taskId: "task", status: "pending", detail: "Await user" } },
    { data: { type: "run.finished", status: "budget-exited" } },
  ]);
  const newer = definition("model", "test-model", "2", { adapter: "new-model" });
  const newRun = log.forRun("run-2");
  await newRun.retain([newer]);
  await newRun.start({ ...versions, model: reference(newer) }, { temperature: 1 });
  await log.close();
  const { log: recovered } = await fixture.open();
  const rebuilt = recovered.reconstructRequest("m1");
  assert.deepEqual(rebuilt.request, request);
  assert.deepEqual(rebuilt.config, { temperature: 0, maxTokens: 100 });
  assert.deepEqual(rebuilt.definitions, definitions);
  assert.equal(rebuilt.requestEvent.configHash, contentHash(rebuilt.config));
  const cancelled = recovered.events().find(event => event.data.type === "tool.cancelled")!;
  assert.equal(cancelled.parentCallId, "m1");
  assert.equal(cancelled.callId, "t1");
  assert.deepEqual(cancelled.tool, toolRef);
  assert.deepEqual(cancelled.versions, versions);
  assert(recovered.events().every((event, index) => event.seq === index + 1 && !!event.timestamp));
  assert.equal(recovered.state().tasks[0]!.data.type, "task.status");
});

test("hashes alone cannot substitute for retained version definitions", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = log.forRun("run-1");
  await assert.rejects(run.start(versions, {}), code("MISSING_DEFINITION"));
  await run.retain(definitions);
  await assert.rejects(run.retain([{ ...definitions[0]!, content: "tampered" }]), code("DEFINITION_HASH"));
  await assert.rejects(run.retain([definition("prompt", "test-prompt", "1", "changed prompt")]), code("DEFINITION_CONFLICT"));
  await run.start(versions, {});
  await assert.rejects(run.record([{ callId: "x", data: { type: "tool.planned", tool: { ...toolRef, version: "missing" }, input: {}, effect: "read" } }]), code("MISSING_DEFINITION"));
});

test("recovery distinguishes complete, not-started, and uncertain calls without executing anything", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  let executions = 0;
  for (const callId of ["not-started", "complete", "uncertain", "safe", "keyed"]) {
    await run.record([
      { callId, data: { type: "tool.planned", tool: toolRef, input: {}, effect: callId === "safe" ? "idempotent-write" : "non-idempotent-write", ...(callId === "keyed" ? { idempotencyKey: "request-123" } : {}) } },
      { callId, data: { type: "permission.decided", decision: "allow", reason: "test" } },
    ]);
  }
  await run.executeTool("complete", async () => { executions++; return { outcome: "success", result: "written" }; });
  await assert.rejects(run.executeTool("uncertain", async () => { executions++; throw new Error("Connection lost after remote write"); }), /Connection lost/);
  await run.record([
    { callId: "safe", data: { type: "tool.started" } },
    { callId: "keyed", data: { type: "tool.started" } },
    { data: { type: "run.finished", status: "failed" } },
  ]);
  await log.close();
  const { log: recovered } = await fixture.open();
  const calls = new Map(recovered.recovery().map(call => [call.callId, call]));
  assert.equal(calls.get("not-started")!.status, "not-started");
  assert.equal(calls.get("complete")!.status, "confirmed-complete");
  assert.equal(calls.get("uncertain")!.status, "uncertain");
  assert.equal(calls.get("uncertain")!.nextAction, "query-or-confirm");
  assert.equal(calls.get("safe")!.nextAction, "retry-safe");
  assert.equal(calls.get("keyed")!.nextAction, "reconcile-with-key");
  assert.equal(executions, 2);
  await recovered.forRun("run-1").record([{ callId: "uncertain", data: {
    type: "tool.completed", outcome: "success", result: "confirmed written", confirmation: "status-query", evidence: { remoteStatus: "done", operationId: "op-1" },
  } }]);
  assert.equal(recovered.recovery().find(call => call.callId === "uncertain")!.status, "confirmed-complete");
  assert.equal(executions, 2);
});

test("tool execution cannot start until its fsync intent commit succeeds", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open({ durability: "flush", wrap: journal => intercept(journal, {
    async before(events, durability) {
      if (events.some(event => event.data.type === "tool.started")) {
        assert.equal(durability, "fsync");
        throw new Error("intent sync failed");
      }
    },
  }) });
  const run = await start(log);
  await run.record([
    { callId: "t1", data: { type: "tool.planned", tool: toolRef, input: {}, effect: "non-idempotent-write" } },
    { callId: "t1", data: { type: "permission.decided", decision: "allow", reason: "test" } },
  ]);
  let executions = 0;
  await assert.rejects(run.executeTool("t1", async () => { executions++; return { outcome: "success", result: null }; }), /intent sync failed/);
  assert.equal(executions, 0);
  await log.close();
  const { log: recovered } = await fixture.open();
  assert.equal(recovered.recovery()[0]!.status, "not-started");
});

test("external success plus local result-commit failure remains uncertain and is never retried", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open({ wrap: journal => intercept(journal, {
    async before(events) { if (events.some(event => event.data.type === "tool.completed")) throw new Error("disk failed after remote success"); },
  }) });
  const run = await start(log);
  await run.record([
    { callId: "t1", data: { type: "tool.planned", tool: toolRef, input: {}, effect: "non-idempotent-write", idempotencyKey: "remote-key" } },
    { callId: "t1", data: { type: "permission.decided", decision: "allow", reason: "test" } },
  ]);
  let executions = 0;
  await assert.rejects(run.executeTool("t1", async ({ idempotencyKey }) => {
    assert.equal(idempotencyKey, "remote-key"); executions++; return { outcome: "success", result: "remote operation complete" };
  }), /disk failed/);
  await log.close();
  const { log: recovered } = await fixture.open();
  assert.equal(executions, 1);
  assert.equal(recovered.recovery()[0]!.status, "uncertain");
  assert.equal(recovered.recovery()[0]!.nextAction, "reconcile-with-key");
  await assert.rejects(recovered.forRun("run-1").executeTool("t1", async () => { executions++; return { outcome: "success", result: null }; }), code("CALL_STATE"));
  assert.equal(executions, 1);
});

test("not-executed reconciliation requires fresh permission and permits an explicit retry", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  await run.record([
    { callId: "t1", data: { type: "tool.planned", tool: toolRef, input: {}, effect: "non-idempotent-write" } },
    { callId: "t1", data: { type: "permission.decided", decision: "allow", reason: "test" } },
    { callId: "t1", data: { type: "tool.started" } },
    { callId: "t1", data: { type: "tool.not-executed", evidence: { remoteStatus: "never accepted" } } },
  ]);
  await assert.rejects(run.executeTool("t1", async () => ({ outcome: "success", result: null })), code("PERMISSION_REQUIRED"));
  await run.record([{ callId: "t1", data: { type: "permission.decided", decision: "allow", reason: "Confirmed absent, retry approved" } }]);
  await run.executeTool("t1", async () => ({ outcome: "success", result: "done" }));
  assert.equal(run.recovery()[0]!.status, "confirmed-complete");
});

test("denied calls cannot execute, and concurrent executions cannot duplicate the effect", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  await run.record([
    { callId: "t1", data: { type: "tool.planned", tool: toolRef, input: {}, effect: "non-idempotent-write" } },
    { callId: "t1", data: { type: "permission.decided", decision: "deny", reason: "denied" } },
  ]);
  let executions = 0;
  const action = async () => { executions++; return { outcome: "success" as const, result: "done" }; };
  await assert.rejects(run.executeTool("t1", action), code("PERMISSION_REQUIRED"));
  assert.equal(executions, 0);
  await run.record([{ callId: "t1", data: { type: "permission.decided", decision: "allow", reason: "approved" } }]);
  const result = await Promise.allSettled([run.executeTool("t1", action), run.executeTool("t1", action)]);
  assert.equal(result.filter(entry => entry.status === "fulfilled").length, 1);
  assert.equal(executions, 1);
});

test("closing the log waits for an active external operation and its result commit", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  await run.record([
    { callId: "t1", data: { type: "tool.planned", tool: toolRef, input: {}, effect: "read" } },
    { callId: "t1", data: { type: "permission.decided", decision: "allow", reason: "test" } },
  ]);
  const entered = deferred(), release = deferred();
  const executing = run.executeTool("t1", async () => { entered.resolve(); await release.promise; return { outcome: "success", result: "done" }; });
  await entered.promise;
  let closed = false;
  const closing = log.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  release.resolve(); await executing; await closing;
  const reopened = await fixture.open();
  assert.equal(reopened.log.recovery()[0]!.status, "confirmed-complete");
});

test("a tool result cannot override event type or other control metadata", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  await run.record([
    { callId: "t1", data: { type: "tool.planned", tool: toolRef, input: {}, effect: "non-idempotent-write" } },
    { callId: "t1", data: { type: "permission.decided", decision: "allow", reason: "test" } },
  ]);
  await run.executeTool("t1", async () => ({ outcome: "success", result: "done", type: "tool.not-executed", evidence: "spoofed" }));
  assert.equal(log.events().at(-1)!.data.type, "tool.completed");
  assert.equal(run.recovery()[0]!.status, "confirmed-complete");
});
