import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Runtime, createSandboxTestPackPlugin, createSandboxTestPlugin, sandboxTestService } from '../../dist/src/index.js';
import { EvaluationRunner, aggregateTrials } from '../../dist/src/evaluation/index.js';
import { createCodingTrialExecutor } from '../../dist/src/evaluation/coding-executor.js';
import { deepSeekConfig, deepSeekModel } from '../../dist/src/agent/deepseek.js';
import { loadCliEnvironment } from '../../dist/src/cli/environment.js';
import { contentHash } from '../../dist/src/json.js';
import { executeConversation } from '../gold-seeds/conversation.mjs';
import { checkManifest, fingerprint, directory, root, readJSON, writeJSON, sha } from '../gold-seeds/common.mjs';

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
  return ['# 金种子真实模型开发基线',
    `数据版本 ${report.datasetVersion}；模型 ${report.model.model}；状态 ${report.status}。当前人工验收仍为 ${report.humanReview}，结果用于开发诊断，不构成发布批准。`,
    `计划 ${a.plannedTrials} 次；可计分 ${a.eligibleTrials} 次；通过 ${report.trials.filter(t=>t.passed===true).length} 次；失败 ${report.trials.filter(t=>t.passed===false).length} 次；排除/未运行 ${a.excludedTrials} 次。宏平均 pass@1：${a.macroPassAt1===null?'未知':(100*a.macroPassAt1).toFixed(1)+'%'}。`,
    ['| 种子 | 可计分/计划 | 通过 | pass@1 | 失败判据 |', '| --- | ---: | ---: | ---: | --- |',
    ...a.cases.map(c=>`| ${c.taskId} | ${c.eligibleTrials}/${c.plannedTrials} | ${c.passedTrials} | ${c.passAt1===null?'未知':(100*c.passAt1).toFixed(1)+'%'} | ${[...new Set(report.trials.filter(t=>t.taskId===c.taskId).flatMap(t=>t.failedGraders ?? []))].join('、')||'—'} |`)].join('\n'),
    '', `模型请求 ${report.usage.requests} 次，${report.usage.withUsage} 次取得用量，${report.usage.missingUsage} 次用量未知；已观察 token 合计 ${report.usage.withUsage ? report.usage.observedTokens.total : '未知'}，不等同于账单。`,
    'A5 每次试验保留同一个 Session，两个用户轮次合计为一次试验。A5-02 使用题目固定的压缩文本，不能据此宣称模型自动摘要能力已通过。H/P 工程结果引用当前校准，未混入模型通过率。',
    '同一源问题的变体不算独立样本；公开审阅过的 gold_dev 不属于未见留出集。完整逐项结果、排除原因、原始报告和日志见 report.json。', ''].join('\n\n');
}
export async function runBaseline({ planOnly=false, repetitions, output }={}) {
  if (repetitions !== undefined) assert.ok(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 100, 'Invalid repetitions');
  await loadCliEnvironment();
  const model = deepSeekConfig({ model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', endpoint: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com' });
  const manifest = await checkManifest(), version = await fingerprint();
  const pointer = await readJSON(resolve(directory, 'calibration-latest.json'));
  assert.equal(pointer.manifestHash, manifest.hash, 'Recalibrate changed data first');
  assert.equal(pointer.runtimeHash, version.hash, 'Recalibrate changed runtime first');
  assert.equal(sha(await readFile(pointer.report)), pointer.reportHash);
  const calibration = await readJSON(pointer.report);
  assert.equal(calibration.status, 'passed');
  for (const e of calibration.evidence) assert.equal(sha(await readFile(e.path)), e.hash, 'Calibration evidence changed');
  const index = await readJSON(resolve(directory, 'index.json'));
  const seeds = await Promise.all(index.seeds.filter(s=>s.track==='agent-task').map(async row=>{
    const seed=await readJSON(resolve(directory,row.file));assert.equal(contentHash(seed),row.contentHash);return seed;
  }));
  const ledger=await readJSON(resolve(directory,'human-reviews.json'));
  const plan={schemaVersion:1,datasetVersion:index.version,manifestHash:manifest.hash,runtimeHash:version.hash,driverHash:sha(await readFile(self)),model,
    purpose:'development-baseline',split:'gold_dev',repetitionsOverride:repetitions ?? null,concurrency:1,
    cases:seeds.map(s=>({caseId:s.case_id,contentHash:index.seeds.find(r=>r.id===s.case_id).contentHash,capability:s.capability_id,risk:s.risk_level,kind:s.execution.kind,
      repetitions:repetitions ?? s.trial_protocol.modelTrials,turns:s.execution.tasks.length})),
    humanReview:'pending',humanLedgerHash:contentHash(ledger),engineeringEvidence:{report:pointer.report,hash:pointer.reportHash,seeds:calibration.engineering.length}};
  plan.plannedTrials=plan.cases.reduce((n,s)=>n+s.repetitions,0);
  if(planOnly) {console.log(JSON.stringify({...plan,credentialAvailable:!!process.env.DEEPSEEK_API_KEY},null,2));return plan;}
  assert.ok(process.env.DEEPSEEK_API_KEY,'Set DEEPSEEK_API_KEY in the local environment or .env');
  const parent=resolve(output ?? resolve(root,'.minicah/gold-baselines'));await mkdir(parent,{recursive:true,mode:0o700});
  const artifacts=await mkdtemp(resolve(parent,'baseline-'));await writeJSON(resolve(artifacts,'plan.json'),plan);
  await copyFile(self,resolve(artifacts,'driver.mjs'));
  const report={...plan,artifactDirectory:artifacts,status:'running',startedAt:new Date().toISOString(),finishedAt:null,releaseReady:false,
    usage:{requests:0,withUsage:0,missingUsage:0,observedTokens:{prompt:0,completion:0,total:0}},
    trials:plan.cases.flatMap(s=>Array.from({length:s.repetitions},(_,i)=>({taskId:s.caseId,repetition:i+1,classification:'not-started',passed:null,score:null,report:null}))),evidence:[]};
  const controller=new AbortController(), abort=()=>controller.abort();process.on('SIGINT',abort);
  const save=async()=>{report.aggregate=aggregateTrials(report.trials);await writeJSON(resolve(artifacts,'report.json'),report);await writeFile(resolve(artifacts,'report.md'),markdown(report),{mode:0o600});};
  await save();console.log(`Baseline artifacts: ${artifacts}`);
  const errors=[];
  const modelFactory=turn=>{
    const adapter=deepSeekModel(model,process.env.DEEPSEEK_API_KEY);
    return {...adapter,async complete(request,options={}) {
      report.usage.requests++;
      try {
        const result=await adapter.complete(request,{...options,signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal});
        if(result.usage) {report.usage.withUsage++;for(const k of ['prompt','completion','total'])report.usage.observedTokens[k]+=result.usage[k];}
        else report.usage.missingUsage++;
        return result;
      } catch(error) {report.usage.missingUsage++;errors.push({turn,code:stableError(error)});throw error;}
    }};
  };
  const runner=new EvaluationRunner();let runtime;
  const evidence=async path=>{report.evidence.push({path,hash:sha(await readFile(path))});};
  try {
    runtime=await Runtime.create({plugins:[createSandboxTestPackPlugin(await readJSON(resolve(directory,'agent.tests.json'))),createSandboxTestPlugin({backend:'native'})]});
    const session=await runtime.openSession();
    await session.run(async run=>{
      const singles=seeds.filter(s=>s.execution.kind==='coding');let executed=0;
      const result=await runner.run({schemaVersion:1,id:'gold-real-baseline',version:index.version,split:'capability',tasks:singles.map(s=>s.execution.tasks[0])},async request=>{
        console.log(`Single-turn ${++executed}: ${request.task.id}`);
        const outcome=await createCodingTrialExecutor({allowWrites:true,modelFactory:()=>modelFactory(0)})(request);
        if(outcome.status==='unknown' || outcome.failureKind==='infrastructure') setTimeout(abort,0);
        return outcome;
      },{outputDirectory:artifacts,signal:controller.signal,concurrency:1,...(repetitions===undefined?{}:{repetitions}),sandboxTests:run.services.get(sandboxTestService),
        reference:{model:model.model,configurationHash:contentHash(plan),executor:'coding-agent-v1'}});
      const path=resolve(result.artifactDirectory,'report.json');await evidence(path);
      for(const trial of result.trials) {
        const row=report.trials.find(t=>t.taskId===trial.taskId && t.repetition===trial.repetition);
        assert.ok(row);Object.assign(row,{classification:trial.classification,passed:trial.passed,score:trial.score,cleanup:trial.cleanup,status:trial.status,errorCode:trial.errorCode,
          failedGraders:trial.graders.filter(g=>g.status==='failed').map(g=>g.id),erroredGraders:trial.graders.filter(g=>g.status==='error').map(g=>g.id),report:path});
        for(const ref of trial.journalRefs)await evidence(resolve(result.artifactDirectory,ref));
      }
      if(result.status!=='completed')controller.abort();await save();
    });
    for(const seed of seeds.filter(s=>s.execution.kind==='conversation')) {
      for(const row of report.trials.filter(t=>t.taskId===seed.case_id)) {
        if(controller.signal.aborted)break;
        console.log(`Conversation ${seed.case_id}: ${row.repetition}/${plan.cases.find(s=>s.caseId===seed.case_id).repetitions}`);
        const path=resolve(artifacts,`${seed.case_id}-${row.repetition}`);await mkdir(path,{mode:0o700});
        let turn=0;const before=errors.length;
        try {
          const result=await executeConversation(seed,path,{modelFactory:()=>modelFactory(turn++)});
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
  const report=await runBaseline({planOnly:values.plan??false,...(values.repetitions===undefined?{}:{repetitions:Number(values.repetitions)}),output:values.output});
  if(!values.plan && report.status!=='completed')process.exitCode=1;
}
