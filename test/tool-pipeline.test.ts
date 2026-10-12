import assert from "node:assert/strict";
import test from "node:test";
import { ToolUsageMeter, ToolPipeline, services, contentHash, type ToolDefinition } from "../src/index.js";
import { deferred, tick, code } from "./helpers.js";
import { echoTool, pipelineFixture } from "./pipeline-helpers.js";

test("Host validates exact JSON schemas before policy/metering/execution and audits rejection", async t => {
  let policies = 0, effects = 0;
  const fixture = await pipelineFixture(t, [{ ...echoTool, execute() { effects++; return null; } }], { policy: { authorize() { policies++; return { decision: "allow", reason: "test" }; }, assertCurrent() {} } });
  await fixture.run(async (tools, log) => {
    for (const args of [{ text: 1 }, { text: "ok", extra: 1 }, { text: undefined }]) assert.equal((await tools.invoke("echo", args)).status, "failed");
    assert.equal(policies, 0); assert.equal(effects, 0); assert.equal(tools.state().usage.spentCalls, 0);
    assert.equal(log.events().filter(event => event.data.type === "pipeline.rejected").length, 3);
    assert.equal((await tools.invoke("echo", { text: "ok" })).status, "completed");
    assert.equal(policies, 1); assert.equal(effects, 1);
  });
});

test("native model batches execute concurrently with bounded scheduling and atomic reservations", async t => {
  const gates = [deferred(), deferred(), deferred()]; let active = 0, peak = 0, started = 0;
  const completed: number[] = [];
  const tool: ToolDefinition = { name: "read", description: "parallel", effect: "read", inputSchema: { type: "integer", minimum: 0, maximum: 2 }, async execute(input) {
    started++; peak = Math.max(peak, ++active); await gates[input as number]!.promise; active--; completed.push(input as number); return input;
  } };
  const fixture = await pipelineFixture(t, [tool], { concurrency: 2 });
  await fixture.run(async (tools, log) => {
    const work = tools.invokeMany([0, 1, 2].map(n => ({ callId: `native-${n}`, name: "read", arguments: n })));
    while (started < 2) await tick();
    assert.equal(started, 2); assert.equal(tools.state().scheduler.queued, 1); assert.equal(tools.state().usage.reservedCalls, 3);
    gates[1]!.resolve(); while (started < 3) await tick();
    gates[2]!.resolve(); while (completed.length < 2) await tick();
    assert.deepEqual(completed, [1, 2]);
    gates[0]!.resolve();
    assert.deepEqual((await work).map(result => [result.callId, result.value]), [["native-0", 0], ["native-1", 1], ["native-2", 2]]);
    assert.deepEqual(completed, [1, 2, 0]); assert.equal(peak, 2);
    assert.equal(tools.state().usage.spentCalls, 3);
    assert.equal(log.events().filter(event => event.data.type === "tool.completed").length, 3);
  });
});

test("cumulative calls and cost are measured without limiting dispatch", async t => {
  const fixture = await pipelineFixture(t, [echoTool], { cost: () => 1000 });
  await fixture.run(async (tools, log) => {
    for (let n = 0; n < 105; n++) assert.equal((await tools.invoke("echo", { text: "x" })).status, "completed");
    assert.equal(tools.state().usage.spentCalls, 105);
    assert.equal(tools.state().usage.spentCost, 105000);
    assert.equal(log.events().filter(event => event.data.type === "budget.exited").length, 0);
  });
  const meter = new ToolUsageMeter(), release = meter.reserve(), second = meter.reserve();
  assert.equal(meter.state().reservedCalls, 2);
  release(false); release(true); second(true);
  assert.equal(meter.state().spentCalls, 1); assert.equal(meter.state().reservedCalls, 0);
});

test("native writes need bound approvals while PTC rejects writes even under an allow policy", async t => {
  let writes = 0;
  const fixture = await pipelineFixture(t, [{ ...echoTool, effect: "non-idempotent-write", execute() { writes++; return { saved: true }; } }], { policy: { authorize: () => ({ decision: "allow", reason: "test" }), assertCurrent() {} } }, true);
  await fixture.run(async (tools, log, run) => {
    assert.equal((await tools.invoke("echo", { text: "x" })).code, "APPROVAL_REQUIRED");
    assert.equal((await tools.invoke("echo", { text: "x" }, { source: "ptc" })).code, "POLICY_DENIED");
    const permission = run.services.get(services.permission), args = { text: "x" };
    const approval = permission.request("write-1", "echo", args);
    assert.equal((await tools.invoke("echo", args, { callId: "write-1", approval: { binding: approval.binding, decision: "allow" } })).status, "completed");
    assert.equal(writes, 1);
    assert.ok(log.events().some(event => event.data.type === "permission.decided" && event.data.approval?.approvalId === approval.binding.approvalId));
  });
});

test("queued cancellation releases reservations and never dispatches; policy is rechecked at dispatch", async t => {
  const gate = deferred(); let started = 0, current = true;
  const fixture = await pipelineFixture(t, [{ ...echoTool, async execute() { started++; await gate.promise; return null; } }], { concurrency: 1, policy: { authorize: () => ({ decision: "allow", reason: "test" }), assertCurrent() { if (!current) throw new Error("stale"); } } });
  await fixture.run(async tools => {
    const first = tools.invoke("echo", { text: "1" }); while (!started) await tick();
    const cancel = new AbortController();
    const second = tools.invoke("echo", { text: "2" }, { signal: cancel.signal });
    while (!tools.state().scheduler.queued) await tick(); cancel.abort();
    assert.equal((await second).dispatched, false);
    const third = tools.invoke("echo", { text: "3" });
    while (!tools.state().scheduler.queued) await tick(); current = false; gate.resolve();
    assert.equal((await first).status, "completed"); assert.equal((await third).dispatched, false); assert.equal(started, 1);
    assert.deepEqual(tools.state().usage, { attemptedCalls: 3, spentCalls: 1, spentCost: 1, reservedCalls: 0, reservedCost: 0 });
  });
});

test("stopping the wait keeps live tool slots/reservations and logs unknown, never a fictitious completion", async t => {
  const gate = deferred(); let began = false, sawAbort = false;
  const fixture = await pipelineFixture(t, [{ ...echoTool, async execute(_input, _run, execution) { began = true; execution!.signal.addEventListener("abort", () => { sawAbort = true; }); await gate.promise; return "late"; } }], { cleanupMs: 5, concurrency: 1 });
  await fixture.run(async (tools, log) => {
    const cancel = new AbortController();
    const work = tools.invoke("echo", { text: "x" }, { callId: "stubborn", signal: cancel.signal });
    while (!began) await tick(); cancel.abort(); const result = await work;
    assert.equal(began, true); assert.equal(sawAbort, true); assert.equal(result.status, "unknown"); assert.equal(result.code, "CLEANUP_UNCONFIRMED");
    assert.equal(tools.state().scheduler.active, 1); assert.equal(tools.state().usage.reservedCalls, 1);
    assert.equal(log.recovery().find(call => call.callId === "stubborn")!.status, "uncertain");
    gate.resolve(); await tick(); assert.equal(tools.state().scheduler.active, 0);
    assert.equal(log.events().some(event => event.callId === "stubborn" && event.data.type === "tool.completed"), false);
  });
});

test("invalid children are counted without exhausting admission for valid calls", async t => {
  const fixture = await pipelineFixture(t, [echoTool]);
  await fixture.run(async tools => {
    for (let n = 0; n < 405; n++) await tools.invoke("echo", { wrong: true });
    assert.equal((await tools.invoke("echo", { text: "valid" })).status, "completed");
    assert.equal(tools.state().usage.attemptedCalls, 406); assert.equal(tools.state().usage.spentCalls, 1);
  });
});

test("redacted bounded results are committed before return; redacted inputs retain original approval hash", async t => {
  const fixture = await pipelineFixture(t, [{ ...echoTool, execute() { return { password: "swordfish", value: "x".repeat(4_000), auth: "Bearer secretValue" }; } }], { maxOutputBytes: 256 });
  await fixture.run(async (tools, log) => {
    let committed = false; log.subscribeCommitted(note => { if (note.events.some(event => event.data.type === "tool.completed")) committed = true; });
    const args = { text: "token=abc123456" }, result = await tools.invoke("echo", args);
    assert.equal(committed, true); assert.equal(result.code, "OUTPUT_TRUNCATED"); assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 256);
    assert.doesNotMatch(JSON.stringify(log.events()), /swordfish|secretValue|abc123456/);
    const planned = log.events().find(event => event.data.type === "tool.planned")!.data;
    assert.ok(planned.type === "tool.planned"); assert.equal(planned.inputHash, contentHash(args));
  });
});

test("a thrown tool error can follow a side effect and is unknown without leaking its message", async t => {
  let effects = 0;
  const fixture = await pipelineFixture(t, [{ ...echoTool, execute() { effects++; throw new Error("password=swordfish"); } }]);
  await fixture.run(async (tools, log) => {
    assert.equal((await tools.invoke("echo", { text: "x" })).status, "unknown"); assert.equal(effects, 1);
    assert.doesNotMatch(JSON.stringify(log.events()), /swordfish/);
  });
});

test("a failed durable intent prevents dispatch", async t => {
  let effects = 0;
  const fixture = await pipelineFixture(t, [{ ...echoTool, execute() { effects++; return null; } }]);
  await fixture.run(async (_tools, log, run) => {
    const failing = { ...log, async record(events: Parameters<typeof log.record>[0]) { if (events.some(event => event.data.type === "tool.started")) throw new Error("disk failure"); return log.record(events); } };
    const tools = new ToolPipeline(run, failing);
    assert.equal((await tools.invoke("echo", { text: "x" })).dispatched, false); assert.equal(effects, 0);
  });
});

test("run tracks unawaited pipeline work before tool dispatch and through its terminal commit", async t => {
  const policy = deferred(), executed = deferred(); let entered = false;
  const fixture = await pipelineFixture(t, [{ ...echoTool, execute() { executed.resolve(); return null; } }], { policy: { async authorize() { entered = true; await policy.promise; return { decision: "allow", reason: "test" }; }, assertCurrent() {} } });
  let finished = false;
  const run = fixture.run(async tools => { void tools.invoke("echo", { text: "x" }); }).then(() => { finished = true; });
  while (!entered) await tick(); assert.equal(finished, false);
  policy.resolve(); await executed.promise; await run; assert.equal(finished, true);
});

test("an approval invalidated while queued never reaches a write executor", async t => {
  const gate = deferred(); let entered = false, writes = 0;
  const fixture = await pipelineFixture(t, [{ ...echoTool, async execute() { entered = true; await gate.promise; return null; } }, { ...echoTool, name: "write", effect: "non-idempotent-write", execute() { writes++; return null; } }], { concurrency: 1 }, true);
  await fixture.run(async (tools, _log, run) => {
    const first = tools.invoke("echo", { text: "hold slot" }); while (!entered) await tick();
    const permissions = run.services.get(services.permission), args = { text: "write" };
    const approval = permissions.request("queued-write", "write", args);
    const second = tools.invoke("write", args, { callId: "queued-write", approval: { decision: "allow", binding: approval.binding } });
    while (!tools.state().scheduler.queued) await tick();
    permissions.revoke("queued-write"); gate.resolve(); await first;
    const result = await second; assert.equal(result.dispatched, false); assert.equal(result.status, "failed"); assert.equal(writes, 0);
    assert.equal(tools.state().usage.spentCalls, 1);
  });
});

test("asynchronous tool schemas cannot bypass Host parameter validation", async t => {
  const fixture = await pipelineFixture(t, [{ ...echoTool, inputSchema: { $async: true, type: "string" } }]);
  await assert.rejects(fixture.run(async () => {}), code("INVALID_SCHEMA"));
});

test("recovery refuses to execute redacted audit arguments as original input", async t => {
  const fixture = await pipelineFixture(t, [{ ...echoTool, execute() { throw new Error("uncertain"); } }]);
  await fixture.run(async (tools, log) => {
    await tools.invoke("echo", { text: "password=verySecret" }, { callId: "redacted" });
    assert.equal(log.recovery().find(call => call.callId === "redacted")!.nextAction, "restore-input");
    await assert.rejects(log.executeTool("redacted", async () => { throw new Error("must not execute"); }), code("INPUT_UNAVAILABLE"));
  });
});

test("pipeline limits are validated L1 configuration, pinned to the run and retained by Session", async t => {
  const fixture = await pipelineFixture(t, [echoTool]);
  await fixture.runtime.updateConfig({ "tool-pipeline": { concurrency: 2, maxQueued: 5 } });
  await fixture.run(async (_tools, log, run) => {
    assert.equal((run.configuration.values["tool-pipeline"] as { concurrency: number }).concurrency, 2);
    assert.ok(log.events().some(event => event.data.type === "configuration.recorded" && (event.data.configuration.values["tool-pipeline"] as { maxQueued: number }).maxQueued === 5));
  });
  await assert.rejects(fixture.runtime.updateConfig({ "tool-pipeline": { concurrency: null } }), code("INVALID_CONFIG"));
});

test("asynchronous dispatch policy rechecks fail closed", async t => {
  let executed = false;
  const fixture = await pipelineFixture(t, [{ ...echoTool, execute() { executed = true; return null; } }], { policy: { authorize: () => ({ decision: "allow", reason: "test" }), async assertCurrent() { throw new Error("late rejection"); } } });
  await fixture.run(async tools => {
    const result = await tools.invoke("echo", { text: "x" }); assert.equal(result.code, "ASYNC_POLICY_GUARD"); assert.equal(result.dispatched, false); assert.equal(executed, false);
  });
});
