import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime, createEvaluationPlugin, evaluationService, createSandboxTestPackPlugin, createSandboxTestPlugin, readSuite, readSandboxTestPack, type TrialExecutor } from "../src/index.js";

const suitePath = fileURLToPath(new URL("../../examples/evaluation-functions.json", import.meta.url));
const packPath = fileURLToPath(new URL("../../examples/evaluation-functions.tests.json", import.meta.url));
const references: Record<string, string> = {
  "repair-clamp": 'exports.clamp = (value, lower, upper) => { if (lower > upper) throw new RangeError("range"); return Math.max(lower, Math.min(upper, value)); };\n',
  "repair-median": 'exports.median = values => { if (!values.length) throw new RangeError("empty"); const s = [...values].sort((a,b) => a-b); const m = Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };\n',
};

test("function evaluation examples reference valid test packs and cover ordinary and exceptional cases", async () => {
  const [suite, pack] = await Promise.all([readSuite(suitePath), readSandboxTestPack(packPath)]);
  const ids = new Set(pack.tests.map(item => `${pack.id}/${item.id}`));
  for (const task of suite.tasks) {
    assert.ok(Object.hasOwn(references, task.id));
    for (const grader of task.graders) { assert.equal(grader.kind, "sandbox-test"); if (grader.kind === "sandbox-test") assert.ok(ids.has(grader.testId)); }
  }
  assert.ok(pack.tests.every(group => group.cases.some(item => Object.hasOwn(item, "expected")) && group.cases.some(item => item.throws)));
});

test("evaluation CLI rejects missing grader policy and unknown test IDs before requesting a model key", async t => {
  const root = await mkdtemp(join(tmpdir(), "minicah-test-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("../src/evaluation/cli.js", import.meta.url));
  const args = [cli, "--suite", suitePath, "--provider", "deepseek"];
  for (const extra of [[], ["--grader-sandbox", "native", "--test-pack", packPath]]) {
    const changed = extra.length ? { ...await readSuite(suitePath), tasks: [{ id: "missing", prompt: "never dispatch", graders: [{ id: "test", kind: "sandbox-test", testId: "absent/test" }] }] } : undefined;
    if (changed) await writeFile(join(root, "suite.json"), JSON.stringify(changed));
    const command = changed ? [cli, "--suite", join(root, "suite.json"), "--provider", "deepseek", ...extra] : args;
    await assert.rejects(promisify(execFile)(process.execPath, command, { cwd: root, env: { PATH: process.env.PATH }, timeout: 10000 }), error => {
      assert.match((error as { stderr: string }).stderr, changed ? /EVAL_TEST_MISSING/ : /EVAL_ARGUMENT/);
      return true;
    });
  }
});

test("real macOS grading rejects buggy fixtures and accepts independent reference repairs through EvaluationService", {
  skip: process.platform !== "darwin" || process.env.MINICAH_NATIVE_TEST !== "1", timeout: 90000,
}, async t => {
  const output = await mkdtemp(join(tmpdir(), "minicah-function-calibration-"));
  const [suite, pack] = await Promise.all([readSuite(suitePath), readSandboxTestPack(packPath)]);
  const runtime = await Runtime.create({ plugins: [createEvaluationPlugin({ sandboxTests: true }), createSandboxTestPackPlugin(pack), createSandboxTestPlugin({ backend: "native" })] });
  t.after(async () => { await runtime.close(); await rm(output, { recursive: true, force: true }); });
  const session = await runtime.openSession();
  const unchanged: TrialExecutor = async request => {
    assert.equal(Object.hasOwn(request.task, "graders"), false);
    assert.equal(Object.values(request.task.files).some(text => text.includes('"expected"')), false);
    return { status: "completed", cleanup: "verified", finalText: "claimed fixed" };
  };
  const original = await session.run(run => run.services.get(evaluationService).run(suite, unchanged, { outputDirectory: output }));
  assert.equal(original.aggregate.macroPassAt1, 0);
  assert.equal(original.aggregate.classifications["task-failure"], 2);
  const repaired: TrialExecutor = async request => {
    await writeFile(join(request.workspace, request.task.id === "repair-clamp" ? "src/clamp.cjs" : "src/median.cjs"), references[request.task.id]!);
    return { status: "completed", cleanup: "verified" };
  };
  const fixed = await session.run(run => run.services.get(evaluationService).run(suite, repaired, { outputDirectory: output }));
  assert.equal(fixed.aggregate.macroPassAt1, 1);
  assert.ok(fixed.testManifest);
  const manifest = await readFile(join(fixed.artifactDirectory, fixed.testManifest.path), "utf8");
  assert.match(manifest, /function-repair/);
  for (const trial of fixed.trials) {
    assert.equal(trial.cleanup, "verified");
    assert.equal(trial.graders[0]?.test?.cases.length, 6);
    assert.ok(trial.graders[0]?.test?.cases.every(item => item.status === "passed" && item.cleanup === "verified"));
  }
});
