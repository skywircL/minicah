import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../../dist/src/json.js';
import { checkManifest, fingerprint, readJSON, sha, directory } from '../gold-seeds/common.mjs';

// Locate complete embedded objects for diagnostics, even when a prose summary
// contains unrelated JSON before the final object. This never changes grading.
export function containsExpectedJson(text, expected) {
  for (let start = text.indexOf('{'), candidates = 0; start >= 0 && candidates++ < 64; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < text.length; end++) {
      const c = text[end];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { if (contentHash(JSON.parse(text.slice(start, end + 1))) === contentHash(expected)) return true; } catch {}
        break;
      }
    }
  }
  return false;
}

export async function loadBaselineSeed(report, taskId, baseDirectory=directory) {
  assert.match(taskId,/^[A-Za-z0-9-]+$/);
  assert.match(report.datasetVersion,/^\d+\.\d+\.\d+$/);
  const expected=report.cases.find(s=>s.caseId===taskId)?.contentHash;
  assert.ok(expected,'Baseline must bind each seed hash');
  for(const base of [baseDirectory,resolve(baseDirectory,`archive/v${report.datasetVersion}`)]) {
    let seed;
    try {seed=await readJSON(resolve(base,`cases/${taskId}.json`));}
    catch(error) {if(error.code==='ENOENT') continue;throw error;}
    if(contentHash(seed)===expected) return seed;
  }
  assert.fail(`No current or archived seed matches the baseline hash: ${taskId}`);
}

export async function analyze(path) {
  const bytes=await readFile(path),report=JSON.parse(bytes),out=dirname(path);
  assert.equal(report.status,'completed','Analyze a completed baseline');
  assert.equal(report.trials.length,report.plannedTrials);
  for(const e of report.evidence) assert.equal(sha(await readFile(e.path)),e.hash,`Changed execution evidence: ${e.path}`);
  assert.equal(sha(await readFile(resolve(out,'driver.mjs'))),report.driverHash,'Retained driver differs');
  const cache=new Map(),get=async p=>{if(!cache.has(p))cache.set(p,await readJSON(p));return cache.get(p);};
  const journals=new Map();
  const events=async p=>{if(!journals.has(p))journals.set(p,(await readFile(p,'utf8')).trim().split('\n').flatMap(line=>{const x=JSON.parse(line);return x.events??[x];}));return journals.get(p);};
  const layers=Object.fromEntries(['outcome','behavior','response'].map(l=>[l,{passed:0,failed:0,unknown:0,notApplicable:0}]));
  const trials=[],seeds=new Map();
  for(const trial of report.trials) {
    assert.ok(trial.report,'Missing executed trial report');
    const source=await get(trial.report);
    if(!seeds.has(trial.taskId)) seeds.set(trial.taskId,await loadBaselineSeed(report,trial.taskId));
    const seed=seeds.get(trial.taskId);
    const single=source.trials?.find(t=>t.taskId===trial.taskId && t.repetition===trial.repetition);
    const turns=single?[{turn:1,runId:single.runId,graders:single.graders}]:source.turns;
    assert.ok(turns?.length);const graders=turns.flatMap(t=>t.graders);
    const layerResults={};
    for(const layer of Object.keys(layers)) {
      const selected=graders.filter(g=>g.required && g.layer===layer);
      const status=!selected.length?'notApplicable':selected.some(g=>g.status==='failed')?'failed':selected.some(g=>g.status==='error')?'unknown':'passed';
      layerResults[layer]=status;layers[layer][status]++;
    }
    const journal=single?resolve(dirname(trial.report),single.journalRefs[0]):source.journal;
    const log=await events(journal),responseFailures=[];
    for(const turn of turns) for(const grader of turn.graders.filter(g=>g.id==='response' && g.status==='failed')) {
      const text=log.filter(e=>e.runId===turn.runId && e.data.type==='model.completed').at(-1)?.data.text??'';
      const expected=seed.execution.tasks[turn.turn-1].graders.find(g=>g.id==='response').expected;
      const embeddedExpectedJson=containsExpectedJson(text,expected);
      responseFailures.push({turn:turn.turn,errorCode:grader.errorCode,embeddedExpectedJson,unquotedStatusKey:/\{\s*status\s*:/.test(text),finalText:text});
    }
    trials.push({id:trial.taskId,repetition:trial.repetition,passed:trial.passed,classification:trial.classification,layers:layerResults,responseFailures,sourceReport:trial.report,journal});
  }
  const responses=trials.flatMap(t=>t.responseFailures);
  const analysis={schemaVersion:1,baselineReport:path,baselineHash:sha(bytes),analysisDriverHash:sha(await readFile(fileURLToPath(import.meta.url))),evidenceFilesVerified:report.evidence.length,
    fingerprintCurrent:(await checkManifest()).hash===report.manifestHash && (await fingerprint()).hash===report.runtimeHash,
    model:report.model.model,datasetVersion:report.datasetVersion,planned:report.plannedTrials,eligible:report.aggregate.eligibleTrials,
    passed:report.trials.filter(t=>t.passed===true).length,failed:report.trials.filter(t=>t.passed===false).length,excluded:report.aggregate.excludedTrials,
    macroPassAt1:report.aggregate.macroPassAt1,layers,responseFailureTurns:responses.length,
    invalidJsonTurns:responses.filter(t=>t.errorCode==='INVALID_JSON').length,
    expectedJsonEmbeddedTurns:responses.filter(t=>t.embeddedExpectedJson).length,
    unquotedStatusKeyTurns:responses.filter(t=>!t.embeddedExpectedJson && t.unquotedStatusKey).length,
    onlyResponseFailedTrials:trials.filter(t=>t.passed===false && t.layers.outcome==='passed' && t.layers.behavior==='passed' && t.layers.response==='failed').length,
    durationSeconds:(Date.parse(report.finishedAt)-Date.parse(report.startedAt))/1000,usage:report.usage,trials};
  await writeFile(resolve(out,'analysis.json'),JSON.stringify(analysis,null,2)+'\n',{mode:0o600});
  const examples=trials.filter(t=>t.responseFailures.length).slice(0,3);
  const text=['# 真实模型基线分析',
    `模型：${analysis.model}；数据：${analysis.datasetVersion}；${analysis.planned} 次协议试验的正式结果：**${analysis.passed} 通过、${analysis.failed} 失败、${analysis.excluded} 排除**。按种子宏平均 pass@1 为 **${(100*analysis.macroPassAt1).toFixed(1)}%**；按试验计通过率为 ${(100*analysis.passed/analysis.eligible).toFixed(1)}%。`,
    ['| 判分层 | 通过的试验 | 失败的试验 | 证据不足 |','| --- | ---: | ---: | ---: |',...Object.entries(layers).map(([k,v])=>`| ${k} | ${v.passed} | ${v.failed} | ${v.unknown} |`)].join('\n'),
    `${analysis.onlyResponseFailedTrials} 次试验仅回复判据失败。逐轮发现 ${analysis.invalidJsonTurns} 次 INVALID_JSON；其中 ${analysis.expectedJsonEmbeddedTurns} 次的回复包含与期望一致的 JSON 对象，但前后有说明或代码围栏，整段无法直接解析为 JSON。另有 ${analysis.unquotedStatusKeyTurns} 次出现 status 键未加双引号的写法。此项仅用于归因，不修改冻结分数。`,
    ...(report.datasetVersion==='2.3.1'?[
      '本轮 v2.3.1 使用的系统提示要求“Finish with a concise summary in the user\'s language.”，题面要求最终只返回 JSON。两者存在表达上的张力，可能促使模型补写说明；这是待对照验证的原因，不能仅凭本次观察认定为唯一原因。',
      'v2.3.1 部分题面把 `{status:"completed"}` 称作 JSON 示例，其键未加双引号。真实回复中出现了同样写法。v2.3.2 已统一系统提示及题面示例，业务期望和判分标准保持不变；改善程度仍须通过新一轮真实模型对照验证。',
    ]:[]),
    '诊断提取仅用于归因；正式判分仍检查完整回复，不剥离正文或放宽原标准。',
    ...examples.map(t=>`## ${t.id} / 第 ${t.repetition} 次\n\n失败回复（第 ${t.responseFailures[0].turn} 轮）：\n\n~~~~text\n${t.responseFailures[0].finalText}\n~~~~\n\n[原始执行报告](${t.sourceReport})`),
    `已核验 ${analysis.evidenceFilesVerified} 个报告/日志证据文件；当前数据及运行时指纹匹配：${analysis.fingerprintCurrent}。模型请求 ${report.usage.requests} 次，全部已观察 token 合计 ${report.usage.observedTokens.total}；缺失用量 ${report.usage.missingUsage} 次，费用以实际账单为准。`,
    `这是 gold_dev 开发基线；机器读取的逐条人审台账状态为 ${report.humanReview}，不代替会话中的用户验收确认。A5-02 的固定压缩接续结果不代表自动摘要质量；H/P 工程检查未混入模型通过率。`,
    `[完整基线汇总](${resolve(out,'report.md')}) · [机器可读分析](${resolve(out,'analysis.json')})`,''].join('\n\n');
  await writeFile(resolve(out,'analysis.md'),text,{mode:0o600});
  console.log(JSON.stringify({analysis:resolve(out,'analysis.md'),...Object.fromEntries(Object.entries(analysis).filter(([k])=>!['trials','usage'].includes(k)))}));
  return analysis;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2],'Supply baseline report.json');await analyze(resolve(process.argv[2]));
}
