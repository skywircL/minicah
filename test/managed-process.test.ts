import assert from "node:assert/strict";
import test from "node:test";
import { ManagedProcess, Runtime, type ProcessDriver, type ProcessExit, type ProcessHandle } from "../src/index.js";
import { code, deferred, plugin } from "./helpers.js";

test("managed child restart waits for actual closure before starting the next process", async t => {
  const spec = { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] };
  const worker = await ManagedProcess.start(spec, { termTimeoutMs: 1000, killTimeoutMs: 1000 });
  t.after(() => worker.dispose());
  const first = worker.status().pid;
  const result = await worker.restart(spec);
  assert.equal(result.status, "restarted"); assert.equal(result.oldStopped, true);
  assert.notEqual(result.pid, first);
  assert.equal((await worker.stop()).status, "stopped");
  assert.equal(worker.status().state, "stopped");
});

test("SIGTERM timeout escalates to SIGKILL but success requires closure acknowledgement", async () => {
  const closed = deferred<ProcessExit>();
  const signals: string[] = [];
  const handle: ProcessHandle = { pid: 123, closed: closed.promise, signal(signal) {
    signals.push(signal); if (signal === "SIGKILL") closed.resolve({ code: null, signal });
  } };
  const worker = await ManagedProcess.start({ command: "test", args: [] }, { driver: { start: async () => handle }, termTimeoutMs: 5, killTimeoutMs: 5 });
  const result = await worker.stop();
  assert.equal(result.status, "stopped");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.exit!.signal, "SIGKILL");
});

test("unresponsive process is restart-required, keeps its pid, and is never replaced automatically", async () => {
  let spawns = 0;
  const driver: ProcessDriver = { start: async () => { spawns++; return { pid: 456, closed: new Promise(() => {}), signal() {} }; } };
  const worker = await ManagedProcess.start({ command: "stubborn", args: [] }, { driver, termTimeoutMs: 5, killTimeoutMs: 5 });
  const result = await worker.restart({ command: "replacement", args: [] });
  assert.equal(result.status, "restart-required"); assert.equal(result.oldStopped, false);
  assert.equal(result.pid, 456); assert.equal(spawns, 1);
  assert.equal(worker.status().state, "restart-required");
  await assert.rejects(worker.dispose(), code("RESTART_REQUIRED"));
});

test("failed startup after stopping the old child does not claim lossless rollback", async () => {
  const closed = deferred<ProcessExit>();
  let starts = 0;
  const driver: ProcessDriver = { async start() {
    if (++starts > 1) throw new Error("new binary failed");
    return { pid: 123, closed: closed.promise, signal() { closed.resolve({ code: 0, signal: null }); } };
  } };
  const worker = await ManagedProcess.start({ command: "old", args: [] }, { driver });
  const result = await worker.restart({ command: "new", args: [] });
  assert.equal(result.status, "failed"); assert.equal(result.oldStopped, true); assert.equal(result.pid, null);
  assert.equal(worker.status().state, "stopped");
  await worker.dispose();
});

test("failed managed process retirement propagates into Runtime unresolved resource health", async () => {
  const driver: ProcessDriver = { start: async () => ({ pid: 789, closed: new Promise(() => {}), signal() {} }) };
  const runtime = await Runtime.create({ plugins: [plugin("worker", { replacementBoundary: "stop-first", setup(ctx) {
    ctx.resource("third-party-process", () => ManagedProcess.start({ command: "third-party", args: [] }, { driver, termTimeoutMs: 5, killTimeoutMs: 5 }), worker => worker.dispose());
  } })] });
  const result = await runtime.disablePlugin("worker");
  assert.equal(result.status, "restart-required"); assert.equal(result.switched, false);
  assert(runtime.health().unresolved.some(record => record.name === "third-party-process"));
  await assert.rejects(runtime.close(), AggregateError);
});
