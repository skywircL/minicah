import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { FileJournal, contentHash } from "../src/index.js";
import { code, deferred } from "./helpers.js";
import { intercept, journalFixture, start } from "./session-helpers.js";

test("terminal notifications follow the defined commit; UI deltas never become journal facts", async t => {
  const fixture = await journalFixture(t);
  const reached = deferred(), release = deferred();
  const { log } = await fixture.open({ wrap: journal => intercept(journal, {
    async before(events) {
      if (events.some(event => event.data.type === "model.completed")) { reached.resolve(); await release.promise; }
    },
  }) });
  const run = await start(log);
  await run.record([{ callId: "model-1", data: { type: "model.requested", request: { messages: [] } } }]);
  const seq = log.state().throughSeq;
  let deltas = 0, notifications = 0;
  run.subscribeDeltas(() => { deltas++; });
  run.subscribeCommitted(notification => { assert.equal(notification.kind, "committed"); assert(notification.terminal); notifications++; });
  for (let i = 0; i < 100; i++) run.publishDelta({ callId: "model-1", channel: "model", text: "token" });
  assert.equal(deltas, 100);
  assert.equal(log.state().throughSeq, seq);
  const completing = run.record([{ callId: "model-1", data: { type: "model.completed", response: { text: "final" }, text: "final" } }]);
  await reached.promise;
  assert.equal(notifications, 0);
  assert.equal(log.state().throughSeq, seq);
  release.resolve();
  const receipt = await completing;
  assert.equal(receipt.durability, "fsync");
  assert.equal(notifications, 1);
  assert.equal(log.state().throughSeq, seq + 1);
  await log.close();
  const reopened = await fixture.open();
  assert.equal(reopened.log.events().length, seq + 1);
  assert.equal(reopened.log.events().filter(event => event.data.type === "model.completed").length, 1);
  assert(!JSON.stringify(reopened.log.events()).includes("token"));
});

test("flush and fsync watermarks are explicit and close does not silently upgrade a flush receipt", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open({ durability: "flush" });
  const run = await start(log);
  const receipt = await run.record([{ data: { type: "user.input", content: "hello" } }]);
  assert.equal(receipt.durability, "flush");
  assert.deepEqual(await log.flush("flush"), { flushedThrough: receipt.toSeq, syncedThrough: 0 });
  assert.deepEqual(await log.flush("fsync"), { flushedThrough: receipt.toSeq, syncedThrough: receipt.toSeq });
  const next = await run.record([{ data: { type: "user.input", content: "more" } }]);
  assert.equal((await log.flush("flush")).syncedThrough, receipt.toSeq);
  await log.close();
  const reopened = await fixture.open();
  assert.deepEqual(await reopened.log.flush("flush"), { flushedThrough: next.toSeq, syncedThrough: next.toSeq });
});

test("concurrent commits serialize event sequences and preserve transaction boundaries", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  const receipts = await Promise.all(Array.from({ length: 15 }, (_, index) => run.record([
    { data: { type: "user.input", content: `input-${index}` } },
    { data: { type: "task.status", taskId: `task-${index}`, status: "pending", detail: "recorded" } },
  ])));
  assert.equal(new Set(receipts.map(receipt => receipt.fromSeq)).size, 15);
  assert(log.events().every((event, index) => event.seq === index + 1));
  const lines = (await readFile(fixture.path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 17);
  assert.equal(JSON.parse(lines.at(-1)!).events.length, 2);
});

test("failed validation rolls back the entire proposed batch", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  const before = log.events();
  await assert.rejects(run.record([
    { data: { type: "user.input", content: "must not commit" } },
    { callId: "missing", data: { type: "tool.started" } },
  ]), code("CALL_STATE"));
  assert.deepEqual(log.events(), before);
  await log.close();
  assert.deepEqual((await fixture.open()).log.events(), before);
});

test("an uncertain commit does not publish; reopening discovers a fully written transaction without reexecution", async t => {
  const fixture = await journalFixture(t);
  let failReceipt = false, notifications = 0;
  const { log } = await fixture.open({ wrap: journal => intercept(journal, {
    async after() { if (failReceipt) throw new Error("simulated lost fsync acknowledgement"); },
  }) });
  const run = await start(log);
  const seq = log.state().throughSeq;
  log.subscribeCommitted(() => { notifications++; });
  failReceipt = true;
  await assert.rejects(run.record([{ data: { type: "user.input", content: "written but not acknowledged" } }]), /acknowledgement/);
  assert.equal(notifications, 0);
  assert.equal(log.state().throughSeq, seq);
  assert.throws(() => run.record([{ data: { type: "user.input", content: "cannot continue" } }]), code("COMMIT_UNCERTAIN"));
  await log.close();
  const recovered = await fixture.open();
  assert.equal(recovered.log.state().throughSeq, seq + 1);
});

test("incomplete trailing frame is discarded, complete corrupted frames are rejected", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  await start(log);
  const before = log.events();
  await log.close();
  const tail = '{"format":1,"events":["unfinished 中文';
  await appendFile(fixture.path, tail);
  const recovered = await fixture.open();
  assert.equal(recovered.journal.discardedTailBytes, Buffer.byteLength(tail));
  assert.deepEqual(recovered.log.events(), before);
  await recovered.log.close();
  const bytes = await readFile(fixture.path, "utf8");
  await appendFile(fixture.path, '{"broken":true}\n');
  await assert.rejects(FileJournal.open(fixture.path, "session"), code("INVALID_LOG"));
  assert.equal(await readFile(fixture.path, "utf8"), `${bytes}{"broken":true}\n`);
});

test("replay rejects corrupted checksum and forged provenance even if frame checksum is recomputed", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  await start(log);
  await log.close();
  const original = await readFile(fixture.path, "utf8");
  const lines = original.trim().split("\n");
  const frame = JSON.parse(lines.at(-1)!);
  frame.events[0].configHash = "0".repeat(64);
  lines[lines.length - 1] = JSON.stringify(frame);
  await writeFile(fixture.path, `${lines.join("\n")}\n`);
  await assert.rejects(FileJournal.open(fixture.path, "session"), code("INVALID_LOG"));
  const { checksum: _checksum, ...body } = frame;
  frame.checksum = contentHash(body);
  lines[lines.length - 1] = JSON.stringify(frame);
  await writeFile(fixture.path, `${lines.join("\n")}\n`);
  await assert.rejects(FileJournal.open(fixture.path, "session"), code("INVALID_LOG"));
});

test("writer lock prevents concurrent opens and close releases it", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  await assert.rejects(FileJournal.open(fixture.path, "session"), code("JOURNAL_LOCKED"));
  await log.close();
  await fixture.open();
});

test("observer failure cannot turn a successful commit into a retryable failure", async t => {
  const fixture = await journalFixture(t);
  const { log } = await fixture.open();
  const run = await start(log);
  let delivered = 0;
  log.subscribeCommitted(() => { throw new Error("broken UI"); });
  log.subscribeCommitted(() => { delivered++; });
  const receipt = await run.record([{ data: { type: "user.input", content: "committed" } }]);
  assert.equal(log.state().throughSeq, receipt.toSeq);
  assert.equal(delivered, 1);
  assert.equal(log.drainObserverErrors().length, 1);
});
