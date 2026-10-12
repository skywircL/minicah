import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Runtime, createSessionPlugin, createContextPlugin, projectContext, services } from "../src/index.js";
import { code } from "./helpers.js";
import { definitions, journalFixture, start, toolRef, versions } from "./session-helpers.js";

test("compression preserves constraints, protected information, task state, and the original journal", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  await run.record([
    { data: { type: "user.input", content: "Change the code" } },
    { data: { type: "protected.recorded", id: "constraint", kind: "constraint", content: "Never delete customer files" } },
    { data: { type: "protected.recorded", id: "keep", kind: "protected", content: "Keep the compatibility matrix" } },
    { data: { type: "task.status", taskId: "work", status: "running", detail: "Implementation" } },
    { callId: "t1", data: { type: "tool.planned", tool: toolRef, input: { path: "code.ts" }, effect: "read" } },
    { callId: "t1", data: { type: "permission.decided", decision: "allow", reason: "Allowed" } },
  ]);
  await run.executeTool("t1", async () => ({ outcome: "success", result: { source: "old code" } }));
  const before = log.events();
  const prefix = await readFile(fixture.path, "utf8");
  await run.record([{ data: { type: "summary.recorded", id: "summary", version: "1", text: "Inspected the code.", coverage: { from: 1, to: before.length } } }]);
  const context = projectContext(log.sessionId, log.events());
  assert.equal(context.history.length, 0);
  assert.deepEqual(context.constraints.map(event => event.data), [{ type: "protected.recorded", id: "constraint", kind: "constraint", content: "Never delete customer files" }]);
  assert.deepEqual(context.protected.map(event => event.data), [{ type: "protected.recorded", id: "keep", kind: "protected", content: "Keep the compatibility matrix" }]);
  assert.deepEqual(context.tasks.map(event => event.data), [{ type: "task.status", taskId: "work", status: "running", detail: "Implementation" }]);
  assert.equal(context.pendingCalls.length, 0);
  assert.deepEqual(log.events().slice(0, before.length), before);
  assert((await readFile(fixture.path, "utf8")).startsWith(prefix));
  assert.deepEqual(context.summary!.data, { type: "summary.recorded", id: "summary", version: "1", text: "Inspected the code.", coverage: { from: 1, to: before.length } });
  await run.record([{ data: { type: "user.input", content: "Continue" } }]);
  const updated = projectContext(log.sessionId, log.events());
  assert.equal(updated.history.length, 1);
  assert.equal(updated.constraints.length, 1);
  await log.close();
  const recovered = (await fixture.open()).log;
  assert.deepEqual(projectContext(recovered.sessionId, recovered.events()), updated);
});

test("summary coverage cannot hide pending calls or split a completed call/result pair", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  const planned = await run.record([
    { callId: "t1", data: { type: "tool.planned", tool: toolRef, input: {}, effect: "non-idempotent-write" } },
    { callId: "t1", data: { type: "permission.decided", decision: "allow", reason: "Allowed" } },
  ]);
  const summary = (to: number) => run.record([{ data: { type: "summary.recorded", id: "s", version: "1", text: "summary", coverage: { from: 1, to } } }]);
  await assert.rejects(summary(planned.toSeq), code("UNSETTLED_COVERAGE"));
  await run.record([{ callId: "t1", data: { type: "tool.started" } }]);
  await assert.rejects(summary(log.events().length), code("UNSETTLED_COVERAGE"));
  await run.record([{ callId: "t1", data: { type: "tool.completed", outcome: "success", result: "written", confirmation: "status-query", evidence: "remote confirmed" } }]);
  await assert.rejects(summary(planned.toSeq), code("UNSETTLED_COVERAGE"));
  await summary(log.events().length);
  assert.equal(projectContext(log.sessionId, log.events()).pendingCalls.length, 0);
});

test("summary cannot replace protected information, change coverage backwards, or reuse a version", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  await run.record([{ data: { type: "protected.recorded", id: "guard", kind: "constraint", content: "Keep all tests" } }]);
  await assert.rejects(run.record([{ data: { type: "protected.recorded", id: "guard", kind: "constraint", content: "Delete tests" } }]), code("PROTECTED_CONFLICT"));
  const to = log.events().length;
  const summary = { type: "summary.recorded" as const, id: "s", version: "1", text: "summary", coverage: { from: 1 as const, to } };
  await run.record([{ data: summary }]);
  await assert.rejects(run.record([{ data: summary }]), code("SUMMARY_CONFLICT"));
  await assert.rejects(run.record([{ data: { ...summary, version: "2", coverage: { from: 1, to: to - 1 } } }]), code("INVALID_COVERAGE"));
  await assert.rejects(run.record([{ data: { ...summary, version: "2", coverage: { from: 1, to: 999 } } }]), code("INVALID_COVERAGE"));
});

test("pending calls outside summary coverage remain visible as structured context", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  const prefix = log.events().length;
  await run.record([{ callId: "pending", data: { type: "tool.planned", tool: toolRef, input: { important: true }, effect: "read" } }]);
  await run.record([{ data: { type: "summary.recorded", id: "s", version: "1", text: "Initialized", coverage: { from: 1, to: prefix } } }]);
  const context = projectContext(log.sessionId, log.events());
  assert.equal(context.pendingCalls[0]!.callId, "pending");
  assert.equal(context.history[0]!.data.type, "tool.planned");
});

test("Session and Context plugins survive Runtime restart, isolate sessions, and use unique run ids", async t => {
  const fixture = await journalFixture(t);
  const plugins = () => [createContextPlugin(), createSessionPlugin({ directory: fixture.directory })];
  const first = await Runtime.create({ plugins: plugins() });
  let firstRunId = "";
  try {
    const session = await first.openSession("persistent");
    await session.run(async run => {
      firstRunId = run.id;
      const log = run.services.get(services.session);
      await log.retain(definitions);
      await log.start(versions, {});
      await log.record([{ data: { type: "user.input", content: "remember me" } }, { data: { type: "run.finished", status: "completed" } }]);
      assert.equal(run.services.get(services.context).build().history[0]!.data.type, "user.input");
    });
    const isolated = await first.openSession("other");
    await isolated.run(run => assert.equal(run.services.get(services.context).build().history.length, 0));
    // Opening a second writer during staged replacement safely preserves the old one.
    await assert.rejects(first.replacePlugin(createSessionPlugin({ directory: fixture.directory })), code("REPLACEMENT_FAILED"));
  } finally { await first.close(); }
  const second = await Runtime.create({ plugins: plugins() });
  try {
    const session = await second.openSession("persistent");
    await session.run(async run => {
      assert.notEqual(run.id, firstRunId);
      const log = run.services.get(services.session);
      const context = run.services.get(services.context).build();
      assert.equal(context.history[0]!.data.type, "user.input");
      assert.equal(log.state().runs[0]!.runId, firstRunId);
      await log.start(versions, {});
    });
  } finally { await second.close(); }
});
