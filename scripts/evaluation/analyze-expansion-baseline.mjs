import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateTrials } from '../../dist/src/evaluation/index.js';
import { contentHash } from '../../dist/src/json.js';
import { checkManifest, fingerprint, readJSON, sha, directory, root } from '../gold-expansion/common.mjs';

import { repeatedStatistics, distribution, toolTiming } from './expansion-statistics.mjs';

export function groupedResults(cases,trials,key) {
  return [...new Set(cases.map(c=>c[key]))].map(value=>{
    const selected=cases.filter(c=>c[key]===value),ids=new Set(selected.map(c=>c.caseId));
    const rows=trials.filter(t=>ids.has(t.taskId)),a=aggregateTrials(rows);
    return {group:value,cases:selected.length,families:new Set(selected.map(c=>c.family)).size,planned:a.plannedTrials,eligible:a.eligibleTrials,passed:rows.filter(t=>t.passed===true).length,failed:rows.filter(t=>t.passed===false).length,excluded:a.excludedTrials,macroPassAt1:a.macroPassAt1};
  });
}

export async function analyze(path) {
  const bytes=await readFile(path),report=JSON.parse(bytes),out=dirname(path);
  assert.equal(report.status,'completed');assert.equal(report.datasetId,'gold-mutations-v2');
  assert.equal(report.plannedTrials,report.trials.length);assert.deepEqual(report.aggregate,aggregateTrials(report.trials));
  const evidence=new Set();
  for(const e of report.evidence){assert.equal(sha(await readFile(e.path)),e.hash);evidence.add(e.path);}
  assert.equal(sha(await readFile(resolve(out,'driver.mjs'))),report.driverHash);
  const parentPath=resolve(root,report.parentBaseline.report),parent=await readJSON(parentPath);
  assert.equal(sha(await readFile(parentPath)),report.parentBaseline.hash);assert.equal(parent.status,'completed');assert.deepEqual(parent.model,report.model);
  for(const e of parent.evidence)assert.equal(sha(await readFile(e.path)),e.hash);
  const cache=new Map(),get=async p=>{if(!cache.has(p))cache.set(p,await readJSON(p));return cache.get(p);};
  const events=async p=>(await readFile(p,'utf8')).trim().split('\n').flatMap(line=>{const r=JSON.parse(line);return r.events??[r];});
  const layers=Object.fromEntries(['outcome','behavior','response'].map(k=>[k,{passed:0,failed:0,unknown:0,notApplicable:0}]));
  const trials=[],dialogues=[],workspaces=new Set(),journals=new Set(),runIds=new Set();
  const safetyIds=new Set(['preserve','write-scope','no-command','stop-after-denial','no-injected-attempt']);
  const safety={checkedTrials:0,violatingTrials:0,unknownTrials:0,failures:[],scope:'Frozen workspace, write-scope, command, denied-write and injection-attempt invariants; not a comprehensive privacy or production safety audit'};
  for(const trial of report.trials) {
    const meta=report.cases.find(c=>c.caseId===trial.taskId);assert.ok(meta && trial.report && evidence.has(trial.report));
    const seed=await get(resolve(directory,`cases/${trial.taskId}.json`));assert.equal(contentHash(seed),meta.contentHash);
    const source=await get(trial.report),single=source.trials?.find(t=>t.taskId===trial.taskId && t.repetition===trial.repetition);
    const turns=single?[{turn:1,runId:single.runId,graders:single.graders}]:source.turns;
    assert.equal(turns.length,meta.turns);
    const journal=single?resolve(dirname(trial.report),single.journalRefs[0]):source.journal;assert.ok(evidence.has(journal));
    const log=await events(journal),graded=turns.flatMap(t=>t.graders);
    assert.equal(trial.initialStateVerified,true);assert.ok(!workspaces.has(trial.workspace));workspaces.add(trial.workspace);
    assert.ok(!journals.has(journal));journals.add(journal);
    for(const t of turns){assert.ok(!runIds.has(t.runId));runIds.add(t.runId);}
    const safe=turns.flatMap(t=>t.graders.filter(g=>safetyIds.has(g.id)).map(g=>({turn:t.turn,...g})));
    if(safe.length)safety.checkedTrials++;
    if(safe.some(g=>g.status==='failed'))safety.violatingTrials++;
    if(safe.some(g=>g.status==='error'))safety.unknownTrials++;
    safety.failures.push(...safe.filter(g=>g.status!=='passed').map(g=>({caseId:trial.taskId,repetition:trial.repetition,turn:g.turn,id:g.id,status:g.status,observedCount:g.observedCount??null,journal})));
    const calls=trial.modelCalls??[],modelMs=calls.reduce((n,c)=>n+c.durationMs,0),timing=toolTiming(log);
    const tokenValues=calls.map(c=>c.usage?.total??null),knownTokens=tokenValues.filter(Number.isFinite);
    const loggedRequests=log.filter(e=>e.data.type==='model.requested').length;
    const loggedUsage=log.filter(e=>e.data.type==='model.completed').map(e=>e.data.response?.completion?.usage).filter(Boolean);
    assert.equal(loggedRequests,calls.length,'Request count differs between wrapper and committed journal');
    assert.equal(loggedUsage.reduce((n,u)=>n+u.total,0),knownTokens.reduce((a,b)=>a+b,0),'Usage differs between wrapper and committed journal');
    const performance={wallMs:trial.durationMs,modelMs,toolMs:timing.unionMs,otherMs:Math.max(0,trial.durationMs-modelMs-timing.unionMs),timing,requests:calls.length,tokens:knownTokens.length===calls.length?knownTokens.reduce((a,b)=>a+b,0):null,observedTokens:knownTokens.reduce((a,b)=>a+b,0),missingUsage:calls.length-knownTokens.length,toolAttempts:turns.reduce((n,t)=>n+Object.values((single?.toolTrace??t.trace)?.counts??{}).reduce((m,c)=>m+c.attempted,0),0)};
    const layerResults={};
    for(const key of Object.keys(layers)) {
      const gs=graded.filter(g=>g.required && g.layer===key);
      const state=!gs.length?'notApplicable':gs.some(g=>g.status==='failed')?'failed':gs.some(g=>g.status==='error')?'unknown':'passed';
      layerResults[key]=state;layers[key][state]++;
    }
    const failures=turns.flatMap(t=>t.graders.filter(g=>g.status==='failed' || g.status==='error').map(g=>({turn:t.turn,id:g.id,kind:seed.execution.tasks[t.turn-1].graders.find(d=>d.id===g.id)?.kind,status:g.status,errorCode:g.errorCode,evidence:g.evidence})));
    trials.push({taskId:trial.taskId,repetition:trial.repetition,operator:meta.operator,family:meta.family,parentId:meta.parentId,passed:trial.passed,classification:trial.classification,performance,layers:layerResults,failures,finalReplies:failures.length?turns.map(t=>({turn:t.turn,text:log.filter(e=>e.runId===t.runId && e.data.type==='model.completed').at(-1)?.data.text??''})):[],sourceReport:trial.report,journal});
    if(!single) {
      assert.equal(new Set(turns.map(t=>t.runId)).size,meta.turns);
      assert.equal(new Set(log.map(e=>e.sessionId).filter(Boolean)).size,1);
      assert.equal(source.cleanup,'verified');if(seed.execution.compaction)assert.equal(source.compactionObserved,true);
      dialogues.push({caseId:trial.taskId,repetition:trial.repetition,passed:trial.passed,turns:meta.turns,oneSession:true,cleanup:source.cleanup,compactionObserved:source.compactionObserved});
    }
  }
  const operators=groupedResults(report.cases,report.trials,'operator'),families=groupedResults(report.cases,report.trials,'family');
  for(const f of families)f.parentResult=parent.aggregate.cases.find(c=>c.taskId===f.group);
  assert.ok(families.every(f=>f.parentResult));
  const eligibleFamilies=families.filter(f=>f.macroPassAt1!==null);
  const dialogueMetadata=report.cases.filter(c=>c.kind==='conversation').map(c=>({...c,historyMode:dialogues.find(d=>d.caseId===c.caseId)?.compactionObserved?'fixed-compaction':'full-history'}));
  const dialogueHistory={scope:'exploratory diagnostic slice of frozen scenario types; not randomized causal evidence',groups:groupedResults(dialogueMetadata,report.trials,'historyMode')};
  const repeated=repeatedStatistics(report.cases,report.trials);
  const manifest=(await checkManifest()).manifest,index=await readJSON(resolve(directory,'index.json'));
  const retainedIds=new Set(index.cases.filter(c=>c.origin==='retained-v1').map(c=>c.id));
  const priorPath=resolve(root,manifest.prior.baseline),priorBytes=await readFile(priorPath),prior=JSON.parse(priorBytes);
  assert.equal(sha(priorBytes),manifest.prior.baselineHash);assert.equal(prior.status,'completed');assert.deepEqual(prior.model,report.model);
  for(const id of retainedIds)assert.equal(prior.cases.find(c=>c.caseId===id)?.contentHash,report.cases.find(c=>c.caseId===id)?.contentHash);
  const retainedVsHistorical={cases:retainedIds.size,historicalReport:priorPath,historicalHash:sha(priorBytes),historical:prior.aggregate,current:aggregateTrials(report.trials.filter(t=>retainedIds.has(t.taskId))),limitation:'Same retained case hashes and configured model; separate time-ordered runs, not a randomized paired A/B comparison.'};
  const performance=Object.fromEntries([['all',trials],['successfulAndBehaviorPassing',trials.filter(t=>t.passed===true && t.layers.behavior==='passed')]].map(([name,rows])=>[name,Object.fromEntries(['wallMs','modelMs','toolMs','otherMs','requests','tokens','toolAttempts'].map(k=>[k,distribution(rows.map(t=>t.performance[k]))]))]));
  assert.equal(trials.reduce((n,t)=>n+t.performance.requests,0),report.usage.requests);
  assert.equal(trials.reduce((n,t)=>n+t.performance.observedTokens,0),report.usage.observedTokens.total);
  const analysis={schemaVersion:1,dialogueHistory,retainedVsHistorical,repeated,performance,safety,isolation:{workspaces:workspaces.size,journals:journals.size,runIds:runIds.size,initialStatesVerified:trials.length},baselineReport:path,baselineHash:sha(bytes),analysisDriverHash:sha(await readFile(fileURLToPath(import.meta.url))),statisticsDriverHash:sha(await readFile(new URL('./expansion-statistics.mjs',import.meta.url))),model:report.model,datasetVersion:report.datasetVersion,parentBaseline:{path:parentPath,hash:report.parentBaseline.hash,macroPassAt1:parent.aggregate.macroPassAt1},evidenceFilesVerified:report.evidence.length,parentEvidenceFilesVerified:parent.evidence.length,fingerprintCurrent:(await checkManifest()).hash===report.manifestHash && (await fingerprint()).hash===report.runtimeHash,planned:report.plannedTrials,eligible:report.aggregate.eligibleTrials,passed:report.trials.filter(t=>t.passed===true).length,failed:report.trials.filter(t=>t.passed===false).length,excluded:report.aggregate.excludedTrials,caseMacroPassAt1:report.aggregate.macroPassAt1,familyMacroPassAt1:eligibleFamilies.length?eligibleFamilies.reduce((n,f)=>n+f.macroPassAt1,0)/eligibleFamilies.length:null,layers,operators,families,dialogues,durationSeconds:(Date.parse(report.finishedAt)-Date.parse(report.startedAt))/1000,usage:report.usage,trials};
  const pct=x=>x===null?'未知':(100*x).toFixed(1)+'%';
  const examples=[...new Set(trials.filter(t=>t.failures.length).map(t=>t.taskId))].map(id=>trials.find(t=>t.taskId===id && t.failures.length));
  const md=['# 150 条变体真实模型验证',
    `${report.model.model}，${report.cases.length} 条变体 / ${families.length} 个父家族，${analysis.planned} 次协议试验：**${analysis.passed} 通过、${analysis.failed} 失败、${analysis.excluded} 排除**。按变体宏平均 pass@1：${pct(analysis.caseMacroPassAt1)}；先在家族内平均、再按家族平均：${pct(analysis.familyMacroPassAt1)}。`,
    ['| 变异类型 | 变体数 | 通过 / 可计分 | 失败 | 排除 | 变体宏平均 pass@1 |','| --- | ---: | ---: | ---: | ---: | ---: |',...operators.map(g=>`| ${g.group} | ${g.cases} | ${g.passed}/${g.eligible} | ${g.failed} | ${g.excluded} | ${pct(g.macroPassAt1)} |`)].join('\n'),
    ['| 判分层 | 通过 | 失败 | 证据不足 |','| --- | ---: | ---: | ---: |',...Object.entries(layers).map(([k,v])=>`| ${k} | ${v.passed} | ${v.failed} | ${v.unknown} |`)].join('\n'),
    '## 与父题按家族关联',
    ['| 父家族 | 历史父题通过/可计分 | 本批变体数 | 变体通过/可计分 | 变体宏平均 pass@1 |','| --- | ---: | ---: | ---: | ---: |',...families.map(f=>`| ${f.group} | ${f.parentResult.passedTrials}/${f.parentResult.eligibleTrials} | ${f.cases} | ${f.passed}/${f.eligible} | ${pct(f.macroPassAt1)} |`)].join('\n'),
    `原 20 条保留变体本轮重新运行：${retainedVsHistorical.current.classifications.success}/${retainedVsHistorical.current.eligibleTrials} 通过；历史 v1：${prior.aggregate.classifications.success}/${prior.aggregate.eligibleTrials}。案例 hash 和模型配置匹配，但运行时间不同，不据此作随机 A/B 或因果结论。`,
    '父题是 v2.3.2 已完成的历史基线，本批没有重新请求父题。任务输入、风险或审批条件发生变化，重复次数也可能不同；这里是按来源关联的诊断比较，不能解释为同题随机 A/B 或独立样本显著性证明。',
    ['| 对话历史场景（探索性切片） | 题数 | 通过/可计分 | 失败 |','| --- | ---: | ---: | ---: |',...dialogueHistory.groups.map(g=>`| ${g.group} | ${g.cases} | ${g.passed}/${g.eligible} | ${g.failed} |`)].join('\n'),
    '上述历史场景切片用于诊断固定压缩后的续接表现；场景构成和运行顺序不同，不能直接当作压缩影响的随机因果估计。',
    `## 重复运行与不确定性\n\n共同 k=3 的组合估计 pass^3：${pct(repeated.macroPassPower3)}。逐题 95% Wilson 区间见机器报告（条件 IID 假设）；家族整体重采样的 95% 区间：变体宏平均 ${repeated.bootstrap?.caseMacro.map(pct).join('–')}，家族宏平均 ${repeated.bootstrap?.familyMacro.map(pct).join('–')}。10 个家族系有意选取，区间仅用于描述敏感性，不是线上泛化保证。`,
    ['| 重复次数 | 题数 | 完整题数 | 全部通过 | 至少一次通过 |','| --- | ---: | ---: | ---: | ---: |',...repeated.stability.map(s=>`| ${s.k} | ${s.cases} | ${s.complete} | ${s.allPassed} | ${s.atLeastOne} |`)].join('\n'),
    `## 安全门禁与效率\n\n按已冻结安全相关判据，${safety.checkedTrials} 次被检查，${safety.violatingTrials} 次违规，${safety.unknownTrials} 次证据不足。不能把有限判据下的零违规解释为完整隐私/安全认证。延迟和 token 分别报告全部试验与成功且行为判据通过的试验；otherMs 包含 harness、启动、判分及本地基础设施，当前不能进一步精确拆分。工具均为本地工具，无付费外部工具调用；本地计算成本和模型账单未获取。`,
    ['| 样本 | 指标 | P50 | P95 |','| --- | --- | ---: | ---: |',...Object.entries(performance).flatMap(([group,metrics])=>Object.entries(metrics).map(([metric,d])=>`| ${group} | ${metric} | ${d.p50?.toFixed(2)??'未知'} | ${d.p95?.toFixed(2)??'未知'} |`))].join('\n'),
    ...examples.map(t=>`## ${t.taskId} / 第 ${t.repetition} 次失败样例\n\n${t.failures.map(g=>`第 ${g.turn} 轮 ${g.id}: ${g.status}${g.errorCode?' / '+g.errorCode:''}`).join('；')}\n\n~~~~json\n${JSON.stringify(t.finalReplies,null,2)}\n~~~~\n\n[原始报告](${t.sourceReport})`),
    `## 证据与边界\n\n已验证本批 ${analysis.evidenceFilesVerified} 个证据引用、父基线 ${analysis.parentEvidenceFilesVerified} 个证据引用和保留驱动 hash；当前数据/运行时匹配：${analysis.fingerprintCurrent}。${dialogues.length} 次对话均核验约定的三或四轮、同一 Session 及清理确认，${dialogues.filter(d=>d.compactionObserved).length} 次使用约定固定压缩。`,
    `模型请求 ${report.usage.requests} 次，取得用量 ${report.usage.withUsage} 次，缺失用量 ${report.usage.missingUsage} 次；已观察 token 合计 ${report.usage.observedTokens.total}。费用以实际账单为准。`,
    '当前是公开 gold_dev 变体的开发验证，不增加独立问题家族，不代表未见留出集成绩。GT、判据及旧基线保持冻结；正式计分不剥离回复正文。人工评审台账状态单独保留，不从模型通过率推定验收。',
    `[逐条原始汇总](${resolve(out,'report.md')}) · [完整机器分析](${resolve(out,'analysis.json')})`, ''].join('\n\n');
  await writeFile(resolve(out,'analysis.json'),JSON.stringify(analysis,null,2)+'\n',{mode:0o600});
  await writeFile(resolve(out,'analysis.md'),md,{mode:0o600});await copyFile(fileURLToPath(import.meta.url),resolve(out,'analysis-driver.mjs'));
  await copyFile(new URL('./expansion-statistics.mjs',import.meta.url),resolve(out,'statistics-driver.mjs'));
  console.log(JSON.stringify({planned:analysis.planned,eligible:analysis.eligible,passed:analysis.passed,failed:analysis.failed,excluded:analysis.excluded,caseMacroPassAt1:analysis.caseMacroPassAt1,familyMacroPassAt1:analysis.familyMacroPassAt1,safety,stability:repeated.stability,usage:analysis.usage},null,2));return analysis;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){assert.ok(process.argv[2],'Supply completed mutation report.json');await analyze(resolve(process.argv[2]));}
