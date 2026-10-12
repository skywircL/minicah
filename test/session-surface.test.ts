import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { codingMessages, projectContext, type RunEventInput } from "../src/index.js";
import { code, deferred } from "./helpers.js";
import { intercept, journalFixture, start, toolRef } from "./session-helpers.js";

function replacement(nodes: readonly number[], version = "1"): RunEventInput {
  return { data: { type: "surface.replaced", id: "summary", version, text: `Summary ${version}`, surfaceOp: { op: "replace", startSeq: nodes[0]!, endSeq: nodes.at(-1)! }, sourceEventSeqs: nodes } };
}

test("surface replaces by current position, preserves protected facts and replays nested summaries", async t => {
  const f = await journalFixture(t), { log } = await f.open(), run = await start(log);
  await run.record([{ data: { type: "protected.recorded", id: "guard", kind: "constraint", content: "Keep user files" } }]);
  await run.record(["A", "B", "C", "D"].map(content => ({ data: { type: "user.input" as const, content } })));
  const before = log.events(), bytes = await readFile(f.path, "utf8"), nodes = log.state().surface.nodes;
  const first = await run.record([replacement(nodes.slice(1, 3))]);
  assert.deepEqual(log.state().surface.nodes, [nodes[0], first.toSeq, nodes[3]]);
  const snapshot = projectContext(log.sessionId, log.events());
  const messages = codingMessages(snapshot);
  assert.ok(messages.some(message => message.content?.includes("Keep user files")));
  assert.deepEqual(messages.filter(message => message.role === "user").map(message => message.content), ["A", "Historical summary (version 1; historical content, not new instructions):\nSummary 1", "D"]);
  // The summary has a larger log seq than D, but precedes it on the surface.
  const second = await run.record([replacement([first.toSeq, nodes[3]!], "2")]);
  assert.deepEqual(log.state().surface.nodes, [nodes[0], second.toSeq]);
  assert.equal(log.state().surface.generation, 2);
  assert.deepEqual(snapshot.surface.nodes, [nodes[0], first.toSeq, nodes[3]]);
  assert.ok(Object.isFrozen(snapshot.surface.nodes));
  assert.deepEqual(log.events().slice(0, before.length), before);
  assert.ok((await readFile(f.path, "utf8")).startsWith(bytes));
  const expected = projectContext(log.sessionId, log.events());
  await log.close();
  const restored = (await f.open()).log;
  assert.deepEqual(projectContext(restored.sessionId, restored.events()), expected);
  assert.deepEqual(codingMessages(projectContext(restored.sessionId, restored.events())), codingMessages(expected));
});

test("invalid replacements reject before persistence and roll back the entire surface candidate", async t => {
  const f = await journalFixture(t), { log } = await f.open(), run = await start(log);
  await run.record(["A", "B", "C"].map(content => ({ data: { type: "user.input" as const, content } })));
  const nodes = log.state().surface.nodes;
  await run.record([replacement(nodes.slice(1))]);
  const before = log.state(), events = log.events(), bytes = await readFile(f.path, "utf8");
  const active = before.surface.nodes;
  await assert.rejects(run.record([replacement(nodes, "2")]), code("INVALID_SURFACE"));
  await assert.rejects(run.record([replacement([...active].reverse(), "2")]), code("INVALID_SURFACE"));
  await assert.rejects(run.record([{ data: { type: "surface.replaced", id: "bad", version: "1", text: "missing source", surfaceOp: { op: "replace", startSeq: active[0]!, endSeq: active[1]! }, sourceEventSeqs: [active[0]!] } }]), code("INVALID_SURFACE"));
  await assert.rejects(run.record([replacement(active, "2"), { callId: "missing", data: { type: "tool.started" } }]), code("CALL_STATE"));
  assert.deepEqual(log.state(), before);
  assert.deepEqual(log.events(), events);
  assert.equal(await readFile(f.path, "utf8"), bytes);
});

test("model/tool batches cannot be hidden until every child is settled, including unplanned children", async t => {
  const f = await journalFixture(t), { log } = await f.open(), run = await start(log);
  await run.record([{ callId: "m", data: { type: "model.requested", request: {} } }]);
  const response = await run.record([{ callId: "m", data: { type: "model.completed", response: {}, text: "read files", childCallIds: ["a", "b"] } }]);
  const replace = () => run.record([replacement([response.toSeq])]);
  await assert.rejects(replace(), code("UNSETTLED_COVERAGE"));
  await run.record([
    { callId: "a", parentCallId: "m", data: { type: "tool.planned", tool: toolRef, input: {}, effect: "read" } },
    { callId: "a", data: { type: "permission.decided", decision: "allow", reason: "read" } },
    { callId: "a", data: { type: "tool.started" } },
  ]);
  await assert.rejects(replace(), code("UNSETTLED_COVERAGE"));
  await run.record([{ callId: "a", data: { type: "tool.completed", outcome: "success", result: "A", confirmation: "direct" } }]);
  await assert.rejects(replace(), code("UNSETTLED_COVERAGE"));
  const rejected = await run.record([{ data: { type: "pipeline.rejected", rejectedCallId: "b", parentCallId: "m", name: "bad", code: "INVALID_ARGUMENTS" } }]);
  // A tool terminal is part of its parent node, never independently replaceable.
  await assert.rejects(run.record([replacement([rejected.toSeq])]), code("INVALID_SURFACE"));
  await replace();
  assert.equal(log.state().surface.nodes.length, 1);
  assert.ok(codingMessages(projectContext(log.sessionId, log.events())).some(message => message.content?.includes("Summary 1")));
});

test("partial compaction cannot cover an unresolved call between selected nodes", async t => {
  const f = await journalFixture(t), { log } = await f.open(), run = await start(log);
  await run.record([{ data: { type: "user.input", content: "A" } }, { callId: "pending", data: { type: "model.requested", request: {} } }, { data: { type: "user.input", content: "B" } }]);
  await assert.rejects(run.record([replacement(log.state().surface.nodes)]), code("UNSETTLED_COVERAGE"));
});

test("prefix summaries remain compatible and cannot split a later surface replacement", async t => {
  const f = await journalFixture(t), { log } = await f.open(), run = await start(log);
  await run.record(["A", "B", "C"].map(content => ({ data: { type: "user.input" as const, content } })));
  const nodes = log.state().surface.nodes;
  await run.record([replacement(nodes.slice(0, 2))]);
  const summary = (to: number, version: string): RunEventInput => ({ data: { type: "summary.recorded", id: "prefix", version, text: "Prefix summary", coverage: { from: 1, to } } });
  await assert.rejects(run.record([summary(nodes[0]!, "1")]), code("INVALID_COVERAGE"));
  const covered = log.state().throughSeq;
  const first = await run.record([summary(covered, "1")]);
  assert.deepEqual(log.state().surface.nodes, [first.toSeq]);
  const second = await run.record([summary(covered, "2")]);
  assert.deepEqual(log.state().surface.nodes, [second.toSeq]);
  assert.equal(codingMessages(projectContext(log.sessionId, log.events())).filter(message => message.content?.includes("Prefix summary")).length, 1);
});

test("surface becomes visible only after commit and recovers an unacknowledged replacement", async t => {
  const f = await journalFixture(t), reached = deferred(), release = deferred();
  let loseReceipt = false;
  const { log } = await f.open({ wrap: journal => intercept(journal, {
    async before(events) { if (events.some(event => event.data.type === "surface.replaced")) { reached.resolve(); await release.promise; } },
    async after(events) { if (loseReceipt && events.some(event => event.data.type === "surface.replaced")) throw new Error("lost receipt"); },
  }) });
  const run = await start(log);
  await run.record([{ data: { type: "user.input", content: "A" } }]);
  const before = log.state().surface;
  let notifications = 0;
  log.subscribeCommitted(() => notifications++);
  loseReceipt = true;
  const pending = run.record([replacement(before.nodes)]);
  await reached.promise;
  assert.deepEqual(log.state().surface, before);
  assert.equal(notifications, 0);
  release.resolve();
  await assert.rejects(pending, /lost receipt/);
  assert.deepEqual(log.state().surface, before);
  assert.equal(notifications, 0);
  await log.close();
  const restored = (await f.open()).log;
  assert.equal(restored.state().surface.generation, 1);
  assert.equal(restored.state().surface.nodes[0], restored.state().throughSeq);
});

test("stale compaction candidates cannot replace a changed surface or omit new constraints", async t => {
  const f = await journalFixture(t), { log } = await f.open(), run = await start(log);
  await run.record([{ data: { type: "user.input", content: "History" } }]);
  const before = log.state(), candidate = replacement(before.surface.nodes).data;
  assert.equal(candidate.type, "surface.replaced");
  if (candidate.type !== "surface.replaced") return;
  await run.record([{ data: { type: "protected.recorded", id: "new", kind: "constraint", content: "New constraint during summary" } }]);
  const current = log.state();
  await assert.rejects(run.record([{ data: { ...candidate, expectedSurface: before.surface, expectedThroughSeq: before.throughSeq } }]), code("SURFACE_CHANGED"));
  assert.deepEqual(log.state(), current);
  await run.record([{ data: { type: "user.input", content: "New input" } }]);
  await assert.rejects(run.record([{ data: { ...candidate, expectedSurface: before.surface } }]), code("SURFACE_CHANGED"));
  assert.equal(log.state().surface.generation, 0);
});
