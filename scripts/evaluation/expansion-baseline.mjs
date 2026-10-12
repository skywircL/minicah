import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { platform, release, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Runtime, createSandboxTestPackPlugin, createSandboxTestPlugin, sandboxTestService } from '../../dist/src/index.js';
import { EvaluationRunner, aggregateTrials } from '../../dist/src/evaluation/index.js';
import { createCodingTrialExecutor } from '../../dist/src/evaluation/coding-executor.js';
import { deepSeekConfig, deepSeekModel } from '../../dist/src/agent/deepseek.js';
import { loadCliEnvironment } from '../../dist/src/cli/environment.js';
import { contentHash } from '../../dist/src/json.js';
import { executeConversation } from '../gold-seeds/conversation.mjs';
import { checkManifest, fingerprint, directory, root, readJSON, writeJSON, sha } from '../gold-expansion/common.mjs';

const self = fileURLToPath(import.meta.url);
export function conversationOutcome(report, errors = []) {
  if (report.cleanup !== 'verified') return { classification: 'infrastructure-failure', passed: null, score: null };
  if (report.turns.some(t => t.status === 'cancelled')) return { classification: 'cancelled', passed: null, score: null };
  if (report.turns.some((t, i) => t.status !== 'completed' && (t.status === 'needs-reconciliation' || errors.some(e => e.turn === i)))) return { classification: 'infrastructure-failure', passed: null, score: null };
  if (report.turns.some(t => t.status !== 'completed')) return { classification: 'agent-failure', passed: false, score: 0 };
  const graders = report.turns.flatMap(t => t.graders);
  if (!graders.length || graders.some(g => g.cleanup === 'unconfirmed')) return { classification: 'infrastructure-failure', passed: null, score: null };
  const failed = graders.some(g => g.required && g.status === 'failed'), error = graders.some(g => g.status === 'error');
  if (!failed && error) return { classification: 'grader-failure', passed: null, score: null };
  return { classification: failed ? 'task-failure' : 'success', passed: !failed,
    score: error ? null : graders.reduce((n, g) => n + g.weight * g.score, 0) / graders.reduce((n, g) => n + g.weight, 0) };
}
function stableError(error) {
  return Number.isInteger(error?.status) ? `MODEL_HTTP_${error.status}` : /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'MODEL_PROVIDER_FAILED';
}
function markdown(report) {
  const a = report.aggregate;
  return ['# 受控变体真实模型验证',
    `数据版本 ${report.datasetVersion}；模型 ${report.model.model}；状态 ${report.status}。机器读取的逐条人审台账状态为 ${report.humanReview}，结果用于开发诊断，不构成发布批准。`,
    `计划 ${a.plannedTrials} 次；可计分 ${a.eligibleTrials} 次；通过 ${report.trials.filter(t=>t.passed===true).length} 次；失败 ${report.trials.filter(t=>t.passed===false).length} 次；排除/未运行 ${a.excludedTrials} 次。宏平均 pass@1：${a.macroPassAt1===null?'未知':(100*a.macroPassAt1).toFixed(1)+'%'}。`,
    ['| 种子 | 可计分/计划 | 通过 | pass@1 | 失败判据 |', '| --- | ---: | ---: | ---: | --- |',
    ...a.cases.map(c=>`| ${c.taskId} | ${c.eligibleTrials}/${c.plannedTrials} | ${c.passedTrials} | ${c.passAt1===null?'未知':(100*c.passAt1).toFixed(1)+'%'} | ${[...new Set(report.trials.filter(t=>t.taskId===c.taskId).flatMap(t=>t.failedGraders ?? []))].join('、')||'—'} |`)].join('\n'),
    '', `模型请求 ${report.usage.requests} 次，${report.usage.withUsage} 次取得用量，${report.usage.missingUsage} 次用量未知；已观察 token 合计 ${report.usage.withUsage ? report.usage.observedTokens.total : '未知'}，不等同于账单。`,
    '对话变体每次试验保留同一个 Session，题目规定的三个或四个用户轮次合计为一次试验。约定压缩场景使用题目固定的压缩文本，不能据此宣称模型自动摘要能力已通过。',
    '同一源问题的变体不算独立样本，本批 150 条变体来自 10 个父家族；公开审阅过的 gold_dev 不属于未见留出集。完整逐项结果、排除原因、原始报告和日志见 report.json。', ''].join('\n\n');
}
export async function runExpansionBaseline({ planOnly=false, repetitions, output }={}) {
  if (repetitions !== undefined) assert.ok(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 100, 'Invalid repetitions');
  await loadCliEnvironment();
  const model = deepSeekConfig({ model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', endpoint: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com' });
  assert.equal(model.endpoint, 'https://api.deepseek.com', 'This campaign is authorized for the official DeepSeek endpoint');
  const manifest = await checkManifest(), version = await fingerprint();
  const pointer = await readJSON(resolve(directory, 'calibration-latest.json'));
  assert.equal(pointer.manifestHash, manifest.hash, 'Recalibrate changed data first');
  assert.equal(pointer.runtimeHash, version.hash, 'Recalibrate changed runtime first');
  assert.equal(sha(await readFile(pointer.report)), pointer.reportHash);
  const calibration = await readJSON(pointer.report);
  assert.equal(calibration.status, 'passed');
  for (const e of calibration.evidence) assert.equal(sha(await readFile(e.path)), e.hash, 'Calibration evidence changed');
  const index = await readJSON(resolve(directory, 'index.json'));
  const seeds = await Promise.all(index.cases.map(async row=>{
    const seed=await readJSON(resolve(directory,row.file));assert.equal(contentHash(seed),row.contentHash);return seed;
  }));
  const ledger=await readJSON(resolve(directory,'human-reviews.json'));
  const parentBaseline=await readJSON(resolve(root,manifest.manifest.parent.baseline));
  assert.deepEqual(model,parentBaseline.model,'Keep the configured model identical for the parent comparison');
  const plan={schemaVersion:1,datasetId:'gold-mutations-v2',datasetVersion:index.version,parentVersion:index.parentVersion,parentBaseline:{report:manifest.manifest.parent.baseline,hash:manifest.manifest.parent.baselineHash},manifestHash:manifest.hash,runtimeHash:version.hash,driverHash:sha(await readFile(self)),model,
    purpose:'expansion-development-validation',split:'gold_dev',repetitionsOverride:repetitions ?? null,concurrency:1,
    cases:seeds.map(s=>({caseId:s.case_id,contentHash:index.cases.find(r=>r.id===s.case_id).contentHash,parentId:s.seed_id,family:s.family_id,operator:s.mutation_type,capability:s.capability_id,risk:s.risk_level,kind:s.execution.kind,
      repetitions:repetitions ?? s.trial_protocol.modelTrials,turns:s.execution.tasks.length})),
    environment:{node:process.version,platform:platform(),release:release(),arch:arch(),dependencyLockHash:sha(await readFile(resolve(root,'package-lock.json')))},
    protocol:{trialOrder:'dataset order, consecutive repetitions, coding then dialogues',freshWorkspacePerTrial:true,freshRuntimePerTrial:true,freshSessionPerTrial:true,dialogueSession:'same session within each episode',tools:'native file tools, task allow-list; no shell exposed',sdkRetries:0,sampling:{temperature:'provider default; not explicitly set',seed:'not set'},timeoutMs:120000,cancellationGraceMs:10000,fixedCompaction:'as frozen per case',statistics:{casePassAt1:'arithmetic mean across case success rates',familyMacro:'equal weight to each of 10 parent families',confidence:'95% Wilson per case (IID-conditional); descriptive family-cluster bootstrap, 10000 resamples, fixed PRNG seed',stability:'observed all-k success, separately for k=3 and k=7; combinatorial pass^3 for all complete cases',latency:'all vs successful-and-behavior-passing trials; wall duration and model request duration measured separately',safety:'separate frozen preserve/write-scope/no-command/denial/read-only graders; no new blanket safety claim'},judge:'deterministic local graders; no LLM judge',failurePolicy:'required grader failure overrides other grader errors; stop on provider/infrastructure failure; no automatic trial retries'},
    humanReview:'pending',humanLedgerHash:contentHash(ledger),calibrationEvidence:{report:pointer.report,hash:pointer.reportHash,trials:calibration.trials.length}};
  plan.plannedTrials=plan.cases.reduce((n,s)=>n+s.repetitions,0);
  if(planOnly) {console.log(JSON.stringify({...plan,credentialAvailable:!!process.env.DEEPSEEK_API_KEY},null,2));return plan;}
  assert.ok(process.env.DEEPSEEK_API_KEY,'Set DEEPSEEK_API_KEY in the local environment or .env');
  const parent=resolve(output ?? resolve(root,'.minicah/gold-expansion-baselines'));await mkdir(parent,{recursive:true,mode:0o700});
  const artifacts=await mkdtemp(resolve(parent,'baseline-'));await writeJSON(resolve(artifacts,'plan.json'),plan);
  await copyFile(self,resolve(artifacts,'driver.mjs'));
  const report={...plan,artifactDirectory:artifacts,status:'running',startedAt:new Date().toISOString(),finishedAt:null,releaseReady:false,
    usage:{requests:0,withUsage:0,missingUsage:0,observedTokens:{prompt:0,completion:0,total:0}},
    trials:plan.cases.flatMap(s=>Array.from({length:s.repetitions},(_,i)=>({taskId:s.caseId,repetition:i+1,classification:'not-started',passed:null,score:null,report:null}))),evidence:[]};
  const controller=new AbortController(), abort=()=>controller.abort();process.on('SIGINT',abort);
  const save=async()=>{report.aggregate=aggregateTrials(report.trials);await writeJSON(resolve(artifacts,'report.json'),report);await writeFile(resolve(artifacts,'report.md'),markdown(report),{mode:0o600});};
  await save();console.log(`Baseline artifacts: ${artifacts}`);
  const errors=[];let activeTrial=null, initialFiles=null;
  const modelFactory=turn=>{
    const adapter=deepSeekModel(model,process.env.DEEPSEEK_API_KEY);
    return {...adapter,async complete(request,options={}) {
      if(activeTrial && !activeTrial.initialStateVerified && initialFiles) {
        for(const [path,expected] of Object.entries(initialFiles))assert.equal(await readFile(resolve(activeTrial.workspace,path),'utf8'),expected,'Initial dialogue workspace mismatch');
        activeTrial.initialStateVerified=true;
      }
      report.usage.requests++;
      const started=performance.now(), sample={taskId:activeTrial?.taskId,repetition:activeTrial?.repetition,turn:turn+1,startedAt:new Date().toISOString(),usage:null,status:'running',durationMs:null};
      activeTrial?.modelCalls.push(sample);
      try {
        const result=await adapter.complete(request,{...options,signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal});
        if(result.usage) {report.usage.withUsage++;for(const k of ['prompt','completion','total'])report.usage.observedTokens[k]+=result.usage[k];}
        else report.usage.missingUsage++;
        sample.status='completed';sample.usage=result.usage;return result;
      } catch(error) {report.usage.missingUsage++;errors.push({taskId:activeTrial?.taskId,repetition:activeTrial?.repetition,turn,code:stableError(error)});sample.status='failed';sample.errorCode=stableError(error);throw error;}finally{sample.durationMs=performance.now()-started;}
    }};
  };
  const runner=new EvaluationRunner();let runtime;
  const evidence=async path=>{report.evidence.push({path,hash:sha(await readFile(path))});};
  try {
    runtime=await Runtime.create({plugins:[createSandboxTestPackPlugin(await readJSON(resolve(directory,'parent.tests.json'))),createSandboxTestPackPlugin(await readJSON(resolve(directory,'prior.tests.json'))),createSandboxTestPackPlugin(await readJSON(resolve(directory,'boundary.tests.json'))),createSandboxTestPlugin({backend:'native'})]});
    const session=await runtime.openSession();
    await session.run(async run=>{
      const singles=seeds.filter(s=>s.execution.kind==='coding');let executed=0;
      for(const seed of singles) {
      if(controller.signal.aborted)break;
      const result=await runner.run({schemaVersion:1,id:'expansion-real-baseline',version:index.version,split:'capability',tasks:[seed.execution.tasks[0]]},async request=>{
        activeTrial=report.trials.find(t=>t.taskId===request.task.id && t.classification==='not-started' && !t.modelCalls);assert.ok(activeTrial);activeTrial.modelCalls=[];
        console.log(`Single-turn ${++executed}/662: ${request.task.id} repeat ${activeTrial.repetition}`);
        for(const [path,expected] of Object.entries(request.task.files??{}))assert.equal(await readFile(resolve(request.workspace,path),'utf8'),expected,'Initial workspace mismatch');
        activeTrial.workspace=request.workspace;activeTrial.initialStateVerified=true;
        const outcome=await createCodingTrialExecutor({allowWrites:true,modelFactory:()=>modelFactory(0)})(request);
        if(outcome.status==='unknown' || outcome.failureKind==='infrastructure') setTimeout(abort,0);
        return outcome;
      },{outputDirectory:artifacts,signal:controller.signal,concurrency:1,...(repetitions===undefined?{}:{repetitions}),sandboxTests:run.services.get(sandboxTestService),
        reference:{model:model.model,configurationHash:contentHash(plan),executor:'coding-agent-v1'}});
      const path=resolve(result.artifactDirectory,'report.json');await evidence(path);
      for(const trial of result.trials) {
        const row=report.trials.find(t=>t.taskId===trial.taskId && t.repetition===trial.repetition);
        assert.ok(row);Object.assign(row,{durationMs:trial.durationMs,startedAt:trial.startedAt,trialId:trial.trialId,runId:trial.runId,sessionId:trial.sessionId,classification:trial.classification,passed:trial.passed,score:trial.score,cleanup:trial.cleanup,status:trial.status,errorCode:trial.errorCode,
          failedGraders:trial.graders.filter(g=>g.status==='failed').map(g=>g.id),erroredGraders:trial.graders.filter(g=>g.status==='error').map(g=>g.id),report:path});
        for(const ref of trial.journalRefs)await evidence(resolve(result.artifactDirectory,ref));
      }
      if(result.status!=='completed')controller.abort();await save();
      console.log(`Checkpoint: ${report.trials.filter(t=>t.passed!==null).length}/${plan.plannedTrials} scored; ${report.trials.filter(t=>t.passed===false).length} failed`);
      }
    });
    for(const seed of seeds.filter(s=>s.execution.kind==='conversation')) {
      for(const row of report.trials.filter(t=>t.taskId===seed.case_id)) {
        if(controller.signal.aborted)break;
        console.log(`Conversation ${seed.case_id}: ${row.repetition}/${plan.cases.find(s=>s.caseId===seed.case_id).repetitions}`);
        const path=resolve(artifacts,`${seed.case_id}-${row.repetition}`);await mkdir(path,{mode:0o700});
        activeTrial=row;initialFiles=seed.initial_state.files;row.workspace=resolve(path,'workspace');row.modelCalls=[];row.startedAt=new Date().toISOString();const started=performance.now();
        let turn=0;const before=errors.length;
        try {
          const result=await executeConversation(seed,path,{modelFactory:()=>modelFactory(turn++)});
          row.durationMs=performance.now()-started;
          assert.equal(result.turns.length,seed.execution.tasks.length,'Missing dialogue turn');
          result.driver='same-session-real-model';result.modelApiCalls=null;
          const file=resolve(path,'report.json');await writeJSON(file,result);await evidence(file);await evidence(result.journal);
          Object.assign(row,conversationOutcome(result,errors.slice(before)),{cleanup:result.cleanup,status:result.status,
            failedGraders:result.turns.flatMap(t=>t.graders.filter(g=>g.status==='failed').map(g=>`turn-${t.turn}/${g.id}`)),
            erroredGraders:result.turns.flatMap(t=>t.graders.filter(g=>g.status==='error').map(g=>`turn-${t.turn}/${g.id}`)),report:file});
          if(row.classification==='infrastructure-failure')controller.abort();
        } catch {Object.assign(row,{classification:'infrastructure-failure',passed:null,score:null,cleanup:'unconfirmed',errorCode:'BASELINE_CONVERSATION_UNCONFIRMED',retainedWorkspace:path});controller.abort();}
        await save();
      }
    }
    report.status=controller.signal.aborted?'stopped':'completed';
  } catch {report.status='failed';report.errorCode='BASELINE_RUNTIME_FAILED';}
  finally {
    try {await runner.close();await runtime?.close();}catch {report.status='failed';report.errorCode='BASELINE_CLEANUP_UNCONFIRMED';}
    process.off('SIGINT',abort);
    report.providerErrors=errors;report.finishedAt=new Date().toISOString();
    report.fingerprintCurrent=(await fingerprint()).hash===version.hash && (await checkManifest()).hash===manifest.hash && sha(await readFile(self))===plan.driverHash;
    if(!report.fingerprintCurrent)report.status='stale';await save();
  }
  console.log(JSON.stringify({status:report.status,planned:report.aggregate.plannedTrials,eligible:report.aggregate.eligibleTrials,passAt1:report.aggregate.macroPassAt1,artifacts}));
  return report;
}
if(process.argv[1] && resolve(process.argv[1])===self) {
  const {values}=parseArgs({options:{plan:{type:'boolean'},repetitions:{type:'string'},output:{type:'string'}}});
  const report=await runExpansionBaseline({planOnly:values.plan??false,...(values.repetitions===undefined?{}:{repetitions:Number(values.repetitions)}),output:values.output});
  if(!values.plan && report.status!=='completed')process.exitCode=1;
}
