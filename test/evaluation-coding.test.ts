import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { access, lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { definition } from "../src/session/json.js";
import { readJournalSnapshot } from "../src/session/file-journal.js";
import { EvaluationRunner, type EvaluationSuite, type TrialRecord } from "../src/evaluation/index.js";
import { createCodingTrialExecutor } from "../src/evaluation/coding-executor.js";
import type { ModelCompletion, ModelService, Message } from "../src/agent/contracts.js";
import type { JsonValue, ToolInfo } from "../src/types.js";
import type { RunMetrics } from "../src/observability/types.js";

const suite: EvaluationSuite = { schemaVersion: 1, id: "coding-adapter-smoke", version: "1", split: "regression", tasks: [
  { id: "uppercase", prompt: "Read input.txt and return its uppercase content. PRIVATE_TASK_REQUEST", files: { "input.txt": "private_fixture_input\n" }, graders: [
    { id: "answer", kind: "text-equals", expected: "PRIVATE_FIXTURE_INPUT" },
  ] },
] };

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "minicah-coding-eval-test-"))), runner = new EvaluationRunner();
  t.after(async () => { await runner.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, runner };
}
function metrics(trial: TrialRecord): RunMetrics {
  assert.ok(trial.metrics);
  const value = trial.metrics as unknown as { schemaVersion: number; timingBasis: string; throughSeq: number; run: RunMetrics };
  assert.equal(value.schemaVersion, 1); assert.equal(value.timingBasis, "committed-event-timestamps"); assert.ok(value.throughSeq > 0);
  assert.equal(value.run.runId, trial.runId);
  return value.run;
}

test("coding evaluation executes the offline native fixture and retains private committed journals plus honest usage metrics", async t => {
  const { directory, runner } = await fixture(t), executor = createCodingTrialExecutor();
  let workspace = "";
  const report = await runner.run(suite, async request => {
    workspace = request.workspace;
    assert.equal("graders" in request.task, false);
    return executor(request);
  }, { outputDirectory: directory });
  assert.equal(report.status, "completed"); assert.equal(report.aggregate.macroPassAt1, 1);
  const trial = report.trials[0]!;
  assert.equal(trial.classification, "success"); assert.equal(trial.passed, true); assert.equal(trial.cleanup, "verified");
  assert.equal(trial.retainedWorkspace, null); assert.equal(trial.journalRefs.length, 1);
  const observed = metrics(trial);
  assert.equal(observed.model.all.requests, 2); assert.equal(observed.model.agent.requests, 2);
  assert.equal(observed.model.all.withUsage, 0); assert.equal(observed.model.all.missingUsage, 2);
  assert.equal(observed.model.all.completedWithoutUsage, 2);
  assert.deepEqual(observed.model.all.observedTokens, { prompt: null, completion: null, total: null });
  assert.equal(observed.model.all.fallbackEstimatedSamples, 2); assert.ok(observed.model.all.fallbackEstimatedTokens! > 0);
  assert.equal(observed.model.all.chargedTokens, observed.model.all.fallbackEstimatedTokens);
  assert.equal(observed.tools.completed, 1); assert.equal(observed.tools.errors, 0);
  const journalPath = join(report.artifactDirectory, trial.journalRefs[0]!);
  assert.equal((await lstat(journalPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(dirname(journalPath))).mode & 0o777, 0o700);
  const journal = await readJournalSnapshot(journalPath);
  assert.equal(journal.sessionId, trial.sessionId); assert.equal(journal.discardedTailBytes, 0);
  assert.equal(journal.events.filter(event => event.data.type === "model.completed").length, 2);
  assert.equal(journal.events.filter(event => event.data.type === "tool.completed").length, 1);
  assert.match(await readFile(journalPath, "utf8"), /PRIVATE_TASK_REQUEST/);
  assert.doesNotMatch(await readFile(join(report.artifactDirectory, "report.json"), "utf8"), /PRIVATE_TASK_REQUEST|PRIVATE_FIXTURE_INPUT|private_fixture_input/);
  await assert.rejects(access(`${journalPath}.lock`), { code: "ENOENT" });
  await assert.rejects(access(workspace), { code: "ENOENT" });
});

class ScriptedModel implements ModelService {
  #steps = 0;
  #id = "injected-class-model";
  #window = 32768;
  prepares = 0;
  advertised: string[][] = [];
  constructor(readonly calls: readonly { name: string; args: JsonValue }[], readonly result: string) {}
  definition() { return definition("model", this.#id, "1.0.0", { trustedFixture: true }); }
  limits() { return { contextWindow: this.#window, maxOutputTokens: 1024 }; }
  prepare(messages: readonly Message[], tools: readonly ToolInfo[], maxOutputTokens = 1024): JsonValue {
    this.prepares++; this.advertised.push(tools.map(tool => tool.name));
    return { messages: messages as unknown as JsonValue, tools: tools.map(tool => ({ name: tool.name })), max_tokens: maxOutputTokens };
  }
  async complete(_request: JsonValue, options?: { signal?: AbortSignal }): Promise<ModelCompletion> {
    options?.signal?.throwIfAborted();
    this.#steps++;
    assert.ok(this.#steps <= 2, "scripted model must terminate after the tool batch");
    return this.#steps === 1
      ? { message: { role: "assistant", content: null, tool_calls: this.calls.map((call, index) => ({ id: `scripted-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finishReason: "tool_calls", usage: { prompt: 7, completion: 3, total: 10 }, providerId: "step-one" }
      : { message: { role: "assistant", content: this.result }, finishReason: "stop", usage: { prompt: 21, completion: 9, total: 30 }, providerId: "step-two" };
  }
  get steps() { return this.#steps; }
}

test("explicit allowWrites permits a scoped write_file that passes a real file grader; injected class methods retain their receiver", async t => {
  const { directory, runner } = await fixture(t);
  const model = new ScriptedModel([{ name: "write_file", args: { path: "answer.txt", content: "PRIVATE_NEW_FILE", expectedHash: null } }], "done");
  const editing: EvaluationSuite = { ...suite, tasks: [{ id: "write", prompt: "Create answer.txt", graders: [{ id: "file", kind: "file-equals", path: "answer.txt", expected: "PRIVATE_NEW_FILE" }] }] };
  const report = await runner.run(editing, createCodingTrialExecutor({ allowWrites: true, modelFactory: () => model }), { outputDirectory: directory });
  const trial = report.trials[0]!, observed = metrics(trial);
  assert.equal(trial.passed, true); assert.equal(trial.classification, "success"); assert.equal(trial.cleanup, "verified");
  assert.equal(trial.graders[0]!.status, "passed"); assert.equal(model.steps, 2); assert.ok(model.prepares > 0);
  assert.ok(model.advertised.some(tools => tools.includes("write_file")));
  assert.ok(model.advertised.every(tools => !tools.includes("run_command")));
  assert.equal(observed.model.all.withUsage, 2); assert.equal(observed.model.all.missingUsage, 0);
  assert.deepEqual(observed.model.all.observedTokens, { prompt: 28, completion: 12, total: 40 });
  assert.equal(observed.model.all.chargedTokens, 40); assert.equal(observed.model.all.fallbackEstimatedTokens, null);
  assert.equal(observed.tools.started, 1); assert.equal(observed.tools.completed, 1); assert.equal(observed.permissions.allow, 1);
  const journal = await readJournalSnapshot(join(report.artifactDirectory, trial.journalRefs[0]!));
  const approval = journal.events.find(event => event.data.type === "permission.decided")!;
  assert.equal(approval.data.type, "permission.decided");
  if (approval.data.type === "permission.decided") assert.ok(approval.data.approval, "write is bound to an explicit scoped approval");
  assert.doesNotMatch(JSON.stringify(trial.metrics), /PRIVATE_NEW_FILE/);
});

test("default read-only coding evaluation rejects model-invented shell and write calls without dispatch", async t => {
  const { directory, runner } = await fixture(t);
  const model = new ScriptedModel([
    { name: "run_command", args: { command: process.execPath, args: ["-e", "throw new Error('must never execute')"], cwd: "." } },
    { name: "write_file", args: { path: "input.txt", content: "tampered", expectedHash: null } },
  ], "denials handled");
  const readonly: EvaluationSuite = { ...suite, tasks: [{ id: "deny", prompt: "Keep the original input unchanged", files: { "input.txt": "original" }, graders: [
    { id: "file", kind: "file-equals", path: "input.txt", expected: "original" },
    { id: "finished", kind: "text-equals", expected: "denials handled" },
  ] }] };
  const report = await runner.run(readonly, createCodingTrialExecutor({ modelFactory: () => model }), { outputDirectory: directory });
  const trial = report.trials[0]!, observed = metrics(trial);
  assert.equal(trial.passed, true); assert.equal(trial.cleanup, "verified"); assert.equal(model.steps, 2);
  assert.ok(model.advertised.every(tools => !tools.includes("run_command") && !tools.includes("write_file")));
  assert.equal(observed.tools.attempts, 2); assert.equal(observed.tools.rejected, 2); assert.equal(observed.tools.started, 0);
  const journal = await readJournalSnapshot(join(report.artifactDirectory, trial.journalRefs[0]!));
  assert.equal(journal.events.filter(event => event.data.type === "tool.started").length, 0);
  assert.equal(journal.events.filter(event => event.data.type === "pipeline.rejected").length, 2);
});

test("PTC evaluation without a sandbox is a confirmed infrastructure failure before model or tool dispatch", async t => {
  const { directory, runner } = await fixture(t);
  let factories = 0;
  const report = await runner.run(suite, createCodingTrialExecutor({ modelFactory: () => { factories++; return new ScriptedModel([], "unused"); } }), { outputDirectory: directory, mode: "ptc" });
  const trial = report.trials[0]!;
  assert.equal(factories, 0); assert.equal(trial.status, "failed"); assert.equal(trial.cleanup, "verified");
  assert.equal(trial.classification, "infrastructure-failure"); assert.equal(trial.errorCode, "EVAL_PTC_POLICY");
  assert.equal(trial.passed, null); assert.equal(trial.metrics, null); assert.deepEqual(trial.journalRefs, []);
  assert.equal(report.aggregate.eligibleTrials, 0); assert.equal(report.aggregate.macroPassAt1, null);
  assert.deepEqual(await readdir(join(report.artifactDirectory, `logs-${trial.trialId}`)), []);
});

test("real macOS sandbox PTC fixture passes the same file task and records parent-child execution evidence", {
  skip: process.platform !== "darwin" || process.env.MINICAH_NATIVE_TEST !== "1",
}, async t => {
  const { directory, runner } = await fixture(t);
  const report = await runner.run(suite, createCodingTrialExecutor({ sandbox: "native" }), { outputDirectory: directory, mode: "ptc", timeoutMs: 30000 });
  const trial = report.trials[0]!, observed = metrics(trial);
  assert.equal(trial.passed, true); assert.equal(trial.cleanup, "verified");
  assert.equal(observed.ptc.attempts, 1); assert.equal(observed.ptc.completed, 1); assert.equal(observed.ptc.cleanupVerified, 1);
  assert.equal(observed.ptc.cleanupUnconfirmed, 0); assert.equal(observed.tools.completed, 2);
  const journal = await readJournalSnapshot(join(report.artifactDirectory, trial.journalRefs[0]!));
  const ptc = journal.events.find(event => event.data.type === "ptc.started")!;
  assert.ok(ptc.parentCallId); assert.ok(journal.events.some(event => event.data.type === "tool.planned" && event.parentCallId === ptc.callId));
});
