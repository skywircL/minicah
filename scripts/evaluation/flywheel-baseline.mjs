import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const self = fileURLToPath(import.meta.url);
export const root = resolve(dirname(self), '../..');
export const defaultCases = ['GM-D19', 'GM-D04', 'GM-I06', 'GM-P11', 'GM-B33', 'GM-B06', 'GM-B02', 'GM-B17', 'GM-D10', 'GM-D23', 'GM-D28', 'GM-P03', 'GM-I01', 'GM-D02'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJSON = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const load = path => import(pathToFileURL(path).href);
const safePath = (directory, path) => {
  assert.equal(typeof path, 'string');
  const absolute = resolve(directory, path), rel = relative(directory, absolute);
  assert.ok(!isAbsolute(path) && rel && !rel.startsWith('../') && !isAbsolute(rel), `Invalid artifact path: ${path}`);
  return absolute;
};

/** Old source and its independently rebuilt dist are immutable comparison inputs. */
export async function verifySnapshot(directory) {
  const bytes = await readFile(resolve(directory, 'snapshot.json')), manifest = JSON.parse(bytes);
  assert.ok(manifest.files.some(row => row.path === 'src/agent/loop.ts'));
  assert.ok(manifest.files.some(row => row.path === 'dist/src/agent/loop.js'));
  for (const row of manifest.files) assert.equal(sha(await readFile(safePath(directory, row.path))), row.sha256, `Changed old snapshot: ${row.path}`);
  return { directory, hash: sha(bytes), description: manifest.description, createdAt: manifest.createdAt };
}

export async function runtimeFingerprint(directory = root) {
  const files = {};
  async function walk(path) {
    for (const entry of (await readdir(resolve(directory, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && /\.(ts|js|mjs|json)$/.test(entry.name)) files[child] = sha(await readFile(resolve(directory, child)));
    }
  }
  await walk('src'); await walk('dist/src');
  for (const path of ['package-lock.json', 'scripts/gold-seeds/conversation.mjs', 'scripts/evaluation/public-contracts.mjs']) files[path] = sha(await readFile(resolve(directory, path)));
  return { hash: sha(JSON.stringify(files)), files };
}

/** Verify this revision's data only; never rebind an old manifest to a new runtime. */
export async function loadDataset(directory) {
  const bytes = await readFile(resolve(directory, 'manifest.json')), manifest = JSON.parse(bytes);
  assert.equal(manifest.id, 'gold-flywheel-v1');
  for (const [path, hash] of Object.entries(manifest.files)) assert.equal(sha(await readFile(safePath(directory, path))), hash, `Changed flywheel artifact: ${path}`);
  for (const [path, hash] of Object.entries(manifest.sources ?? {})) assert.equal(sha(await readFile(safePath(root, path))), hash, `Changed flywheel source: ${path}`);
  const index = await readJSON(resolve(directory, 'index.json'));
  const { contentHash } = await load(resolve(root, 'dist/src/json.js'));
  const seeds = await Promise.all(index.cases.map(async row => {
    const seed = await readJSON(safePath(directory, row.file));
    assert.equal(contentHash(seed), row.contentHash, `Case content hash mismatch: ${row.id}`);
    assert.equal(seed.case_id, row.id); return seed;
  }));
  assert.equal(new Set(seeds.map(seed => seed.case_id)).size, seeds.length, 'Duplicate cases');
  return { index, manifest, manifestHash: sha(bytes), seeds };
}

/** Adjacent complete episodes alternate AB/BA; a dialogue is never split across arms. */
export function isSummaryRequest(messages, summaryPrompt) {
  return messages[0]?.role === 'system' && messages[0].content === String(summaryPrompt.content);
}

export function scheduleTrials(cases, repetitions) {
  if (repetitions !== undefined) assert.ok(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 100, 'Invalid repetitions');
  let pair = 0;
  return cases.flatMap(seed => Array.from({ length: repetitions ?? seed.trial_protocol.modelTrials }, (_, repetition) => {
    const pairId = `${seed.case_id}-r${repetition + 1}`, arms = pair++ % 2 ? ['new', 'old'] : ['old', 'new'];
    return arms.map((arm, orderInPair) => ({ pairId, taskId: seed.case_id, repetition: repetition + 1, arm, orderInPair, turns: seed.execution.tasks.length }));
  }).flat());
}

/** Trusted confirmed violations remain failures while unknown cleanup still stops execution. */
export function classifyEvidence(graders, { cleanup = 'verified', status = 'completed', infrastructure = false, confirmedFailure } = {}) {
  if (confirmedFailure === 'COMPLETION_PROTECTED_CHANGED') return {classification:'agent-failure',passed:false,score:null};
  if (cleanup !== 'verified' || status === 'unknown' || status === 'needs-reconciliation' || infrastructure) return { classification: 'infrastructure-failure', passed: null, score: null };
  if (status === 'cancelled') return { classification: 'cancelled', passed: null, score: null };
  if (graders.some(g => g.cleanup === 'unconfirmed')) return { classification: 'infrastructure-failure', passed: null, score: null };
  if (graders.some(g => g.required !== false && g.status === 'failed')) return { classification: 'task-failure', passed: false, score: null };
  if (status !== 'completed') return { classification: 'agent-failure', passed: false, score: 0 };
  if (!graders.length || graders.some(g => g.status === 'error')) return { classification: 'grader-failure', passed: null, score: null };
  const denominator = graders.reduce((n, g) => n + (g.weight ?? 1), 0);
  return { classification: 'success', passed: true, score: graders.reduce((n, g) => n + (g.weight ?? 1) * g.score, 0) / denominator };
}

/** An already observed failed turn cannot be erased by an absent later proposal. */
export function combineFirstProposals(candidates, expectedTurns) {
  const graded = candidates.filter(candidate => Array.isArray(candidate.graders));
  const known = classifyEvidence(graded.flatMap(candidate => candidate.graders));
  if (known.passed === false || known.classification === 'infrastructure-failure') return known;
  return graded.length === expectedTurns ? known : { classification: 'missing-first-proposal', passed: null, score: null };
}

/** Auxiliary diagnostic failures do not rewrite a verified final evaluation. */
export function trialFailurePatch(row, errorCode, workspace) {
  if(row.confirmedFailure==='COMPLETION_PROTECTED_CHANGED') return {
    classification:'agent-failure',passed:false,score:null,diagnosticErrorCode:errorCode,
    ...(row.cleanup!=='verified' || row.status==='unknown'?{retainedWorkspace:row.retainedWorkspace ?? workspace}:{}),
    firstProposal:row.firstProposal ?? {classification:'diagnostic-failure',passed:null,score:null},
  };
  if (row.cleanup === 'verified' && typeof row.passed === 'boolean') {
    const known = row.firstProposal ?? combineFirstProposals(row.candidates ?? [], row.turns);
    return { diagnosticErrorCode: errorCode,
      firstProposal: typeof known.passed === 'boolean' ? known : { classification: 'diagnostic-failure', passed: null, score: null } };
  }
  return { classification: 'infrastructure-failure', passed: null, score: null, errorCode, retainedWorkspace: workspace };
}

/** Cleanup safety is independent of a scored failure's classification. */
export function mustStopTrial(row, providerFailed=false) {
  return providerFailed || row.cleanup==='unconfirmed' || ['unknown','needs-reconciliation','cancelled'].includes(row.status)
    || ['infrastructure-failure','cancelled'].includes(row.classification);
}

/** Attempt both independent cleanups even when the first one rejects. */
export async function closeBaselineResources(runner, gradingRuntime) {
  return Promise.allSettled([Promise.resolve().then(()=>runner.close()),Promise.resolve().then(()=>gradingRuntime?.close())]);
}

export function summarizeUsage(calls) {
  return calls.reduce((out, call) => {
    out.requests++;
    if (call.usage) { out.withUsage++; for (const key of ['prompt', 'completion', 'total']) out.observedTokens[key] += call.usage[key]; }
    else out.missingUsage++;
    out.durationMs += call.durationMs ?? 0;
    return out;
  }, { requests: 0, withUsage: 0, missingUsage: 0, observedTokens: { prompt: 0, completion: 0, total: 0 }, durationMs: 0 });
}

export function summarizeTrials(trials) {
  const rate = rows => {
    const eligible = rows.filter(row => row.passed !== null && row.passed !== undefined);
    return { planned: rows.length, eligible: eligible.length, passed: eligible.filter(row => row.passed).length, failed: eligible.filter(row => !row.passed).length, excluded: rows.length - eligible.length, passRate: eligible.length ? eligible.filter(row => row.passed).length / eligible.length : null };
  };
  const arms = Object.fromEntries(['old', 'new'].map(arm => {
    const rows = trials.filter(row => row.arm === arm);
    return [arm, { final: rate(rows), firstProposal: rate(rows.map(row => ({ passed: row.firstProposal?.passed ?? null }))), usage: summarizeUsage(rows.flatMap(row => row.modelCalls ?? [])), firstUsage: summarizeUsage(rows.flatMap(row => (row.modelCalls ?? []).filter(call => call.phase === 'first'))), continuationUsage: summarizeUsage(rows.flatMap(row => (row.modelCalls ?? []).filter(call => call.phase === 'continuation'))), recovered: rows.filter(row => row.firstProposal?.passed === false && row.passed === true).length, regressedAfterFirst: rows.filter(row => row.firstProposal?.passed === true && row.passed === false).length }];
  }));
  const pairs = new Map();
  for (const row of trials) (pairs.get(row.pairId) ?? (pairs.set(row.pairId, {}), pairs.get(row.pairId)))[row.arm] = row;
  const paired = { eligible: 0, bothPassed: 0, bothFailed: 0, improved: 0, regressed: 0, incomplete: 0 };
  for (const pair of pairs.values()) {
    if (typeof pair.old?.passed !== 'boolean' || typeof pair.new?.passed !== 'boolean') { paired.incomplete++; continue; }
    paired.eligible++;
    paired[pair.old.passed ? pair.new.passed ? 'bothPassed' : 'regressed' : pair.new.passed ? 'improved' : 'bothFailed']++;
  }
  return { arms, paired };
}

const stableError = error => Number.isInteger(error?.status) ? `MODEL_HTTP_${error.status}` : /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'FLYWHEEL_EXECUTION_FAILED';
const markdown = report => {
  const stats = report.aggregate, percent = value => value === null ? '未知' : `${(value * 100).toFixed(2)}%`;
  return ['# 数据飞轮新旧版本对照',
    `状态：${report.status}。数据：${report.dataset.id}@${report.dataset.version}；模型 ${report.model.model}，thinking=${report.model.thinking}。开发诊断，不构成发布批准。`,
    '| 版本 | 最终通过/可计分 | 最终通过率 | 首次候选通过/可计分 | 续接恢复 | 模型请求 | 已观察 tokens |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...['old', 'new'].map(arm => { const row = stats.arms[arm]; return `| ${arm} | ${row.final.passed}/${row.final.eligible} | ${percent(row.final.passRate)} | ${row.firstProposal.passed}/${row.firstProposal.eligible} | ${row.recovered} | ${row.usage.requests} | ${row.usage.observedTokens.total} |`; }),
    '', `完整配对 ${stats.paired.eligible}，旧失败新通过 ${stats.paired.improved}，旧通过新失败 ${stats.paired.regressed}，双方通过 ${stats.paired.bothPassed}，双方失败 ${stats.paired.bothFailed}，不完整 ${stats.paired.incomplete}。`,
    'old 是本轮修复前、已含 Pi 接入的源码快照，不是 10 月 3 日历史版本。双方使用同一新版题面和 GT；new 的变量是 Harness 提示/完成协议及基于公开任务的契约。不能直接与历史 86.01% 相减解释增益。',
    '首次候选在每轮第一次无工具调用的 stop 时保存文件快照，并在执行结束后由 Host 按该时点轨迹独立判分。对话的后续轮次承接此前实际最终状态，首次候选合计是逐轮诊断，不是无续接的独立反事实整段执行。私有 grader、测试内容和判分结果不传给模型。',
    '首次与续接用量单独统计；未知用量不填零为已知账单。每次完整试验独立工作区、Runtime、Session、日志；对话轮内共享 Session；AB/BA 相邻交错。没有自动重跑失败试验，也不取最好一次。',
    '', '| 任务 | 重复 | old | new |', '| --- | ---: | --- | --- |',
    ...[...new Set(report.trials.map(row => row.pairId))].map(id => { const rows = report.trials.filter(row => row.pairId === id); return `| ${rows[0].taskId} | ${rows[0].repetition} | ${rows.find(row => row.arm === 'old')?.classification ?? 'missing'} | ${rows.find(row => row.arm === 'new')?.classification ?? 'missing'} |`; }), ''].join('\n');
};

export async function runFlywheelBaseline({ planOnly = false, cases, all = false, repetitions, output, datasetDirectory = resolve(root, 'evals/private/gold-flywheel-v1'), snapshotDirectory = resolve(root, '.minicah/flywheel-iteration/pre-change'), testModelFactory } = {}) {
  assert.ok(!(all && cases), 'Use --all or --cases, not both');
  const [environment, adapter] = await Promise.all([load(resolve(root, 'dist/src/cli/environment.js')), load(resolve(root, 'dist/src/agent/deepseek.js'))]);
  await environment.loadCliEnvironment();
  const model = adapter.deepSeekConfig({ endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', thinking: false, maxOutputTokens: 4096 });
  // Explicitly configured protocol; environment aliases cannot silently change the experiment.
  const [dataset, oldSnapshot, newRuntime] = await Promise.all([loadDataset(datasetDirectory), verifySnapshot(snapshotDirectory), runtimeFingerprint()]);
  const selectedIds = all ? dataset.seeds.map(seed => seed.case_id) : cases ?? defaultCases;
  assert.ok(selectedIds.length && new Set(selectedIds).size === selectedIds.length, 'Cases must be nonempty and unique');
  const seeds = selectedIds.map(id => { const seed = dataset.seeds.find(row => row.case_id === id); assert.ok(seed, `Unknown case: ${id}`); return seed; });
  const schedule = scheduleTrials(seeds, repetitions);
  const plan = { schemaVersion: 1, purpose: testModelFactory ? 'scripted-driver-validation' : 'paired-development-regression', split: 'gold_dev', dataset: { id: dataset.index.id, version: dataset.index.version, directory: datasetDirectory, manifestHash: dataset.manifestHash, humanReview: dataset.manifest.humanReview }, oldSnapshot, newRuntime, driverHash: sha(await readFile(self)), model,
    environment: { node: process.version, platform: platform(), release: release(), arch: arch(), dependencyLockHash: sha(await readFile(resolve(root, 'package-lock.json'))) },
    protocol: { concurrency: 1, order: 'adjacent AB/BA full episodes, alternating by pair', repetitionsOverride: repetitions ?? null, sdkRetries: 0, temperature: 'provider default', seed: 'not set', freshWorkspace: true, freshRuntime: true, freshSession: true, sameSessionWithinDialogue: true, hiddenGTToModel: false, guardContract: 'derived only from current/history public prompts by trusted host', firstProposal: 'per-turn first stop with snapshot + offline grading; later dialogue turns inherit prior actual final state', fixedCompaction: 'as declared in the revised dataset', failurePolicy: 'required failed grader dominates unavailable grader evidence; confirmed protection failure remains scored; ordinary unknown cleanup is excluded; all unknown cleanup/provider faults stop further trials' },
    cases: seeds.map(seed => ({ caseId: seed.case_id, family: seed.family_id, kind: seed.execution.kind, turns: seed.execution.tasks.length, repetitions: repetitions ?? seed.trial_protocol.modelTrials })),
    plannedTrials: schedule.length, plannedTrialsPerArm: schedule.length / 2, plannedTaskTurns: schedule.reduce((n, row) => n + row.turns, 0), plannedMinimumModelRequests: schedule.reduce((n, row) => n + row.turns, 0), schedule };
  if (planOnly) { console.log(JSON.stringify({ ...plan, credentialAvailable: !!process.env.DEEPSEEK_API_KEY }, null, 2)); return plan; }
  assert.ok(testModelFactory || process.env.DEEPSEEK_API_KEY, 'Set DEEPSEEK_API_KEY in the environment or local .env');
  const modules = await load(resolve(root, 'dist/src/index.js')), evaluation = await load(resolve(root, 'dist/src/evaluation/index.js'));
  const oldExecutor = await load(resolve(snapshotDirectory, 'dist/src/evaluation/coding-executor.js'));
  const newExecutor = await load(resolve(root, 'dist/src/evaluation/coding-executor.js'));
  const oldConversation = await load(resolve(snapshotDirectory, 'scripts/gold-seeds/conversation.mjs'));
  const newConversation = await load(resolve(root, 'scripts/gold-seeds/conversation.mjs'));
  const { publicAgentOptions } = await load(resolve(root, 'scripts/evaluation/public-contracts.mjs'));
  const { readJournalSnapshot } = await load(resolve(root, 'dist/src/session/file-journal.js'));
  const summaries = { old: (await load(resolve(snapshotDirectory, 'dist/src/agent/compaction.js'))).summaryPrompt, new: (await load(resolve(root, 'dist/src/agent/compaction.js'))).summaryPrompt };
  const parent = output ? resolve(output) : resolve(root, '.minicah/flywheel-iteration/runs');
  for (const protectedDirectory of [snapshotDirectory, datasetDirectory]) { const rel = relative(protectedDirectory, parent); assert.ok(rel.startsWith('../') || isAbsolute(rel), 'Output must be outside the immutable input directories'); }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const artifacts = await mkdtemp(resolve(await realpath(parent), 'paired-')); await writeJSON(resolve(artifacts, 'plan.json'), plan); await copyFile(self, resolve(artifacts, 'driver.mjs'));
  const report = { ...plan, artifactDirectory: artifacts, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, releaseReady: false, trials: schedule.map(row => ({ ...row, classification: 'not-started', passed: null, score: null, modelCalls: [], candidates: [] })), evidence: [] };
  const controller = new AbortController(), abort = () => controller.abort(); process.on('SIGINT', abort);
  const save = async () => { report.aggregate = summarizeTrials(report.trials); await writeJSON(resolve(artifacts, 'report.json'), report); await writeFile(resolve(artifacts, 'report.md'), markdown(report), { mode: 0o600 }); };
  const evidence = async path => { report.evidence.push({ path, hash: sha(await readFile(path)) }); };
  const runner = new evaluation.EvaluationRunner(); let gradingRuntime;
  console.log(`Flywheel paired artifacts: ${artifacts}`); await save();
  try {
    const packs = await Promise.all(['parent.tests.json', 'prior.tests.json', 'boundary.tests.json'].map(name => readJSON(resolve(datasetDirectory, name))));
    gradingRuntime = await modules.Runtime.create({ plugins: [...packs.map(pack => modules.createSandboxTestPackPlugin(pack)), modules.createSandboxTestPlugin({ backend: 'native' })] });
    const gradingSession = await gradingRuntime.openSession();
    await gradingSession.run(async gradingRun => {
      const sandboxTests = gradingRun.services.get(modules.sandboxTestService);
      for (const [position, row] of report.trials.entries()) {
        if (controller.signal.aborted) break;
        const seed = seeds.find(seed => seed.case_id === row.taskId), directory = resolve(artifacts, `${String(position + 1).padStart(4, '0')}-${row.pairId}-${row.arm}`);
        await mkdir(directory, { mode: 0o700 }); row.startedAt = new Date().toISOString(); const started = performance.now();
        let workspace, turn = 0, providerFailed = false;
        const modelFactory = publicTask => {
          const taskTurn = publicTask ? seed.execution.tasks.findIndex(task => task.id === publicTask.id) : turn;
          assert.ok(taskTurn >= 0); turn = taskTurn;
          const delegate = testModelFactory ? testModelFactory(publicTask ?? seed.execution.tasks[0], row.arm) : adapter.deepSeekModel(model, process.env.DEEPSEEK_API_KEY);
          let proposed = false, callIndex = 0, agentCallIndex = 0; const purposes = new WeakMap();
          return { ...delegate, prepare(messages, tools, maxOutputTokens) {
            const request = delegate.prepare(messages, tools, maxOutputTokens); purposes.set(request, isSummaryRequest(messages, summaries[row.arm]) ? 'compaction' : 'agent'); return request;
          }, async complete(request, options = {}) {
            const purpose = purposes.get(request) ?? 'agent'; if (purpose === 'agent') agentCallIndex++;
            const sample = { turn: taskTurn + 1, index: ++callIndex, purpose, phase: proposed ? 'continuation' : 'first', usage: null, status: 'running', startedAt: new Date().toISOString() };
            row.modelCalls.push(sample); const began = performance.now();
            try {
              const result = await delegate.complete(request, { ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
              sample.usage = result.usage; sample.status = 'completed';
              // Snapshot before any completion-contract continuation changes the state.
              if (!proposed && result.finishReason === 'stop' && !result.message.tool_calls?.length && purpose === 'agent') {
                proposed = true;
                const snapshot = resolve(directory, `first-turn-${taskTurn + 1}`);
                await cp(workspace, snapshot, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
                row.candidates.push({ turn: taskTurn + 1, callIndex, agentCallIndex, providerId: result.providerId, text: result.message.content ?? '', workspace: snapshot, capturedAt: new Date().toISOString() });
              }
              return result;
            } catch (error) { sample.status = 'failed'; sample.errorCode = stableError(error); providerFailed = true; throw error; }
            finally { sample.durationMs = performance.now() - began; }
          } };
        };
        const agentOptions = row.arm === 'new' ? publicAgentOptions : undefined;
        try {
          console.log(`${position + 1}/${report.trials.length} ${row.taskId} r${row.repetition} ${row.arm}`);
          let result, journals;
          if (seed.execution.kind === 'coding') {
            const execute = (row.arm === 'old' ? oldExecutor : newExecutor).createCodingTrialExecutor({ allowWrites: true, modelFactory: () => modelFactory(), ...(agentOptions ? { agentOptions } : {}) });
            result = await runner.run({ schemaVersion: 1, id: 'flywheel-paired', version: dataset.index.version, split: 'regression', tasks: seed.execution.tasks }, async request => {
              workspace = request.workspace;
              for (const [path, expected] of Object.entries(request.task.files)) assert.equal(await readFile(resolve(workspace, path), 'utf8'), expected, 'Initial state mismatch');
              return execute(request);
            }, { outputDirectory: directory, repetitions: 1, concurrency: 1, sandboxTests, signal: controller.signal, reference: { model: model.model, configurationHash: sha(JSON.stringify(plan.model)), executor: `flywheel-${row.arm}` } });
            const trial = result.trials[0];
            Object.assign(row, { ...trial, taskId: row.taskId, repetition: row.repetition, report: resolve(result.artifactDirectory, 'report.json') });
            journals = trial.journalRefs.map(path => resolve(result.artifactDirectory, path));
          } else {
            workspace = resolve(directory, 'workspace');
            result = await (row.arm === 'old' ? oldConversation : newConversation).executeConversation(seed, directory, { modelFactory, ...(agentOptions ? { agentOptions } : {}), signal: controller.signal });
            const status = result.cleanup!=='verified' || result.status==='unknown' || result.turns.some(item => item.status === 'needs-reconciliation') ? 'unknown' : result.status==='cancelled' || result.turns.some(item => item.status === 'cancelled') ? 'cancelled' : result.status==='failed' || result.turns.some(item => item.status !== 'completed') ? 'failed' : 'completed';
            const confirmedFailure=result.confirmedFailure ?? result.turns.find(item=>item.confirmedFailure)?.confirmedFailure;
            Object.assign(row, classifyEvidence(result.turns.flatMap(item => item.graders), { cleanup: result.cleanup, status, infrastructure: providerFailed || result.failureKind==='infrastructure', confirmedFailure }),
              { status, cleanup: result.cleanup, ...(confirmedFailure?{confirmedFailure}:{}), ...(result.retainedWorkspace?{retainedWorkspace:result.retainedWorkspace}:{}), ...(result.errorCode?{errorCode:result.errorCode}:{}), runIds: result.turns.map(item => item.runId), report: resolve(directory, 'report.json'), graders: result.turns.flatMap(item => item.graders) });
            await writeJSON(row.report, result); journals = [result.journal];
          }
          row.journals = journals; await evidence(row.report);
          const events = (await Promise.all(journals.map(async path => { await evidence(path); const snapshot = await readJournalSnapshot(path); assert.equal(snapshot.discardedTailBytes, 0, 'Incomplete journal tail'); return snapshot.events; }))).flat();
          for (const candidate of row.candidates) {
            const runId = seed.execution.kind === 'coding' ? row.runId : result.turns[candidate.turn - 1].runId;
            const completed = events.filter(event => event.runId === runId && event.data.type === 'model.completed' && event.data.response?.format === 'coding-agent-v1');
            const boundary = completed[candidate.agentCallIndex - 1];
            assert.ok(boundary && boundary.data.response.completion.providerId === candidate.providerId, 'Candidate/journal request mismatch');
            const prefix = events.filter(event => event.seq <= boundary.seq);
            const trace = evaluation.projectToolTrace(prefix, runId);
            const observation = modules.projectObservability(prefix);
            assert.ok(observation.calls.filter(call => call.runId === runId).every(call => !['unknown', 'unfinished', 'not-started'].includes(call.status)), 'Unsettled candidate trace');
            // Host checkpoint is terminal for this independent first-proposal grading only.
            // No synthetic events are written into the agent journal or given to the model.
            const graders = await evaluation.gradeTask(seed.execution.tasks[candidate.turn - 1], candidate.workspace, candidate.text, { sandboxTests, runId, toolTrace: { ...trace, complete: true }, signal: controller.signal });
            Object.assign(candidate, { runId, throughSeq: boundary.seq, traceBasis: 'settled tool prefix at first proposal', graders, ...classifyEvidence(graders) });
          }
          row.firstProposal = combineFirstProposals(row.candidates, seed.execution.tasks.length);
          row.guardEvents = events.filter(event => event.data.type === 'context.measured' && event.data.measurement?.kind === 'completion-contract-v1').map(event => ({ seq: event.seq, runId: event.runId, measurement: event.data.measurement }));
          row.usage = { first: summarizeUsage(row.modelCalls.filter(call => call.phase === 'first')), continuation: summarizeUsage(row.modelCalls.filter(call => call.phase === 'continuation')), total: summarizeUsage(row.modelCalls) };
          if (mustStopTrial(row,providerFailed)) controller.abort();
        } catch (error) { Object.assign(row, trialFailurePatch(row, stableError(error), workspace)); controller.abort(); }
        row.durationMs = performance.now() - started; await save();
      }
    });
    report.status = controller.signal.aborted ? 'stopped' : 'completed';
  } catch (error) { report.status = 'failed'; report.errorCode = stableError(error); }
  finally {
    const cleanup=await closeBaselineResources(runner,gradingRuntime);
    if(cleanup.some(result=>result.status==='rejected')) { report.status = 'failed'; report.errorCode = 'FLYWHEEL_CLEANUP_UNCONFIRMED'; }
    process.off('SIGINT', abort); report.finishedAt = new Date().toISOString();
    try { report.fingerprintCurrent = (await runtimeFingerprint()).hash === newRuntime.hash && (await loadDataset(datasetDirectory)).manifestHash === dataset.manifestHash && (await verifySnapshot(snapshotDirectory)).hash === oldSnapshot.hash && sha(await readFile(self)) === plan.driverHash; } catch { report.fingerprintCurrent = false; }
    if (!report.fingerprintCurrent) report.status = 'stale'; await save();
  }
  console.log(JSON.stringify({ artifacts, status: report.status, aggregate: report.aggregate }, null, 2)); return report;
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  const { values } = parseArgs({ options: { plan: { type: 'boolean' }, all: { type: 'boolean' }, cases: { type: 'string' }, repetitions: { type: 'string' }, output: { type: 'string' }, dataset: { type: 'string' }, snapshot: { type: 'string' } } });
  const result = await runFlywheelBaseline({ planOnly: values.plan ?? false, all: values.all ?? false, ...(values.cases === undefined ? {} : { cases: values.cases.split(',').map(value => value.trim()).filter(Boolean) }), ...(values.repetitions === undefined ? {} : { repetitions: Number(values.repetitions) }), output: values.output, ...(values.dataset ? { datasetDirectory: resolve(values.dataset) } : {}), ...(values.snapshot ? { snapshotDirectory: resolve(values.snapshot) } : {}) });
  if (!values.plan && result.status !== 'completed') process.exitCode = 1;
}
