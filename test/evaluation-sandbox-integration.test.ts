import assert from "node:assert/strict";
import test from "node:test";
import { access, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvaluationRunner } from "../src/evaluation/runner.js";
import { validateSuite } from "../src/evaluation/dataset.js";
import { gradeTask } from "../src/evaluation/graders.js";
import type { EvaluationSuite } from "../src/evaluation/types.js";
import type { SandboxTestGrade, SandboxTestService } from "../src/evaluation/sandbox-test-types.js";
import { contentHash } from "../src/json.js";

const suite: EvaluationSuite = { schemaVersion: 1, id: "sandbox-integration", version: "1", split: "regression", tasks: [
  { id: "add", prompt: "Implement addition", files: { "sum.mjs": "export const sum=(a,b)=>a+b;" },
    graders: [{ id: "behavior", kind: "sandbox-test", testId: "private-addition" }] },
] };
const manifest = { schemaVersion: 1, tests: [{ id: "private-addition", module: "sum.mjs", export: "sum", cases: [{ id: "hidden-case", args: [4, 9], expected: 13 }] }], policy: { network: "none" } };
function grade(status: SandboxTestGrade["status"] = "passed", extra: Partial<SandboxTestGrade> = {}): SandboxTestGrade {
  return { status, score: status === "error" ? null : status === "passed" ? 1 : 0, errorCode: status === "error" ? "SANDBOX_UNAVAILABLE" : null,
    cleanup: "verified", cancelled: false, evidence: { testId: "private-addition", definitionHash: contentHash(manifest.tests[0]),
      runnerVersion: "test@1", backend: { kind: "mock" }, durationMs: 1, cases: [{ id: "hidden-case", status, code: null,
        durationMs: 1, executionId: "execution-1", exitCode: 0, reason: null, cleanup: "verified" }], retainedPaths: [] }, ...extra };
}
function service(implementation: SandboxTestService["grade"] = async () => grade()): SandboxTestService {
  return { manifest(ids) { assert.deepEqual(ids, ["private-addition"]); return manifest; }, grade: implementation };
}
async function temporary(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "minicah-sandbox-integration-")));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("sandbox-test suite schema accepts references only and rejects source, commands, expectations and missing references", () => {
  assert.equal(validateSuite(suite).tasks[0]!.graders[0]!.kind, "sandbox-test");
  for (const fields of [{ command: "node test.js" }, { source: "process.exit(0)" }, { expected: true }, { path: "sum.mjs" }]) {
    assert.throws(() => validateSuite({ ...suite, tasks: [{ ...suite.tasks[0], graders: [{ ...suite.tasks[0]!.graders[0], ...fields }] }] }), /Invalid evaluation/);
  }
  assert.throws(() => validateSuite({ ...suite, tasks: [{ ...suite.tasks[0], graders: [{ id: "bad", kind: "sandbox-test" }] }] }), /Invalid evaluation/);
});

test("sandbox test services and all references are validated before dispatch", async () => temporary(async outputDirectory => {
  let calls = 0;
  const execute = async () => { calls++; return { status: "completed" as const, cleanup: "verified" as const }; };
  await assert.rejects(new EvaluationRunner().run(suite, execute, { outputDirectory }), /trusted Host/);
  await assert.rejects(new EvaluationRunner().run(suite, execute, { outputDirectory, sandboxTests: {
    manifest() { throw new Error("missing test reference"); }, grade: async () => grade(),
  } }), /missing test reference/);
  assert.equal(calls, 0);
}));

test("sandbox grading retains private immutable manifests and evidence without passing tests to the Agent", async () => temporary(async outputDirectory => {
  let workspace = "", invocations = 0;
  const runner = new EvaluationRunner();
  const report = await runner.run(suite, async request => {
    workspace = request.workspace;
    assert.equal("graders" in request.task, false);
    assert.equal("sandboxTests" in request, false);
    assert.doesNotMatch(JSON.stringify(request.task), /private-addition|hidden-case|expected/);
    return { status: "completed", cleanup: "verified", finalText: "I am done" };
  }, { outputDirectory, sandboxTests: service(async (id, root, signal) => {
    invocations++; assert.equal(id, "private-addition"); assert.equal(root, workspace); assert.equal(signal.aborted, false);
    await access(workspace); return grade();
  }) });
  assert.equal(invocations, 1); assert.equal(report.trials[0]!.passed, true); assert.equal(report.trials[0]!.graders[0]!.test?.cases[0]!.status, "passed");
  assert.deepEqual(report.testManifest, { path: "test-manifest.json", hash: contentHash(manifest) });
  const path = join(report.artifactDirectory, report.testManifest!.path);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), manifest);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(report.artifactDirectory, "plan.json"), "utf8")).testManifest, report.testManifest);
  await assert.rejects(access(workspace));
  await runner.close();
}));

test("artifact preflight budgets the retained test manifest and duplicated bounded test evidence", async () => temporary(async outputDirectory => {
  let calls = 0;
  const limit = 131072 * 2 + 32768 + Buffer.byteLength(JSON.stringify(suite, null, 2) + "\n") + Buffer.byteLength(JSON.stringify(manifest, null, 2) + "\n") - 1;
  await assert.rejects(new EvaluationRunner().run(suite, async () => {
    calls++; return { status: "completed", cleanup: "verified" };
  }, { outputDirectory, sandboxTests: service(), maxArtifactBytes: limit }), /too small/);
  assert.equal(calls, 0);
}));

test("failed assertions are task failures while scoring infrastructure errors are excluded", async () => temporary(async outputDirectory => {
  let calls = 0;
  const report = await new EvaluationRunner().run(suite, async () => ({ status: "completed", cleanup: "verified" }), {
    outputDirectory, repetitions: 3, sandboxTests: service(async () => grade((["failed", "error", "passed"] as const)[calls++]!)),
  });
  assert.deepEqual(report.trials.map(item => item.classification), ["task-failure", "grader-failure", "success"]);
  assert.deepEqual(report.trials.map(item => item.passed), [false, null, true]);
  assert.equal(report.aggregate.eligibleTrials, 2); assert.equal(report.aggregate.excludedTrials, 1);
}));

test("graders never run on failed, cancelled or uncertain Agent execution", async () => temporary(async outputDirectory => {
  let calls = 0;
  for (const status of ["failed", "cancelled", "unknown"] as const) {
    const report = await new EvaluationRunner().run(suite, async () => ({ status, cleanup: "verified" }), {
      outputDirectory, sandboxTests: service(async () => { calls++; return grade(); }),
    });
    assert.deepEqual(report.trials[0]!.graders, []);
    if (report.trials[0]!.retainedWorkspace) await rm(report.trials[0]!.retainedWorkspace, { recursive: true, force: true });
  }
  assert.equal(calls, 0);
}));

test("unknown sandbox cleanup retains workspace, halts dispatch and poisons runner", async () => temporary(async outputDirectory => {
  const runner = new EvaluationRunner();
  let calls = 0;
  const report = await runner.run(suite, async () => { calls++; return { status: "completed", cleanup: "verified" }; }, {
    outputDirectory, repetitions: 3, sandboxTests: service(async () => grade("error", { cleanup: "unconfirmed" })),
  });
  assert.equal(calls, 1); assert.equal(report.status, "cleanup-unconfirmed");
  assert.deepEqual(report.trials.map(item => item.status), ["unknown", "not-started", "not-started"]);
  assert.equal(report.trials[0]!.classification, "infrastructure-failure"); assert.equal(report.trials[0]!.passed, null);
  await access(report.trials[0]!.retainedWorkspace!);
  assert.deepEqual(runner.health().unresolvedTrials, [report.trials[0]!.trialId]);
  await assert.rejects(runner.close(), /cleanup/);
  await rm(report.trials[0]!.retainedWorkspace!, { recursive: true, force: true });
}));

test("hanging grading is cancelled then bounded by grace without deleting live workspaces", async () => temporary(async outputDirectory => {
  let resolveGrade!: (value: SandboxTestGrade) => void, cancelled = false, calls = 0;
  const report = await new EvaluationRunner().run(suite, async () => { calls++; return { status: "completed", cleanup: "verified" }; }, {
    outputDirectory, repetitions: 2, timeoutMs: 50, cancellationGraceMs: 10,
    sandboxTests: service(async (_id, workspace, signal) => {
      signal.addEventListener("abort", () => { cancelled = true; }, { once: true }); await access(workspace);
      return new Promise(resolve => { resolveGrade = resolve; });
    }),
  });
  assert.equal(cancelled, true); assert.equal(calls, 1); assert.equal(report.status, "cleanup-unconfirmed");
  assert.equal(report.trials[0]!.errorCode, "GRADING_CLEANUP_UNCONFIRMED");
  await access(report.trials[0]!.retainedWorkspace!);
  resolveGrade(grade("error", { cancelled: true }));
  await rm(report.trials[0]!.retainedWorkspace!, { recursive: true, force: true });
}));

test("grading timeout consumes the remaining trial deadline and waits for verified cleanup", async () => temporary(async outputDirectory => {
  let elapsedAtAbort = 0, workspace = "", cleaned = false;
  const report = await new EvaluationRunner().run(suite, async request => {
    workspace = request.workspace; await new Promise(resolve => setTimeout(resolve, 80));
    return { status: "completed", cleanup: "verified" };
  }, { outputDirectory, timeoutMs: 200, cancellationGraceMs: 200, sandboxTests: service(async (_id, root, signal) => {
    const start = performance.now();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { elapsedAtAbort = performance.now() - start; resolve(); }, { once: true }));
    await new Promise(resolve => setTimeout(resolve, 10)); await access(root); cleaned = true;
    return grade("error", { cancelled: true });
  }) });
  assert.equal(cleaned, true); assert.ok(elapsedAtAbort < 170, `Grader incorrectly received a fresh deadline: ${elapsedAtAbort}`);
  assert.equal(report.trials[0]!.errorCode, "GRADING_TIMEOUT"); assert.equal(report.trials[0]!.classification, "grader-failure");
  assert.equal(report.trials[0]!.passed, null); assert.equal(report.trials[0]!.cleanup, "verified");
  await assert.rejects(access(workspace));
}));

test("external cancellation during grading stays cancelled even when cleanup crosses the deadline", async () => temporary(async outputDirectory => {
  const controller = new AbortController();
  let cleanupFinished = false;
  const report = await new EvaluationRunner().run(suite, async () => ({ status: "completed", cleanup: "verified" }), {
    outputDirectory, repetitions: 2, signal: controller.signal, timeoutMs: 80, cancellationGraceMs: 250,
    sandboxTests: service(async (_id, workspace, signal) => {
      controller.abort(); assert.equal(signal.aborted, true);
      await new Promise(resolve => setTimeout(resolve, 100)); await access(workspace); cleanupFinished = true;
      return grade("passed");
    }),
  });
  assert.equal(cleanupFinished, true); assert.equal(report.status, "cancelled");
  assert.equal(report.trials[0]!.status, "cancelled"); assert.equal(report.trials[0]!.passed, null);
  assert.equal(report.trials[0]!.errorCode, "GRADING_CANCELLED"); assert.equal(report.trials[1]!.status, "not-started");
}));

test("a sandbox adapter rejection preserves uncertainty and does not leak raw exceptions", async () => temporary(async outputDirectory => {
  const report = await new EvaluationRunner().run(suite, async () => ({ status: "completed", cleanup: "verified" }), {
    outputDirectory, sandboxTests: service(async () => { throw new Error("secret-key=private"); }),
  });
  assert.equal(report.trials[0]!.status, "unknown"); assert.equal(report.trials[0]!.passed, null);
  assert.equal(report.trials[0]!.graders[0]!.errorCode, "SANDBOX_GRADER_REJECTED");
  assert.doesNotMatch(JSON.stringify(report), /secret-key/);
  await rm(report.trials[0]!.retainedWorkspace!, { recursive: true, force: true });
}));

test("direct grading stops subsequent dispatch when sandbox cleanup is unconfirmed", async () => temporary(async workspace => {
  const task = { ...suite.tasks[0]!, graders: [...suite.tasks[0]!.graders, { id: "never", kind: "text-equals" as const, expected: "done" }] };
  const result = await gradeTask(task, workspace, "done", { sandboxTests: service(async () => grade("error", { cleanup: "unconfirmed" })) });
  assert.equal(result.length, 1); assert.equal(result[0]!.cleanup, "unconfirmed");
}));
