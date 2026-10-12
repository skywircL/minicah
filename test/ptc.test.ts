import assert from "node:assert/strict";
import test from "node:test";
import { PtcRuntime, createPtcPlugin, services, projectPtcOutput, type IsolationBackend, type ToolResult } from "../src/index.js";
import { echoTool, pipelineFixture } from "./pipeline-helpers.js";
import { code, deferred, tick } from "./helpers.js";
import { ControlChannel } from "../src/ptc/protocol.js";

const backend = (run: IsolationBackend["run"]): IsolationBackend => ({ id: "test-only-no-isolation", profile: { testOnly: true }, run, async close() {} });
const request = { program: "return input", input: null, bindings: ["echo"] };

test("PTC and native children share validation, policy, atomic usage and durable parent linkage", async t => {
  const fixture = await pipelineFixture(t, [echoTool], { concurrency: 2 });
  await fixture.run(async (tools, log) => {
    const runner = new PtcRuntime(backend(async (_request, host) => {
      const results = await Promise.all([host.call("echo", { text: "one" }), host.call("echo", { text: "two" })]);
      return { status: "completed", value: results.map(result => result.value), code: null, cleanup: "verified" };
    }), tools, log);
    const results = await Promise.all([runner.evaluate({ ...request, callId: "program-1" }), tools.invoke("echo", { text: "native" })]);
    assert.equal(tools.state().usage.spentCalls, 3);
    assert.equal(results[0].children.length, 2);
    assert.ok(results[0].children.every(child => child.parentCallId === "program-1"));
    assert.equal([results[1], ...results[0].children].filter(child => child.status === "completed").length, 3);
    assert.ok(log.events().some(event => event.callId === "program-1" && event.data.type === "ptc.completed"));
  });
});

test("PTC rejects write bindings before launching and does not inherit permission from program admission", async t => {
  let launched = 0, executed = 0;
  const fixture = await pipelineFixture(t, [echoTool, { ...echoTool, name: "write", effect: "non-idempotent-write", execute() { executed++; return null; } }], { policy: { authorize: () => ({ decision: "deny", reason: "not in workspace" }), assertCurrent() {} } });
  await fixture.run(async (tools, log) => {
    const runner = new PtcRuntime(backend(async (_request, host) => { launched++; await host.call("echo", { text: "x" }); return { status: "completed", value: null, code: null, cleanup: "verified" }; }), tools, log);
    await assert.rejects(runner.evaluate({ ...request, bindings: ["write"] }), code("PTC_BINDING")); assert.equal(launched, 0);
    const result = await runner.evaluate(request); assert.equal(result.children[0]!.code, "POLICY_DENIED"); assert.equal(result.status, "failed"); assert.equal(executed, 0);
  });
});

test("Host rejects out-of-binding calls, even from a forged control channel adapter", async t => {
  let ran = 0;
  const fixture = await pipelineFixture(t, [{ ...echoTool, execute() { ran++; return null; } }]);
  await fixture.run(async (tools, log) => {
    const runner = new PtcRuntime(backend(async (_request, host) => { await host.call("unbound", null); return { status: "completed", value: null, code: null, cleanup: "verified" }; }), tools, log);
    assert.equal((await runner.evaluate(request)).status, "unknown"); assert.equal(ran, 0);
  });
});

test("partial results survive program failure and the whole program is never automatically replayed", async t => {
  let calls = 0;
  const fixture = await pipelineFixture(t, [{ ...echoTool, execute(input) { calls++; if (calls === 2) throw new Error("side effect may already exist"); return input; } }]);
  await fixture.run(async (tools, log) => {
    const runner = new PtcRuntime(backend(async (_request, host) => {
      await host.call("echo", { text: "ok" }); await host.call("echo", { text: "uncertain" });
      return { status: "failed", value: null, code: "PROGRAM_FAILED", cleanup: "verified" };
    }), tools, log);
    const result = await runner.evaluate({ ...request, callId: "partial" });
    assert.deepEqual(result.children.map(child => child.status), ["completed", "unknown"]); assert.equal(result.status, "unknown"); assert.equal(calls, 2);
    assert.equal(log.recovery().find(call => call.callId === "partial")!.nextAction, "query-or-confirm");
    await assert.rejects(log.record([{ data: { type: "summary.recorded", id: "unsafe", version: "1", coverage: { from: 1, to: log.events().length }, text: "finished" } }]), code("UNSETTLED_COVERAGE"));
  });
});

test("cancellation stops new dispatch, propagates to active tools and waits for verified cleanup", async t => {
  const cleanup = deferred(), active = deferred(); let started = 0, aborted = false;
  const fixture = await pipelineFixture(t, [{ ...echoTool, async execute(_input, _run, execution) { started++; active.resolve(); execution!.signal.addEventListener("abort", () => { aborted = true; }); await cleanup.promise; return null; } }]);
  await fixture.run(async (tools, log) => {
    const external = new AbortController();
    const runner = new PtcRuntime(backend(async (_request, host) => {
      const work = host.call("echo", { text: "x" });
      await new Promise<void>(resolve => host.signal.addEventListener("abort", () => resolve(), { once: true }));
      await assert.rejects(host.call("echo", { text: "late" }), code("CANCELLED"));
      await work;
      return { status: "failed", value: null, code: "CANCELLED", cleanup: "verified" };
    }), tools, log, { cleanupMs: 500 });
    let returned = false;
    const work = runner.evaluate(request, external.signal).then(result => { returned = true; return result; });
    await active.promise; external.abort(); await tick(); assert.equal(aborted, true); assert.equal(returned, false);
    cleanup.resolve(); const result = await work;
    assert.equal(result.cleanup, "verified"); assert.equal(result.status, "failed"); assert.equal(started, 1);
  });
});

test("unconfirmed sandbox cleanup is unknown and blocks another evaluation", async t => {
  const fixture = await pipelineFixture(t, [echoTool]);
  await fixture.run(async (tools, log) => {
    const entered = deferred(), cancel = new AbortController();
    const runner = new PtcRuntime(backend(async () => { entered.resolve(); return new Promise(() => {}); }), tools, log, { cleanupMs: 5 });
    const work = runner.evaluate(request, cancel.signal); await entered.promise; cancel.abort();
    const result = await work; assert.equal(result.status, "unknown"); assert.equal(result.cleanup, "unconfirmed");
    await assert.rejects(runner.evaluate(request), code("PTC_UNAVAILABLE"));
  });
});

test("PTC audit keeps bounded redacted evidence while model projection alone is compressed", async t => {
  const fixture = await pipelineFixture(t, [echoTool]);
  await fixture.run(async (tools, log) => {
    const runner = new PtcRuntime(backend(async () => ({ status: "completed", code: null, cleanup: "verified", value: { token: "sensitive", data: "x".repeat(1_000) } })), tools, log, { maxOutputBytes: 2_000 });
    const result = await runner.evaluate({ ...request, program: "const password='password=swordfish'; return input" });
    const before = JSON.stringify(log.events()), projection = projectPtcOutput(result, 128);
    assert.equal(result.output.truncated, false); assert.ok(JSON.stringify(projection).length < JSON.stringify(result).length);
    assert.equal(before, JSON.stringify(log.events())); assert.doesNotMatch(before, /sensitive|swordfish/);
  });
});

function channel(overrides = {}) {
  const calls: unknown[] = [], replies: string[] = []; let aborted = false;
  const value = new ControlChannel({ ...request, maxOutputBytes: 2_048, concurrency: 2, ...overrides }, async (name, input) => {
    calls.push({ name, input }); return { callId: "host-generated", parentCallId: "parent", status: "completed", value: input, code: null, dispatched: true } satisfies ToolResult;
  }, line => replies.push(line), () => { aborted = true; }, 4_096);
  return { value, calls, replies, aborted: () => aborted };
}
test("untrusted protocol rejects extra authorization/identity fields, duplicate ids, invalid JSON and trailing frames", async t => {
  const call = { type: "call", id: "1", name: "echo", input: { text: "x" } };
  for (const [label, lines] of Object.entries({ forged: [JSON.stringify({ ...call, approvalId: "approved", parentCallId: "fake" })], duplicate: [JSON.stringify(call), JSON.stringify(call)], invalid: ["not json"], unbound: [JSON.stringify({ ...call, name: "write" })], trailing: [JSON.stringify({ type: "result", status: "completed", value: null }), JSON.stringify(call)] })) await t.test(label, async () => {
    const instance = channel(); instance.value.output(Buffer.from(lines.join("\n") + "\n")); await tick();
    assert.equal(instance.aborted(), true); assert.equal(instance.calls.length, 0);
  });
});
test("protocol handles chunked JSON, bounds stdout/stderr and rejects incomplete result", async () => {
  const instance = channel();
  const line = JSON.stringify({ type: "call", id: "1", name: "echo", input: { text: "你好" } }) + "\n";
  for (const byte of Buffer.from(line)) instance.value.output(Buffer.from([byte])); await tick();
  assert.equal(instance.calls.length, 1); assert.equal(instance.replies.length, 1);
  instance.value.output(Buffer.from(JSON.stringify({ type: "result", status: "completed", value: 1 }) + "\n")); instance.value.finish(); assert.equal(instance.value.result!.value, 1);
  const excessive = channel({ maxOutputBytes: 16 }); excessive.value.output(Buffer.alloc(17), false); assert.equal(excessive.value.failure, "OUTPUT_LIMIT");
  const incomplete = channel(); incomplete.value.output(Buffer.from("{")); incomplete.value.finish(); assert.equal(incomplete.value.failure, "INCOMPLETE_PROTOCOL");
});

test("PTC plugin tracks whole evaluation in the run and records isolation profile and limits", async t => {
  const gate = deferred(); let entered = false, closed = false;
  const fixture = await pipelineFixture(t, [echoTool], {}, false, [createPtcPlugin(() => ({
    ...backend(async () => { entered = true; await gate.promise; return { status: "completed", value: 1, code: null, cleanup: "verified" }; }),
    async close() { closed = true; },
  }), { concurrency: 2 })]);
  let done = false;
  const work = fixture.run(async (_tools, _log, run) => { void run.services.get(services.ptcRuntime).evaluate(request); }).then(() => { done = true; });
  while (!entered) await tick(); assert.equal(done, false); gate.resolve(); await work;
  await fixture.run(async (_tools, log, run) => {
    assert.equal((run.configuration.values.ptc as { concurrency: number }).concurrency, 2);
    const event = log.events().find(event => event.data.type === "ptc.started")!.data;
    assert.ok(event.type === "ptc.started"); assert.deepEqual(event.isolation, { testOnly: true });
  });
  await fixture.runtime.close(); assert.equal(closed, true);
});

test("PTC deadline requests cancellation and waits for the backend cleanup acknowledgement", async t => {
  const fixture = await pipelineFixture(t, [echoTool]);
  await fixture.run(async (tools, log) => {
    let cancelled = false;
    const runner = new PtcRuntime(backend(async (_request, host) => {
      await new Promise<void>(resolve => host.signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
      return { status: "failed", value: null, code: "DEADLINE", cleanup: "verified" };
    }), tools, log, { deadlineMs: 500 });
    const result = await runner.evaluate(request); assert.equal(cancelled, true); assert.equal(result.cleanup, "verified"); assert.equal(result.status, "failed");
  });
});

test("a PTC program can exceed the old hundred-call quota with bounded concurrency", async t => {
  const fixture = await pipelineFixture(t, [echoTool]);
  await fixture.run(async (tools, log) => {
    const runner = new PtcRuntime(backend(async (_request, host) => {
      for (let index = 0; index < 105; index++) assert.equal((await host.call("echo", { text: "read" })).status, "completed");
      return { status: "completed", value: "done", code: null, cleanup: "verified" };
    }), tools, log);
    const result = await runner.evaluate(request);
    assert.equal(result.status, "completed"); assert.equal(result.children.length, 105);
    assert.equal(tools.state().usage.spentCalls, 105);
  });
});
