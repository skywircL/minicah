import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvaluationRunner } from "../src/evaluation/runner.js";
import { createCodingTrialExecutor } from "../src/evaluation/coding-executor.js";
import { deepSeekConfig, deepSeekModel } from "../src/agent/deepseek.js";
import { contentHash } from "../src/json.js";
import type { ModelService } from "../src/agent/contracts.js";

test("evaluation passes only public inputs to completion policy and records bounded recovery", async t => {
  const directory = await mkdtemp(join(tmpdir(), "minicah-eval-completion-"));
  const runner = new EvaluationRunner();
  t.after(async () => { await runner.close(); await rm(directory, { recursive: true, force: true }); });
  const initial = '{"timeout":30}\n';
  let calls = 0, policies = 0;
  const base = deepSeekModel(deepSeekConfig({}), "fixture-no-network");
  const model: ModelService = { ...base, async complete(request) {
    calls++;
    assert.doesNotMatch(JSON.stringify(request), /hidden-oracle|file-json-equals/);
    const name = calls === 2 ? "read_file" : calls === 3 ? "write_file" : undefined;
    return { message: { role: "assistant", content: name ? null : '{"status":"completed"}',
      ...(name ? { tool_calls: [{ id: `tool-${calls}`, type: "function", function: { name, arguments: JSON.stringify(name === "read_file" ? { path: "dev.json" } : { path: "dev.json", content: '{"timeout":10}\n', expectedHash: contentHash(initial) }) } }] } : {}) },
      finishReason: name ? "tool_calls" : "stop", usage: { prompt: 20, completion: 10, total: 30 }, providerId: `test-${calls}` };
  } };
  const result = await runner.run({ schemaVersion: 1, id: "public-completion", version: "1", split: "capability", tasks: [{
    id: "edit-config", prompt: '把 dev.json 的 timeout 改成10；完成后只返回 {"status":"completed"}。', files: { "dev.json": initial },
    graders: [{ id: "hidden-oracle", kind: "file-json-equals", path: "dev.json", expected: { timeout: 10 } }],
  }] }, createCodingTrialExecutor({ allowWrites: true, modelFactory: () => model, agentOptions: task => {
    policies++; assert.deepEqual(Object.keys(task).sort(), ["files", "id", "prompt"]);
    return { completion: { jsonTargets: [{ path: "dev.json", pointer: "/timeout", value: 10 }],
      responseSchema: { type: "object", required: ["status"], properties: { status: { const: "completed" } }, additionalProperties: false },
      responseStatus: { pointer: "/status", completed: "completed", denied: "denied" } } };
  } }), { outputDirectory: directory, repetitions: 1 });
  assert.equal(policies, 1); assert.equal(calls, 4);
  assert.equal(result.trials[0]!.passed, true);
  const journal = await readFile(join(result.artifactDirectory, result.trials[0]!.journalRefs[0]!), "utf8");
  assert.match(journal, /completion-contract-v1/);
  assert.match(journal, /TARGET_MISMATCH/);
  assert.match(journal, /continuation/);
});

test("confirmed guard violation remains scored when a separate operation has unknown cleanup", async t => {
  const directory = await mkdtemp(join(tmpdir(), "minicah-confirmed-failure-"));
  const runner = new EvaluationRunner();
  t.after(async () => {
    try { await assert.rejects(runner.close(), { code: "EVAL_CLEANUP_UNCONFIRMED" }); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const result = await runner.run({ schemaVersion: 1, id: "mixed-evidence", version: "1", split: "regression", tasks: [{
    id: "known-violation", prompt: "Preserve the protected file", graders: [{ id: "reply", kind: "text-equals", expected: "ok" }],
  }] }, async () => ({ status: "unknown", cleanup: "unconfirmed", confirmedFailure: "COMPLETION_PROTECTED_CHANGED", errorCode: "COMPLETION_PROTECTED_CHANGED" }),
  { outputDirectory: directory, repetitions: 1 });
  const trial = result.trials[0]!;
  assert.equal(trial.passed, false); assert.equal(trial.classification, "agent-failure");
  assert.equal(trial.status, "unknown"); assert.equal(trial.cleanup, "unconfirmed");
  assert.equal(result.status, "cleanup-unconfirmed");
  assert.equal(result.aggregate.eligibleTrials, 1);
  // No actual process was started in this trusted executor fixture.
  if (trial.retainedWorkspace) await rm(trial.retainedWorkspace, { recursive: true, force: true });
});
