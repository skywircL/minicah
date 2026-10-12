import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, copyFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Runtime, API_VERSION, services, HarnessError, createSessionPlugin, createContextPlugin, createCodingToolsPlugin, createPermissionPlugin, createToolPipelinePlugin, createCompactionPlugin, createAgentLoopPlugin, createObservabilityPlugin, sessionLogPath } from '../../dist/src/index.js';
import { gradeTask, projectToolTrace } from '../../dist/src/evaluation/index.js';
import { deepSeekModel } from '../../dist/src/agent/deepseek.js';
import { loadCliEnvironment } from '../../dist/src/cli/environment.js';
import { checkManifest, fingerprint, root, readJSON, writeJSON, sha } from '../gold-expansion/common.mjs';
import { wilson } from './expansion-statistics.mjs';

const self = fileURLToPath(import.meta.url);
const baseline = resolve(root, '.minicah/gold-expansion-baselines/baseline-FxEhmE');
export const arms = ['original', 'final-after-action', 'remove-completed-history', 'both-wording', 'full-history', 'explicit-actions'];
export const contract = { path: 'dev.json', field: 'timeout', value: 10 };
export const feedback = '完成检查未通过：目标文件仍未满足最新用户请求。请重新读取目标文件，继续按最新请求完成必要操作；只有成功后才返回约定的最终 JSON。其他文件保持不变，不得运行命令。';

export function variant(arm, replay) {
  assert.ok(arms.includes(arm));
  const prefix = structuredClone(arm === 'full-history' ? replay.fullPrefix : replay.compactPrefix);
  let prompt = replay.prompt;
  if (['remove-completed-history', 'both-wording'].includes(arm)) {
    assert.ok(prefix.at(-1).content.includes('前两轮已完成，'));
    prefix.at(-1).content = prefix.at(-1).content.replace('前两轮已完成，', '');
  }
  if (['final-after-action', 'both-wording'].includes(arm)) {
    assert.ok(prompt.includes('只返回 JSON'));
    prompt = prompt.replace('只返回 JSON', '完成上述修改后，最终回复只返回 JSON');
  }
  if (arm === 'explicit-actions') prompt = '再次更新：先重新读取 dev.json，再把其中的 timeout 设为 10；保持其他字段与其他文件不变，prod.json 永远不得修改。使用文件工具完成必要操作，只有修改成功后，最终回复才只返回 JSON {"status":"completed"}；不得执行命令。';
  return { prefix, prompt };
}

export function schedule(repetitions = 8, seed = 2026100301) {
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  return Array.from({ length: repetitions }, (_, i) => {
    const order = [...arms];
    for (let j = order.length - 1; j > 0; j--) { const k = Math.floor(random() * (j + 1)); [order[j], order[k]] = [order[k], order[j]]; }
    return order.map(arm => ({ arm, repetition: i + 1 }));
  }).flat();
}

export function publicStateCheck(initial, actual, target = contract) {
  let expected, observed;
  try { expected = { ...JSON.parse(initial[target.path]), [target.field]: target.value }; observed = JSON.parse(actual[target.path]); }
  catch { return { targetSatisfied: false, preservationSatisfied: false, satisfied: false }; }
  let targetSatisfied = true;
  try { assert.deepEqual(observed, expected); } catch { targetSatisfied = false; }
  const names = Object.keys(initial).sort();
  const preservationSatisfied = JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(names) && names.filter(p => p !== target.path).every(p => actual[p] === initial[p]);
  return { targetSatisfied, preservationSatisfied, satisfied: targetSatisfied && preservationSatisfied };
}

/** Experimental bounded continuation, not a production finish gate or a grader retry. */
export function shouldContinue(phase, state) {
  return phase.status === 'completed' && state.preservationSatisfied && !state.targetSatisfied &&
    !Object.values(phase.trace.approvalDenials.counts).some(n => n > 0);
}

async function snapshot(directory, prefix = '') {
  const files = {};
  for (const entry of await readdir(resolve(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(!entry.isSymbolicLink(), 'Unexpected symlink');
    if (entry.isDirectory()) Object.assign(files, await snapshot(directory, name));
    else files[name] = await readFile(resolve(directory, name), 'utf8');
  }
  return files;
}

export async function frozenCheck() {
  const report = await readJSON(resolve(baseline, 'report.json'));
  const audit = await readJSON(resolve(baseline, 'completion-audit.json'));
  for (const [p, hash] of Object.entries(audit.artifactHashes)) assert.equal(sha(await readFile(resolve(baseline, p))), hash, p);
  assert.equal((await checkManifest()).hash, report.manifestHash);
  assert.equal((await fingerprint()).hash, report.runtimeHash);
  return { reportHash: sha(await readFile(resolve(baseline, 'report.json'))), runtimeHash: report.runtimeHash, manifestHash: report.manifestHash, artifactCount: Object.keys(audit.artifactHashes).length };
}

export async function loadReplay(caseId = 'GM-D19') {
  assert.ok(['GM-D19', 'GM-D04'].includes(caseId));
  const report = await readJSON(resolve(baseline, 'report.json'));
  const source = await readJSON(resolve(baseline, `${caseId}-1/report.json`));
  const events = (await readFile(source.journal, 'utf8')).trim().split('\n').flatMap(line => { const v = JSON.parse(line); return v.events ?? [v]; });
  const first = events.find(e => e.runId === source.turns[2].runId && e.data.type === 'model.requested').data.request;
  const previous = events.filter(e => e.runId === source.turns[1].runId && e.data.type === 'model.requested').at(-1).data.request;
  const end = events.filter(e => e.runId === source.turns[1].runId && e.data.type === 'model.completed').at(-1).data.response.completion;
  assert.equal(end.finishReason, 'stop'); assert.ok(!end.message.tool_calls?.length);
  const seed = await readJSON(resolve(root, `evals/private/gold-mutations-v2/cases/${caseId}.json`));
  assert.equal(first.messages.at(-1).content, seed.execution.tasks[2].prompt);
  return { model: report.model, sourceJournal: source.journal, sourceJournalHash: sha(await readFile(source.journal)), originalRequest: first,
    sourceWorkspace: resolve(baseline, `${caseId}-1/workspace`), compactPrefix: first.messages.slice(0, -1),
    fullPrefix: [...previous.messages, end.message], prompt: first.messages.at(-1).content, task: seed.execution.tasks[2], initialFiles: seed.execution.tasks[2].files };
}

function normalizeRequest(request, workspace) {
  return JSON.parse(JSON.stringify(request).replaceAll(workspace, '<WORKSPACE>'));
}

export async function executeTrial({ replay, arm, repetition, directory, adapter, allowContinuation = false, selectedOverride, publicContract = contract }) {
  let workspace = resolve(directory, 'workspace'); const logs = resolve(directory, 'sessions');
  await mkdir(workspace, { recursive: true, mode: 0o700 }); await mkdir(logs, { recursive: true, mode: 0o700 });
  workspace = await realpath(workspace);
  for (const [p, text] of Object.entries(replay.initialFiles)) { await mkdir(dirname(resolve(workspace, p)), { recursive: true }); await writeFile(resolve(workspace, p), text, { mode: 0o600 }); }
  assert.deepEqual(await snapshot(workspace), replay.initialFiles);
  const selected = selectedOverride ?? variant(arm, replay), calls = [], phases = [];
  let phase = 1, currentPrompt = selected.prompt;
  const modelPlugin = { id: 'diagnostic-model', version: '1.0.0', apiVersion: API_VERSION, scope: 'runtime', provides: [services.model, services.execution], requires: [], setup(ctx) {
    ctx.provide(services.execution, () => ({ execute: async () => { throw new Error('No command execution in diagnosis'); } }));
    ctx.provide(services.model, () => ({ definition: () => adapter.definition(), limits: () => adapter.limits(),
      prepare(messages, tools, output) {
        // Only replace the pre-existing history prefix. Real current-turn messages and tool results remain intact.
        assert.equal(messages[2].role, 'user'); assert.equal(messages[2].content, selected.prompt);
        const prefix = JSON.parse(JSON.stringify(selected.prefix).replaceAll(replay.sourceWorkspace, workspace));
        return adapter.prepare([...prefix, ...messages.slice(2)], tools.filter(t => t.name !== 'run_command' && replay.task.executionPolicy.allowedTools.includes(t.name)), output);
      },
      async complete(request, options) {
        if (calls.filter(c => c.phase === phase).length >= 12) throw new HarnessError('DIAGNOSTIC_CALL_LIMIT', 'Diagnostic request cap reached');
        if (!calls.length && arm === 'original') assert.deepEqual(normalizeRequest(request, workspace), normalizeRequest(replay.originalRequest, replay.sourceWorkspace), 'Original replay must match frozen first request except workspace path');
        const call = { phase, startedAt: new Date().toISOString(), requestHash: sha(JSON.stringify(request)), durationMs: null, usage: null, status: 'started' };
        calls.push(call); const began = performance.now();
        try { const result = await adapter.complete(request, options); call.status = 'completed'; call.usage = result.usage; call.finishReason = result.finishReason; return result; }
        catch (error) { call.status = 'failed'; call.errorCode = Number.isInteger(error?.status) ? `MODEL_HTTP_${error.status}` : /^[A-Z][A-Z0-9_]*$/.test(error?.code ?? '') ? error.code : 'MODEL_PROVIDER_FAILED'; throw error; }
        finally { call.durationMs = performance.now() - began; }
      },
    }));
  } };
  const allowed = p => replay.task.executionPolicy.allowedTools.includes(p.tool.name) && p.tool.name !== 'run_command';
  const runtime = await Runtime.create({ plugins: [createSessionPlugin({ directory: logs, durability: 'fsync' }), createContextPlugin(), createObservabilityPlugin(), modelPlugin,
    createCodingToolsPlugin(workspace, false), createPermissionPlugin(), createToolPipelinePlugin({ policy: { authorize: p => ({ decision: allowed(p) ? 'allow' : 'deny', reason: 'diagnostic-scoped-tools' }), assertCurrent: p => assert.ok(allowed(p)) }, approve: async approval => ({ binding: approval.binding, decision: 'allow' }) }, true), createCompactionPlugin(), createAgentLoopPlugin()], config: { permissions: { workspace, policyVersion: 'gold-v2', ttlMs: 120000 } } });
  const trial = { arm, repetition, workspace, initialStateVerified: true, phases, calls, status: 'running', cleanup: 'unconfirmed', sourcePrefix: arm === 'full-history' ? 'frozen-precompaction' : 'frozen-fixed-summary', continuationPrototype: allowContinuation };
  try {
    const session = await runtime.openSession('diagnostic');
    for (phase = 1; phase <= 2; phase++) {
      const signal = AbortSignal.timeout(120000), began = performance.now();
      await session.run(async run => {
        const result = await run.services.get(services.agentLoop).run(currentPrompt, signal);
        const trace = projectToolTrace(run.services.get(services.session).events(), run.id);
        const finalFiles = await snapshot(workspace);
        // Hidden graders run only after the agent. Feedback uses only the public target state below.
        const graders = await gradeTask(replay.task, workspace, result.text, { toolTrace: trace, runId: run.id, signal });
        const state = publicStateCheck(replay.initialFiles, finalFiles, publicContract);
        phases.push({ phase, runId: run.id, status: result.status, text: result.text, durationMs: performance.now() - began, trace, finalFiles, publicState: state, graders,
          passed: result.status === 'completed' && graders.every(g => g.status === 'passed') });
      });
      if (phase !== 1 || !allowContinuation || !shouldContinue(phases[0], phases[0].publicState)) break;
      currentPrompt = feedback;
    }
    trial.status = 'completed';
  } finally {
    await runtime.close(); trial.cleanup = !runtime.health().restartRequired && runtime.health().unresolved.length === 0 ? 'verified' : 'unconfirmed';
    trial.journal = sessionLogPath(logs, 'diagnostic');
    await writeJSON(resolve(directory, 'trial.json'), trial);
  }
  return trial;
}

export function summarize(trials) {
  return arms.map(arm => {
    const rows = trials.filter(t => t.arm === arm), passed = rows.filter(t => t.phases[0]?.passed).length;
    return { arm, trials: rows.length, passed, failed: rows.length - passed, wilson95: wilson(passed, rows.length),
      firstResponseNoTools: rows.filter(t => t.calls[0]?.finishReason === 'stop').length,
      outcomeFailedWithoutWrite: rows.filter(t => !t.phases[0]?.publicState.targetSatisfied && !['write_file', 'edit_file'].some(k => t.phases[0]?.trace.counts[k]?.dispatched)).length };
  });
}

export async function main(planOnly = false) {
  const frozen = await frozenCheck(), replay = await loadReplay();
  assert.equal(replay.model.endpoint, 'https://api.deepseek.com'); assert.equal(replay.model.model, 'deepseek-flash');
  const order = schedule();
  const plan = { version: 1, model: replay.model, repetitions: 8, order, frozen, sourceJournal: replay.sourceJournal, sourceJournalHash: replay.sourceJournalHash,
    variants: arms.map(arm => ({ arm, ...variant(arm, replay) })), initialFiles: replay.initialFiles, publicContract: contract,
    protocol: { purpose: 'GM-D19 final-turn controlled diagnosis, not a new aggregate baseline', sampling: 'provider default, no seed or temperature override', ordering: 'randomized within each repetition block, PRNG seed 2026100301', isolation: 'fresh real Runtime/Session/workspace per arm repetition; fixed successful historical prefix replayed', scoring: 'unchanged final-turn frozen graders, first-attempt outcomes retained', continuation: 'original arm only; at most one same-session continuation after public state check; conditional rescue is reported separately, not equal-budget evidence', retries: 0, concurrency: 1, perPhaseRequests: 12, perPhaseTimeoutMs: 120000, limitation: 'one scenario and one frozen successful prefix; no generalization claim; provider time/cache correlation remains possible' },
    authorization: { source: 'current user request plus persisted API authorization', statement: '接下来你来测试分析这个问题发生的原因，并给出改进方案', scope: 'official DeepSeek API; existing synthetic public task, selected historical messages, tool schemas/results and fresh workspace path; no graders, reference solution or review ledger in model input' } };
  if (planOnly) { console.log(JSON.stringify({ model: plan.model, trials: order.length, variants: arms, frozen, protocol: plan.protocol }, null, 2)); return plan; }
  await loadCliEnvironment(); assert.ok(process.env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY missing');
  const parent = resolve(root, '.minicah/premature-completion-diagnostics'); await mkdir(parent, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(resolve(parent, 'diagnosis-'));
  await writeJSON(resolve(output, 'plan.json'), plan); await copyFile(self, resolve(output, 'driver.mjs'));
  const report = { ...plan, startedAt: new Date().toISOString(), finishedAt: null, status: 'running', trials: [], output };
  const save = async () => { report.groups = summarize(report.trials); await writeJSON(resolve(output, 'report.json'), report); };
  console.log(`Diagnostic artifacts: ${output}`); await save();
  try {
    for (const row of order) {
      const directory = resolve(output, `${row.repetition}-${row.arm}`);
      const result = await executeTrial({ replay, ...row, directory, adapter: deepSeekModel(replay.model, process.env.DEEPSEEK_API_KEY), allowContinuation: row.arm === 'original' });
      report.trials.push(result); await save();
      console.log(JSON.stringify({ done: report.trials.length, total: order.length, arm: row.arm, repetition: row.repetition, firstPassed: result.phases[0].passed, rescued: result.phases.length === 2 ? result.phases[1].passed : null, calls: result.calls.length }));
      assert.equal(result.cleanup, 'verified'); assert.ok(result.calls.every(c => c.status === 'completed'), 'Provider error: stop campaign without retries');
      assert.ok(result.phases.every(p => p.graders.every(g => g.status !== 'error')), 'Grader error: stop campaign');
    }
    report.status = 'completed';
  } catch (error) { report.status = 'stopped'; report.error = error?.message?.startsWith('Provider error') ? 'PROVIDER_ERROR' : 'DIAGNOSTIC_STOPPED'; throw error; }
  finally { report.finishedAt = new Date().toISOString(); report.frozenAfter = await frozenCheck(); await save(); }
  console.log(JSON.stringify({ status: report.status, output, groups: report.groups }));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === self) await main(process.argv.includes('--plan'));
