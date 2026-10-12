import test from "node:test";
import assert from "node:assert/strict";
import { access, link, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateTrials, EvaluationRunner, gradeTask, readSuite, validateSuite, type EvaluationSuite, type TrialExecutionResult, type TrialRecord } from "../src/evaluation/index.js";
import { contentHash } from "../src/json.js";

const suite: EvaluationSuite = { schemaVersion: 1, id: "smoke", version: "1", split: "regression", tasks: [
  { id: "edit", prompt: "Replace old with new", files: { "src/value.txt": "old" }, graders: [
    { id: "content", kind: "file-equals", path: "src/value.txt", expected: "new" },
    { id: "explanation", kind: "text-includes", expected: "changed", required: false },
  ] },
] };
async function temporary(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "minicah-evaluation-test-")));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("evaluation validates strict suites, grader contracts, safe paths and directory conflicts", () => {
  assert.equal(validateSuite(suite).tasks[0]!.id, "edit");
  assert.throws(() => validateSuite({ ...suite, executable: "echo injected" }), /Invalid evaluation/);
  for (const path of ["../secret", "/tmp/secret", "C:/secret", "x\\y", ".env", "src/.git/config", "a//b", "a/./b", "a/../b", "a\0b"]) {
    assert.throws(() => validateSuite({ ...suite, tasks: [{ ...suite.tasks[0], files: { [path]: "content" } }] }));
  }
  assert.throws(() => validateSuite({ ...suite, tasks: [{ ...suite.tasks[0], files: { a: "x", "a-b": "y", "a/b": "z" } }] }), /directory/);
  assert.throws(() => validateSuite({ ...suite, tasks: [suite.tasks[0], suite.tasks[0]] }), /Duplicate/);
  assert.throws(() => validateSuite({ ...suite, tasks: [{ ...suite.tasks[0], graders: [{ id: "optional", kind: "text-equals", expected: "x", required: false }] }] }), /required/);
  assert.throws(() => validateSuite({ ...suite, tasks: [{ ...suite.tasks[0], graders: [{ id: "bad", kind: "file-equals", expected: "x" }] }] }), /path/);
});

test("readSuite rejects symbolic links, hard links and malformed input", async () => temporary(async directory => {
  const path = join(directory, "suite.json");
  await writeFile(path, JSON.stringify(suite));
  assert.equal((await readSuite(path)).id, suite.id);
  await symlink(path, join(directory, "alias.json"));
  await assert.rejects(readSuite(join(directory, "alias.json")));
  await link(path, join(directory, "hard.json"));
  await assert.rejects(readSuite(path), /single link/);
  await writeFile(join(directory, "bad.json"), "{");
  await assert.rejects(readSuite(join(directory, "bad.json")), /valid JSON/);
}));

test("fresh trials keep private grader expectations out of the executor and persist bounded metadata", async () => temporary(async outputDirectory => {
  const runner = new EvaluationRunner(), seen = new Set<string>();
  const report = await runner.run(suite, async request => {
    assert.equal("graders" in request.task, false);
    assert.equal(JSON.stringify(request.task).includes("explanation"), false);
    assert.equal(await readFile(join(request.workspace, "src/value.txt"), "utf8"), "old");
    assert.equal((await lstat(request.workspace)).mode & 0o777, 0o700);
    assert.equal(seen.has(request.workspace), false); seen.add(request.workspace);
    await writeFile(join(request.workspace, "src/value.txt"), "new");
    await writeFile(join(request.logDirectory, "session.jsonl"), "{}\n", { mode: 0o600 });
    return { status: "completed", cleanup: "verified", finalText: "done", runId: "run-1", metrics: { tokens: null }, journalRefs: ["session.jsonl", "../outside"] };
  }, { outputDirectory, repetitions: 3, concurrency: 2, reference: { executor: "fixture@1" } });
  assert.equal(report.status, "completed");
  assert.equal(report.aggregate.macroPassAt1, 1);
  assert.equal(report.trials[0]!.score, 0.5);
  assert.equal(report.trials[0]!.passed, true, "optional grader contributes partial score, not pass requirement");
  assert.equal(report.trials[0]!.journalRefs.length, 1);
  assert.equal((await lstat(report.artifactDirectory)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(report.artifactDirectory, "report.json"))).mode & 0o777, 0o600);
  const retainedSuite = JSON.parse(await readFile(join(report.artifactDirectory, "suite.json"), "utf8"));
  assert.deepEqual(retainedSuite, suite, "Full grading definitions survive independently of the original dataset file");
  assert.equal(contentHash(retainedSuite), report.suite.hash);
  assert.equal((await lstat(join(report.artifactDirectory, "suite.json"))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(report.artifactDirectory, "report.json"), "utf8")).trials.length, 3);
  for (const workspace of seen) await assert.rejects(access(workspace));
  await runner.close();
}));

test("a required failure remains scored when another grader errors; optional failures cannot establish task failure", async () => temporary(async outputDirectory => {
  const runner = new EvaluationRunner();
  try {
    for (const [required, answer, expected] of [[true, "wrong", false], [true, "right", null], [false, "wrong", null]] as const) {
      const selected: EvaluationSuite = { schemaVersion: 1, id: "mixed-oracles", version: "1", split: "regression", tasks: [{ id: "mixed", prompt: "Answer right.", graders: [
        { id: "answer", kind: "text-equals", expected: "right", required },
        { id: "unavailable", kind: "tool-call-count", tools: ["write_file"], phase: "attempted", min: 0, max: 0 },
      ] }] };
      const report = await runner.run(selected, async () => ({ status: "completed", cleanup: "verified", finalText: answer }), { outputDirectory });
      const trial = report.trials[0]!;
      assert.equal(trial.passed, expected);
      assert.equal(trial.classification, expected === false ? "task-failure" : "grader-failure");
      assert.equal(trial.score, null);
      assert.equal(trial.graders.find(g => g.id === "unavailable")!.status, "error");
      assert.equal(report.aggregate.eligibleTrials, expected === false ? 1 : 0);
      assert.equal(report.aggregate.excludedTrials, expected === false ? 0 : 1);
    }
  } finally { await runner.close(); }
}));

test("artifact budget reserves the retained suite before starting an executor", async () => temporary(async outputDirectory => {
  const suiteBytes = Buffer.byteLength(JSON.stringify(suite, null, 2) + "\n");
  let calls = 0;
  await assert.rejects(new EvaluationRunner().run(suite, async () => {
    calls++; return { status: "completed", cleanup: "verified" };
  }, { outputDirectory, maxArtifactBytes: 131072 + 32768 + suiteBytes - 1 }), /too small/);
  assert.equal(calls, 0);
}));

test("agent completion alone does not pass the task, concurrency is bounded and missing usage remains null", async () => temporary(async outputDirectory => {
  const runner = new EvaluationRunner();
  let active = 0, maximum = 0;
  let release!: () => void;
  const firstPair = new Promise<void>(resolve => { release = resolve; });
  const report = await runner.run(suite, async () => {
    active++; maximum = Math.max(maximum, active);
    if (active === 2) release();
    await firstPair; active--;
    return { status: "completed", cleanup: "verified", finalText: "changed" };
  }, { outputDirectory, repetitions: 5, concurrency: 2 });
  assert.equal(maximum, 2);
  assert.equal(report.aggregate.macroPassAt1, 0);
  assert.equal(report.aggregate.classifications["task-failure"], 5);
  assert.equal(report.trials[0]!.metrics, null);
}));

test("grading rejects links and compares JSON structurally; missing files fail without grader errors", async () => temporary(async directory => {
  await writeFile(join(directory, "object.json"), '{"b":2,"a":1}');
  await writeFile(join(directory, "value"), "secret");
  await symlink(join(directory, "value"), join(directory, "symbolic"));
  await link(join(directory, "value"), join(directory, "hard"));
  const task = { id: "grades", prompt: "x", graders: [
    { id: "json", kind: "file-json-equals" as const, path: "object.json", expected: { a: 1, b: 2 } },
    { id: "symbolic", kind: "file-equals" as const, path: "symbolic", expected: "secret" },
    { id: "hard", kind: "file-equals" as const, path: "hard", expected: "secret" },
    { id: "missing", kind: "file-equals" as const, path: "missing", expected: "secret" },
  ] };
  const result = await gradeTask(task, directory, "");
  assert.deepEqual(result.map(item => item.status), ["passed", "error", "error", "failed"]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
}));

test("timeout waits for cancellation cleanup before deleting workspace, and counts a confirmed timeout as failure", async () => temporary(async outputDirectory => {
  let workspace = "", cleaned = false;
  const report = await new EvaluationRunner().run(suite, async request => {
    workspace = request.workspace;
    await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
    await new Promise(resolve => setTimeout(resolve, 15));
    await access(workspace); cleaned = true;
    return { status: "cancelled", cleanup: "verified" };
  }, { outputDirectory, timeoutMs: 10, cancellationGraceMs: 200 });
  assert.equal(cleaned, true);
  assert.equal(report.trials[0]!.errorCode, "TRIAL_TIMEOUT");
  assert.equal(report.trials[0]!.passed, false);
  assert.equal(report.trials[0]!.classification, "agent-failure");
  await assert.rejects(access(workspace));
}));

test("unconfirmed termination retains workspace, halts queue and poisons future evaluation", async () => temporary(async outputDirectory => {
  const runner = new EvaluationRunner();
  let finish!: (value: TrialExecutionResult) => void, calls = 0;
  const report = await runner.run(suite, async () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  }, { outputDirectory, repetitions: 3, timeoutMs: 10, cancellationGraceMs: 10 });
  assert.equal(calls, 1);
  assert.equal(report.status, "cleanup-unconfirmed");
  assert.deepEqual(report.trials.map(trial => trial.status), ["unknown", "not-started", "not-started"]);
  assert.equal(report.aggregate.macroPassAt1, null);
  assert.equal(report.aggregate.cases[0]!.passAtK["1"], null);
  const retained = report.trials[0]!.retainedWorkspace!;
  await access(retained);
  assert.equal(runner.health().unresolvedTrials.length, 1);
  await assert.rejects(runner.run(suite, async () => ({ status: "completed", cleanup: "verified" }), { outputDirectory }), /unresolved/);
  await assert.rejects(runner.close(), /cleanup/);
  finish({ status: "cancelled", cleanup: "verified" });
  await rm(retained, { recursive: true, force: true });
}));

test("executor rejection preserves uncertainty without persisting raw errors", async () => temporary(async outputDirectory => {
  const runner = new EvaluationRunner();
  const report = await runner.run(suite, async () => { throw new Error("API_KEY=private-value"); }, { outputDirectory });
  assert.equal(report.trials[0]!.status, "unknown");
  assert.equal(report.trials[0]!.errorCode, "EXECUTOR_REJECTED");
  assert.equal(JSON.stringify(report).includes("private-value"), false);
  await rm(report.trials[0]!.retainedWorkspace!, { recursive: true, force: true });
}));

test("settled uncertain effects halt repetitions and retain evidence without pretending processes are still active", async () => temporary(async outputDirectory => {
  const runner = new EvaluationRunner();
  let calls = 0;
  const report = await runner.run(suite, async () => {
    calls++;
    return { status: "unknown", cleanup: "verified", errorCode: "OUTCOME_UNKNOWN" };
  }, { outputDirectory, repetitions: 3 });
  assert.equal(calls, 1);
  assert.equal(report.status, "needs-reconciliation");
  assert.equal(report.trials[1]!.status, "not-started");
  assert.deepEqual(runner.health().unresolvedTrials, []);
  await access(report.trials[0]!.retainedWorkspace!);
  await rm(report.trials[0]!.retainedWorkspace!, { recursive: true, force: true });
  await runner.close();
}));

test("confirmed infrastructure failure is excluded while a confirmed agent failure counts as failed", async () => temporary(async outputDirectory => {
  let n = 0;
  const report = await new EvaluationRunner().run(suite, async () => ({ status: "failed", cleanup: "verified", failureKind: n++ ? "agent" : "infrastructure" }), { outputDirectory, repetitions: 2 });
  assert.deepEqual(report.trials.map(trial => trial.passed), [null, false]);
  assert.equal(report.aggregate.eligibleTrials, 1);
  assert.equal(report.aggregate.classifications["infrastructure-failure"], 1);
}));

test("external cancellation records undispatched trials and joins active cleanup", async () => temporary(async outputDirectory => {
  const controller = new AbortController();
  const report = await new EvaluationRunner().run(suite, async request => {
    controller.abort();
    assert.equal(request.signal.aborted, true);
    return { status: "completed", cleanup: "verified" };
  }, { outputDirectory, repetitions: 3, signal: controller.signal });
  assert.equal(report.status, "cancelled");
  assert.equal(report.trials[0]!.status, "cancelled");
  assert.equal(report.trials[1]!.status, "not-started");
}));

test("external cancellation remains cancellation if cleanup extends beyond the trial deadline", async () => temporary(async outputDirectory => {
  const controller = new AbortController();
  const report = await new EvaluationRunner().run(suite, async () => {
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 30));
    return { status: "cancelled", cleanup: "verified" };
  }, { outputDirectory, signal: controller.signal, timeoutMs: 10, cancellationGraceMs: 100 });
  assert.equal(report.trials[0]!.status, "cancelled");
  assert.equal(report.trials[0]!.passed, null);
}));

test("cancellation preserves uncertain outcomes and invalid/rejected executor results during cleanup", async t => {
  for (const outcome of ["unknown", "invalid", "rejected"] as const) {
    await t.test(outcome, async () => temporary(async outputDirectory => {
      const runner = new EvaluationRunner();
      let calls = 0;
      const report = await runner.run(suite, async (request): Promise<TrialExecutionResult> => {
        calls++;
        await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        await new Promise(resolve => setImmediate(resolve));
        if (outcome === "rejected") throw new Error("Sensitive exception must not replace stable error code");
        if (outcome === "invalid") return { status: "invalid", cleanup: "verified" } as unknown as TrialExecutionResult;
        return { status: "unknown", cleanup: "verified", errorCode: "REMOTE_WRITE_UNKNOWN" };
      }, { outputDirectory, repetitions: 2, timeoutMs: 5, cancellationGraceMs: 100 });
      assert.equal(calls, 1);
      assert.equal(report.trials[0]!.status, "unknown");
      assert.equal(report.trials[0]!.passed, null);
      assert.equal(report.trials[1]!.status, "not-started");
      assert.equal(report.trials[0]!.errorCode, outcome === "unknown" ? "REMOTE_WRITE_UNKNOWN" : outcome === "invalid" ? "INVALID_EXECUTOR_RESULT" : "EXECUTOR_REJECTED");
      assert.equal(report.trials[0]!.cleanup, outcome === "unknown" ? "verified" : "unconfirmed");
      assert.equal(report.status, outcome === "unknown" ? "needs-reconciliation" : "cleanup-unconfirmed");
      await rm(report.trials[0]!.retainedWorkspace!, { recursive: true, force: true });
    }));
  }
});

test("aggregation distinguishes empirical observations from combinatorial pass estimates", () => {
  const base = { taskId: "case", classification: "task-failure" } as TrialRecord;
  const stats = aggregateTrials([true, true, false, false].map(passed => ({ ...base, passed })), [1, 2, 4, 5]);
  const item = stats.cases[0]!;
  assert.equal(item.passAt1, 0.5);
  assert.ok(Math.abs(item.passAtK["2"]! - 5 / 6) < 1e-12);
  assert.ok(Math.abs(item.passPowerK["2"]! - 1 / 6) < 1e-12);
  assert.equal(item.passAtK["5"], null);
  assert.equal(item.empiricalAtLeastOne, true);
  assert.equal(item.empiricalAllTrials, false);
  const incomplete = aggregateTrials([{ ...base, passed: true }, { ...base, passed: null }]);
  assert.equal(incomplete.cases[0]!.passAtK["1"], null);
  assert.equal(incomplete.excludedTrials, 1);
});
