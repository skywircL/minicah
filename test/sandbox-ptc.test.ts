import assert from "node:assert/strict";
import test from "node:test";
import { SandboxPtcBackend } from "../src/ptc/docker.js";
import { createPtcPlugin } from "../src/ptc/runtime.js";
import { services } from "../src/services.js";
import type { SandboxProcessResult, SandboxService } from "../src/sandbox/types.js";
import { deferred, plugin, tick } from "./helpers.js";
import { echoTool, pipelineFixture } from "./pipeline-helpers.js";

const execution = { id: "container", profile: { backend: "test", workspace: { mode: "none" } } };
const result = (overrides: Partial<SandboxProcessResult> = {}): SandboxProcessResult => ({ ...execution, exitCode: 0, reason: "exit", cleanup: "verified", code: null, ...overrides });
const sandbox = (run: SandboxService["run"]): SandboxService => ({
  profile: { backend: "test", workspace: "snapshot" }, run,
  async execute() { return { ...result(), stdout: "command", stderr: "" }; },
  health() { return { active: [], unresolved: [], closed: false }; },
});
const request = { program: "return input", input: { value: 1 }, bindings: ["echo"], maxOutputBytes: 4096, concurrency: 2 };
const host = () => ({ signal: new AbortController().signal, cancel() {}, async call() { throw new Error("unexpected call"); } });

test("PTC borrows the shared sandbox with no workspace and waits for confirmed cleanup", async () => {
  const entered = deferred(), cleanup = deferred(); let ended = false, receivedStart = false;
  const backend = new SandboxPtcBackend(sandbox(async (spec, io) => {
    assert.equal(spec.workspace, "none"); assert.equal(spec.cwd, "/tmp");
    assert.equal(spec.command, "node"); assert.equal(spec.maxOutputBytes, request.maxOutputBytes);
    io!.started!({ write(line) {
      const frame = JSON.parse(line);
      assert.equal(frame.type, "start"); assert.equal(frame.program, request.program); receivedStart = true;
    }, endInput() { throw new Error("PTC must keep the reply channel open"); }, terminate() {} });
    io!.stdout!(Buffer.from('{"type":"result","status":"completed","value":7}\n'));
    entered.resolve(); await cleanup.promise; return result();
  }));
  const work = backend.run(request, host()).then(value => { ended = true; return value; });
  await entered.promise; await tick(); assert.equal(ended, false); assert.equal(receivedStart, true);
  cleanup.resolve(); assert.deepEqual(await work, { status: "completed", value: 7, code: null, cleanup: "verified", execution });
  await backend.close(); // This adapter has no ownership of the shared service.
});

test("malformed PTC output cancels Host dispatch and terminates the shared process", async () => {
  let cancellations = 0, terminations = 0, calls = 0;
  const backend = new SandboxPtcBackend(sandbox(async (_spec, io) => {
    io!.started!({ write() {}, endInput() {}, terminate() { terminations++; } });
    io!.stdout!(Buffer.from('not-json\n'));
    io!.stdout!(Buffer.from('{"type":"call","id":"1","name":"echo","input":null}\n'));
    await tick();
    return result({ reason: "cancelled", code: "CANCELLED" });
  }));
  const outcome = await backend.run(request, { ...host(), cancel() { cancellations++; }, async call() { calls++; throw new Error("unexpected"); } });
  assert.equal(outcome.code, "INVALID_PROTOCOL"); assert.equal(outcome.status, "failed");
  assert.equal(cancellations, 1); assert.equal(terminations, 1); assert.equal(calls, 0);
});

test("a successful PTC result cannot hide unconfirmed sandbox cleanup", async () => {
  const backend = new SandboxPtcBackend(sandbox(async (_spec, io) => {
    io!.started!({ write() {}, endInput() {}, terminate() {} });
    io!.stdout!(Buffer.from('{"type":"result","status":"completed","value":7}\n'));
    return result({ cleanup: "unconfirmed", code: "CLEANUP_UNCONFIRMED" });
  }));
  assert.deepEqual(await backend.run(request, host()), { status: "unknown", value: 7, code: "CLEANUP_UNCONFIRMED", cleanup: "unconfirmed", execution });
});

test("shared sandbox cancellation closes PTC input admission immediately", async () => {
  const abort = new AbortController(); let terminated = false, called = false;
  const backend = new SandboxPtcBackend(sandbox(async (_spec, io) => {
    io!.started!({ write() {}, endInput() {}, terminate() { terminated = true; } });
    abort.abort();
    io!.stdout!(Buffer.from('{"type":"call","id":"1","name":"echo","input":null}\n'));
    await tick(); return result({ reason: "cancelled", code: "CANCELLED" });
  }));
  const outcome = await backend.run(request, { signal: abort.signal, cancel() {}, async call() { called = true; throw new Error("unexpected"); } });
  assert.equal(outcome.code, "CANCELLED"); assert.equal(terminated, true); assert.equal(called, false);
});

test("sandbox deadline aborts Host children before the sandbox has finished cleanup", async () => {
  const entered = deferred(), cleanup = deferred(); let hostCancelled = false, returned = false;
  const backend = new SandboxPtcBackend(sandbox(async (_spec, io) => {
    io!.started!({ write() {}, endInput() {}, terminate() {} });
    io!.stopped!("timeout"); entered.resolve();
    await cleanup.promise; return result({ reason: "timeout", code: "DEADLINE_EXCEEDED" });
  }));
  const work = backend.run(request, { ...host(), cancel() { hostCancelled = true; } }).then(value => { returned = true; return value; });
  await entered.promise; assert.equal(hostCancelled, true); assert.equal(returned, false);
  cleanup.resolve(); assert.equal((await work).code, "DEADLINE_EXCEEDED");
});

test("default PTC plugin uses the same pinned sandbox service and keeps Host tool policy", async t => {
  let runs = 0, commands = 0, disposed = false;
  const shared = sandbox(async (_spec, io) => {
    runs++;
    const done = deferred();
    io!.started!({ write(line) {
      const frame = JSON.parse(line);
      if (frame.type === "start") queueMicrotask(() => io!.stdout!(Buffer.from('{"type":"call","id":"1","name":"echo","input":{"text":"hello"}}\n')));
      else {
        assert.equal(frame.result.code, "POLICY_DENIED");
        io!.stdout!(Buffer.from('{"type":"result","status":"completed","value":null}\n')); done.resolve();
      }
    }, endInput() {}, terminate() {} });
    await done.promise; return result();
  });
  const baseExecute = shared.execute;
  const provider = { ...shared, async execute(spec: Parameters<SandboxService["execute"]>[0]) { commands++; return baseExecute(spec); } };
  const fixture = await pipelineFixture(t, [echoTool], { policy: { authorize: () => ({ decision: "deny", reason: "fixture denial" }), assertCurrent() {} } }, false, [
    plugin("shared-sandbox", { provides: [services.sandbox], setup(ctx) { ctx.provide(services.sandbox, () => provider); ctx.onCleanup(() => { disposed = true; }); } }),
    createPtcPlugin(),
  ]);
  await fixture.run(async (_tools, log, run) => {
    assert.equal(run.services.get(services.sandbox), provider);
    await run.services.get(services.sandbox).execute({ command: "true", args: [] });
    const outcome = await run.services.get(services.ptcRuntime).evaluate(request);
    assert.equal(outcome.status, "failed"); assert.equal(outcome.children[0]!.code, "POLICY_DENIED");
    const event = log.events().find(item => item.data.type === "ptc.started")!.data;
    assert.ok(event.type === "ptc.started");
    assert.deepEqual(event.isolation, { sandbox: provider.profile, workspace: "none", protocol: "ptc-json-lines-v1", maxOldGenerationSizeMb: 64 });
    assert.deepEqual(outcome.execution, execution);
    const terminal = log.events().find(item => item.data.type === "ptc.completed")!.data;
    assert.ok(terminal.type === "ptc.completed");
    assert.deepEqual((terminal.result as { execution: unknown }).execution, execution);
  });
  assert.equal(runs, 1); assert.equal(commands, 1); assert.equal(disposed, false);
  await fixture.runtime.close(); assert.equal(disposed, true);
});
