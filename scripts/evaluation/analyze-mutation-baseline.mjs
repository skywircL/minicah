import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateTrials } from '../../dist/src/evaluation/index.js';
import { contentHash } from '../../dist/src/json.js';
import { checkManifest, fingerprint, readJSON, sha, directory, root } from '../gold-mutations/common.mjs';

export function groupedResults(cases,trials,key) {
  return [...new Set(cases.map(c=>c[key]))].map(value=>{
    const selected=cases.filter(c=>c[key]===value),ids=new Set(selected.map(c=>c.caseId));
    const rows=trials.filter(t=>ids.has(t.taskId)),a=aggregateTrials(rows);
    return {group:value,cases:selected.length,families:new Set(selected.map(c=>c.family)).size,planned:a.plannedTrials,eligible:a.eligibleTrials,passed:rows.filter(t=>t.passed===true).length,failed:rows.filter(t=>t.passed===false).length,excluded:a.excludedTrials,macroPassAt1:a.macroPassAt1};
  });
}

export async function analyze(path) {
  const bytes=await readFile(path),report=JSON.parse(bytes),out=dirname(path);
  assert.equal(report.status,'completed');assert.equal(report.datasetId,'gold-mutations-v1');
  assert.equal(report.plannedTrials,report.trials.length);assert.deepEqual(report.aggregate,aggregateTrials(report.trials));
  const evidence=new Set();
  for(const e of report.evidence){assert.equal(sha(await readFile(e.path)),e.hash);evidence.add(e.path);}
  assert.equal(sha(await readFile(resolve(out,'driver.mjs'))),report.driverHash);
  const parentPath=resolve(root,report.parentBaseline.report),parent=await readJSON(parentPath);
  assert.equal(sha(await readFile(parentPath)),report.parentBaseline.hash);assert.equal(parent.status,'completed');assert.deepEqual(parent.model,report.model);
  for(const e of parent.evidence)assert.equal(sha(await readFile(e.path)),e.hash);
  const cache=new Map(),get=async p=>{if(!cache.has(p))cache.set(p,await readJSON(p));return cache.get(p);};
  const logs=new Map(),events=async p=>{if(!logs.has(p))logs.set(p,(await readFile(p,'utf8')).trim().split('\n').flatMap(line=>{const r=JSON.parse(line);return r.events??[r];}));return logs.get(p);};
  const layers=Object.fromEntries(['outcome','behavior','response'].map(k=>[k,{passed:0,failed:0,unknown:0,notApplicable:0}]));
  const trials=[],dialogues=[];
  for(const trial of report.trials) {
    const meta=report.cases.find(c=>c.caseId===trial.taskId);assert.ok(meta && trial.report && evidence.has(trial.report));
    const seed=await get(resolve(directory,`cases/${trial.taskId}.json`));assert.equal(contentHash(seed),meta.contentHash);
    const source=await get(trial.report),single=source.trials?.find(t=>t.taskId===trial.taskId && t.repetition===trial.repetition);
    const turns=single?[{turn:1,runId:single.runId,graders:single.graders}]:source.turns;
    assert.equal(turns.length,meta.turns);
    const journal=single?resolve(dirname(trial.report),single.journalRefs[0]):source.journal;assert.ok(evidence.has(journal));
    const log=await events(journal),graded=turns.flatMap(t=>t.graders);
    const layerResults={};
    for(const key of Object.keys(layers)) {
      const gs=graded.filter(g=>g.required && g.layer===key);
      const state=!gs.length?'notApplicable':gs.some(g=>g.status==='failed')?'failed':gs.some(g=>g.status==='error')?'unknown':'passed';
      layerResults[key]=state;layers[key][state]++;
    }
    const failures=turns.flatMap(t=>t.graders.filter(g=>g.status==='failed' || g.status==='error').map(g=>({turn:t.turn,id:g.id,kind:g.kind,status:g.status,errorCode:g.errorCode,evidence:g.evidence})));
    trials.push({taskId:trial.taskId,repetition:trial.repetition,operator:meta.operator,family:meta.family,parentId:meta.parentId,passed:trial.passed,classification:trial.classification,layers:layerResults,failures,finalReplies:failures.length?turns.map(t=>({turn:t.turn,text:log.filter(e=>e.runId===t.runId && e.data.type==='model.completed').at(-1)?.data.text??''})):[],sourceReport:trial.report,journal});
    if(!single) {
      assert.equal(new Set(turns.map(t=>t.runId)).size,meta.turns);
      assert.equal(new Set(log.map(e=>e.sessionId).filter(Boolean)).size,1);
      assert.equal(source.cleanup,'verified');if(seed.execution.compaction)assert.equal(source.compactionObserved,true);
      dialogues.push({caseId:trial.taskId,repetition:trial.repetition,turns:meta.turns,oneSession:true,cleanup:source.cleanup,compactionObserved:source.compactionObserved});
    }
  }
  const operators=groupedResults(report.cases,report.trials,'operator'),families=groupedResults(report.cases,report.trials,'family');
  for(const f of families)f.parentResult=parent.aggregate.cases.find(c=>c.taskId===f.group);
  assert.ok(families.every(f=>f.parentResult));
  const eligibleFamilies=families.filter(f=>f.macroPassAt1!==null);
  const analysis={schemaVersion:1,baselineReport:path,baselineHash:sha(bytes),analysisDriverHash:sha(await readFile(fileURLToPath(import.meta.url))),model:report.model,datasetVersion:report.datasetVersion,parentBaseline:{path:parentPath,hash:report.parentBaseline.hash,macroPassAt1:parent.aggregate.macroPassAt1},evidenceFilesVerified:report.evidence.length,parentEvidenceFilesVerified:parent.evidence.length,fingerprintCurrent:(await checkManifest()).hash===report.manifestHash && (await fingerprint()).hash===report.runtimeHash,planned:report.plannedTrials,eligible:report.aggregate.eligibleTrials,passed:report.trials.filter(t=>t.passed===true).length,failed:report.trials.filter(t=>t.passed===false).length,excluded:report.aggregate.excludedTrials,caseMacroPassAt1:report.aggregate.macroPassAt1,familyMacroPassAt1:eligibleFamilies.length?eligibleFamilies.reduce((n,f)=>n+f.macroPassAt1,0)/eligibleFamilies.length:null,layers,operators,families,dialogues,durationSeconds:(Date.parse(report.finishedAt)-Date.parse(report.startedAt))/1000,usage:report.usage,trials};
  const pct=x=>x===null?'未知':(100*x).toFixed(1)+'%';
  const examples=[...new Set(trials.filter(t=>t.failures.length).map(t=>t.taskId))].map(id=>trials.find(t=>t.taskId===id && t.failures.length));
  const md=['# 首批变体真实模型验证',
    `${report.model.model}，20 条变体 / 10 个父家族，${analysis.planned} 次协议试验：**${analysis.passed} 通过、${analysis.failed} 失败、${analysis.excluded} 排除**。按变体宏平均 pass@1：${pct(analysis.caseMacroPassAt1)}；先在家族内平均、再按家族平均：${pct(analysis.familyMacroPassAt1)}。`,
    ['| 变异类型 | 变体数 | 通过 / 可计分 | 失败 | 排除 | 变体宏平均 pass@1 |','| --- | ---: | ---: | ---: | ---: | ---: |',...operators.map(g=>`| ${g.group} | ${g.cases} | ${g.passed}/${g.eligible} | ${g.failed} | ${g.excluded} | ${pct(g.macroPassAt1)} |`)].join('\n'),
    ['| 判分层 | 通过 | 失败 | 证据不足 |','| --- | ---: | ---: | ---: |',...Object.entries(layers).map(([k,v])=>`| ${k} | ${v.passed} | ${v.failed} | ${v.unknown} |`)].join('\n'),
    '## 与父题按家族关联',
    ['| 父家族 | 历史父题通过/可计分 | 本批变体数 | 变体通过/可计分 | 变体宏平均 pass@1 |','| --- | ---: | ---: | ---: | ---: |',...families.map(f=>`| ${f.group} | ${f.parentResult.passedTrials}/${f.parentResult.eligibleTrials} | ${f.cases} | ${f.passed}/${f.eligible} | ${pct(f.macroPassAt1)} |`)].join('\n'),
    '父题是 v2.3.2 已完成的历史基线，本批没有重新请求父题。任务输入、风险或审批条件发生变化，重复次数也可能不同；这里是按来源关联的诊断比较，不能解释为同题随机 A/B 或独立样本显著性证明。',
    ...examples.map(t=>`## ${t.taskId} / 第 ${t.repetition} 次失败样例\n\n${t.failures.map(g=>`第 ${g.turn} 轮 ${g.id}: ${g.status}${g.errorCode?' / '+g.errorCode:''}`).join('；')}\n\n~~~~json\n${JSON.stringify(t.finalReplies,null,2)}\n~~~~\n\n[原始报告](${t.sourceReport})`),
    `## 证据与边界\n\n已验证本批 ${analysis.evidenceFilesVerified} 个证据引用、父基线 ${analysis.parentEvidenceFilesVerified} 个证据引用和保留驱动 hash；当前数据/运行时匹配：${analysis.fingerprintCurrent}。${dialogues.length} 次对话均核验三轮、同一 Session 及清理确认，${dialogues.filter(d=>d.compactionObserved).length} 次使用约定固定压缩。`,
    `模型请求 ${report.usage.requests} 次，取得用量 ${report.usage.withUsage} 次，缺失用量 ${report.usage.missingUsage} 次；已观察 token 合计 ${report.usage.observedTokens.total}。费用以实际账单为准。`,
    '当前是公开 gold_dev 变体的开发验证，不增加独立问题家族，不代表未见留出集成绩。GT、判据及旧基线保持冻结；正式计分不剥离回复正文。人工评审台账状态单独保留，不从模型通过率推定验收。',
    `[逐条原始汇总](${resolve(out,'report.md')}) · [完整机器分析](${resolve(out,'analysis.json')})`, ''].join('\n\n');
  await writeFile(resolve(out,'analysis.json'),JSON.stringify(analysis,null,2)+'\n',{mode:0o600});
  await writeFile(resolve(out,'analysis.md'),md,{mode:0o600});await copyFile(fileURLToPath(import.meta.url),resolve(out,'analysis-driver.mjs'));
  console.log(JSON.stringify({...analysis,trials:undefined,model:report.model.model},null,2));return analysis;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){assert.ok(process.argv[2],'Supply completed mutation report.json');await analyze(resolve(process.argv[2]));}
