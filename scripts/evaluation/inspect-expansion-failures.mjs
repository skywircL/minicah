import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha } from '../gold-expansion/common.mjs';

export async function inspectFailures(path) {
  const bytes=await readFile(path),report=JSON.parse(bytes),out=dirname(path),failures=[];
  const hashes=new Map(report.evidence.map(e=>[e.path,e.hash]));
  const verified=async p=>{const b=await readFile(p);assert.equal(sha(b),hashes.get(p));return b;};
  for(const trial of report.trials.filter(t=>t.passed===false)) {
    const source=JSON.parse(await verified(trial.report));
    const single=source.trials?.find(t=>t.taskId===trial.taskId && t.repetition===trial.repetition);
    const turns=single?[{turn:1,runId:single.runId,graders:single.graders,trace:single.toolTrace}]:source.turns;
    const journal=single?resolve(dirname(trial.report),single.journalRefs[0]):source.journal;
    const events=(await verified(journal)).toString().trim().split('\n').flatMap(line=>{const r=JSON.parse(line);return r.events??[r];});
    const selected=turns.filter(t=>t.graders.some(g=>g.status!=='passed'));
    failures.push({caseId:trial.taskId,repetition:trial.repetition,classification:trial.classification,sourceReport:trial.report,journal,
      turns:selected.map(t=>({turn:t.turn,runId:t.runId,failedGraders:t.graders.filter(g=>g.status!=='passed'),trace:t.trace,
        steps:events.filter(e=>e.runId===t.runId && ['model.completed','tool.planned','tool.completed','pipeline.rejected','permission.decided'].includes(e.data.type)).map(e=>({seq:e.seq,timestamp:e.timestamp,callId:e.callId,tool:e.tool?.id??null,type:e.data.type,
          ...(e.data.type==='model.completed'?{text:e.data.text,calls:e.data.response?.completion?.message?.tool_calls??[]}:{data:e.data})}))})),
      attribution:{status:'requires-evidence-review',causalClaim:null,regressionStatus:'candidate, not an automatically accepted regression'}});
  }
  for(const failure of failures)for(const turn of failure.turns) {
    const final=turn.steps.filter(e=>e.type==='model.completed').at(-1);
    let parsed=null,validJSON=true;try{parsed=JSON.parse(final?.text??'');}catch{validJSON=false;}
    const dispatchedWrites=['write_file','edit_file'].reduce((n,k)=>n+(turn.trace?.counts?.[k]?.dispatched??0),0);
    const failedOutcome=turn.failedGraders.some(g=>g.required && g.layer==='outcome' && g.status==='failed');
    const failedResponse=turn.failedGraders.some(g=>g.required && g.layer==='response' && g.status==='failed');
    turn.observations={dispatchedWrites,failedOutcome,failedResponse,validJSON,reportedCompleted:parsed?.status==='completed',
      outcomeFailedWithoutDispatchedWrite:failedOutcome && dispatchedWrites===0,
      completionClaimDespiteFailedOutcome:failedOutcome && parsed?.status==='completed',
      responseProblem:!failedResponse?null:validJSON?'json-content-or-schema-mismatch':'not-strict-json',
      finalEventSeq:final?.seq??null};
  }
  const turns=failures.flatMap(f=>f.turns);
  const observations={failingTrials:failures.length,failingTurns:turns.length,
    outcomeFailedWithoutDispatchedWrite:turns.filter(t=>t.observations.outcomeFailedWithoutDispatchedWrite).length,
    completionClaimDespiteFailedOutcome:turns.filter(t=>t.observations.completionClaimDespiteFailedOutcome).length,
    responseNotStrictJSON:turns.filter(t=>t.observations.responseProblem==='not-strict-json').length,
    responseJSONContentMismatch:turns.filter(t=>t.observations.responseProblem==='json-content-or-schema-mismatch').length,
    note:'Counts are overlapping per-turn observations, not causal attribution or a replacement for frozen grading.'};
  const result={schemaVersion:1,observations,baselineReport:path,baselineHash:sha(bytes),status:report.status,failures};
  await writeFile(resolve(out,'failure-evidence.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:report.status,failures:failures.length,cases:new Set(failures.map(f=>f.caseId)).size}));
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){assert.ok(process.argv[2]);await inspectFailures(resolve(process.argv[2]));}
