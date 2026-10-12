import assert from "node:assert/strict";
import test from "node:test";
import { access, appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { observeCli } from "../src/observability/cli.js";
import type { ObservabilityReport } from "../src/observability/types.js";
import { journalFixture, start, toolRef } from "./session-helpers.js";
import { code } from "./helpers.js";

type ExportedReport = ObservabilityReport & { discardedTailBytes: number };
function capture() {
  const messages: string[] = [];
  return { messages, write(text: string) { messages.push(text); return true; },
    report: () => JSON.parse(messages.join("")) as ExportedReport };
}

test("offline observe reads committed snapshots and filters runs without rerunning tools or publishing payloads", async t => {
  const fixture = await journalFixture(t), { log } = await fixture.open();
  const run = await start(log, "first-run"), effect = join(fixture.directory, "effect.txt");
  let executed = 0;
  await run.record([
    { data: { type: "user.input", content: "PRIVATE_USER_INPUT" } },
    { callId: "tool-call", data: { type: "tool.planned", tool: toolRef, effect: "non-idempotent-write", input: { path: "/PRIVATE_WORKSPACE", token: "PRIVATE_TOKEN" } } },
    { callId: "tool-call", data: { type: "permission.decided", decision: "allow", reason: "PRIVATE_PERMISSION" } },
  ]);
  await run.executeTool("tool-call", async () => {
    executed++; await appendFile(effect, "once\n");
    return { outcome: "success", result: { content: "PRIVATE_TOOL_RESULT" } };
  });
  await run.record([{ data: { type: "run.finished", status: "completed" } }]);
  const second = await start(log, "second-run");
  await second.record([
    { callId: "model-call", data: { type: "model.requested", request: { messages: ["PRIVATE_MODEL_REQUEST"] }, purpose: "agent" } },
    { callId: "model-call", data: { type: "model.completed", response: { format: "coding-agent-v1", completion: { usage: null, message: "PRIVATE_MODEL_RESPONSE" } }, text: "PRIVATE_MODEL_RESPONSE", chargedTokens: 100 } },
    { data: { type: "run.finished", status: "completed" } },
  ]);
  const bytes = await readFile(fixture.path), lock = await readFile(`${fixture.path}.lock`);
  const all = capture();
  await observeCli(["--journal", fixture.path], all.write);
  assert.deepEqual(all.report().runs.map(item => item.runId), ["first-run", "second-run"]);
  assert.deepEqual(all.report().calls, []);
  assert.equal(all.report().throughSeq, log.events().length);
  assert.equal(all.report().discardedTailBytes, 0);
  // A read-only export also works while the Session writer owns the journal.
  assert.deepEqual(await readFile(`${fixture.path}.lock`), lock);
  const filtered = capture();
  await observeCli(["--journal", fixture.path, "--run", "first-run", "--trace"], filtered.write);
  assert.deepEqual(filtered.report().runs.map(item => item.runId), ["first-run"]);
  assert.deepEqual(filtered.report().calls.map(call => call.callId), ["tool-call"]);
  assert.equal(filtered.report().calls[0]!.status, "completed");
  assert.equal(filtered.report().runs[0]!.tools.completed, 1);
  assert.doesNotMatch([...all.messages, ...filtered.messages].join(""), /PRIVATE_/);
  assert.equal(executed, 1); assert.equal(await readFile(effect, "utf8"), "once\n");
  assert.deepEqual(await readFile(fixture.path), bytes);
  await log.close();
  const closed = capture();
  await observeCli(["--journal", fixture.path, "--trace"], closed.write);
  assert.equal(closed.report().calls.length, 2);
  await assert.rejects(access(`${fixture.path}.lock`), { code: "ENOENT" });
  assert.equal(executed, 1); assert.deepEqual(await readFile(fixture.path), bytes);
});

test("offline observe rejects unknown runs before exporting or writing output", async t => {
  const fixture = await journalFixture(t), { log } = await fixture.open();
  await start(log, "recorded-run"); await log.close();
  const output = join(fixture.directory, "must-not-exist.json"), captured = capture();
  await assert.rejects(observeCli(["--journal", fixture.path, "--run", "missing", "--output", output], captured.write), code("OBSERVE_RUN_NOT_FOUND"));
  assert.deepEqual(captured.messages, []);
  await assert.rejects(access(output), { code: "ENOENT" });
  await assert.rejects(observeCli([], captured.write), code("OBSERVE_ARGUMENT"));
});

test("offline metadata export creates a private new file and never replaces an existing destination", async t => {
  const fixture = await journalFixture(t), { log } = await fixture.open();
  const run = await start(log);
  await run.record([{ data: { type: "user.input", content: "PRIVATE_EXPORTED_INPUT" } }, { data: { type: "run.finished", status: "completed" } }]);
  await log.close();
  const output = join(fixture.directory, "metrics.json"), captured = capture();
  await observeCli(["--journal", fixture.path, "--output", output], captured.write);
  const bytes = await readFile(output), report = JSON.parse(bytes.toString("utf8")) as ExportedReport;
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(report.runs[0]!.status, "completed"); assert.equal(report.discardedTailBytes, 0);
  assert.doesNotMatch(bytes.toString("utf8"), /PRIVATE_/);
  assert.equal(captured.messages.length, 1); assert.match(captured.messages[0]!, /Metadata exported/);
  const second = capture();
  await assert.rejects(observeCli(["--journal", fixture.path, "--output", output], second.write), { code: "EEXIST" });
  assert.deepEqual(await readFile(output), bytes); assert.deepEqual(second.messages, []);
  const existing = join(fixture.directory, "user-owned.json");
  await writeFile(existing, "user-owned content\n", { mode: 0o640 });
  const existingMode = (await stat(existing)).mode & 0o777;
  await assert.rejects(observeCli(["--journal", fixture.path, "--output", existing], second.write), { code: "EEXIST" });
  assert.equal(await readFile(existing, "utf8"), "user-owned content\n");
  assert.equal((await stat(existing)).mode & 0o777, existingMode);
});

test("offline observe discloses ignored torn tail bytes and preserves the original journal and lock", async t => {
  const fixture = await journalFixture(t), { log } = await fixture.open();
  const run = await start(log);
  await run.record([{ data: { type: "run.finished", status: "completed" } }]);
  const throughSeq = log.events().length;
  await log.close();
  const tail = '{"format":1,"events":["PRIVATE_TORN_TEXT 中文';
  await appendFile(fixture.path, tail);
  await writeFile(`${fixture.path}.lock`, "another writer owns this lock");
  const before = await readFile(fixture.path), captured = capture();
  await observeCli(["--journal", fixture.path, "--trace"], captured.write);
  assert.equal(captured.report().throughSeq, throughSeq);
  assert.equal(captured.report().discardedTailBytes, Buffer.byteLength(tail));
  assert.equal(captured.report().runs[0]!.status, "completed");
  assert.doesNotMatch(captured.messages.join(""), /PRIVATE_TORN_TEXT/);
  assert.deepEqual(await readFile(fixture.path), before);
  assert.equal(await readFile(`${fixture.path}.lock`, "utf8"), "another writer owns this lock");
});

test("offline observe rejects complete corrupted frames instead of silently treating them as a torn tail", async t => {
  const fixture = await journalFixture(t), { log } = await fixture.open();
  await start(log); await log.close();
  await appendFile(fixture.path, '{"broken":true}\n');
  const before = await readFile(fixture.path), captured = capture();
  await assert.rejects(observeCli(["--journal", fixture.path], captured.write), code("INVALID_LOG"));
  assert.deepEqual(captured.messages, []);
  assert.deepEqual(await readFile(fixture.path), before);
});
