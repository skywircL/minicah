import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { contentHash } from '../../dist/src/json.js';
import { readJSON } from './common.mjs';

export function verifyInitialReads(events,task,runId) {
  const seen=new Set();let matched=0;
  for(const e of events.filter(e=>e.runId===runId))if(e.data.type==='tool.completed'&&e.tool?.id==='read_file'){
    const v=e.data.result?.value;if(!v?.path||seen.has(v.path))continue;seen.add(v.path);
    if(Object.hasOwn(task.files,v.path)){assert.equal(v.hash,contentHash(task.files[v.path]),`Initial fixture mismatch: ${task.id}/${v.path}`);matched++;}
  }
  assert.ok(matched>0,`No initial read evidence for ${task.id}`);return matched;
}
export async function verifyResetReports(cases,report) {
  const sources=new Map(),workspaces=new Set(),journals=new Set(),runs=new Set();let reads=0,turns=0,compactions=0;
  for(const row of report.trials){
    if(!sources.has(row.report))sources.set(row.report,await readJSON(row.report));const source=sources.get(row.report);
    const c=cases.find(c=>c.case_id===row.caseId),single=c.execution.kind==='coding';
    const trial=single?source.trials.find(t=>t.taskId===c.case_id):null;
    const journal=single?resolve(dirname(row.report),trial.journalRefs[0]):source.journal;
    assert.ok(!journals.has(journal),'A trial reused another trial journal');journals.add(journal);
    const events=(await readFile(journal,'utf8')).trim().split('\n').flatMap(line=>{const r=JSON.parse(line);return r.events??[r];});
    const workspace=events.find(e=>e.data.type==='run.started'&&e.data.config?.['coding-tools']?.workspace)?.data.config['coding-tools'].workspace;
    assert.ok(workspace);assert.ok(!workspaces.has(workspace),'A trial reused another trial workspace');workspaces.add(workspace);
    assert.equal(new Set(events.map(e=>e.sessionId).filter(Boolean)).size,1,'A conversation changed session');
    const trialTurns=single?[{runId:trial.runId}]:source.turns;
    assert.equal(trialTurns.length,c.execution.tasks.length);
    for(const [i,t] of trialTurns.entries()){
      assert.ok(!runs.has(t.runId),'Run ID reused');runs.add(t.runId);turns++;
      reads+=verifyInitialReads(events,c.execution.tasks[i],t.runId);
    }
    if(c.execution.compaction){assert.equal(source.compactionObserved,true);compactions++;}
  }
  return {trials:report.trials.length,distinctWorkspaces:workspaces.size,distinctJournals:journals.size,distinctTaskRuns:runs.size,turns,initialReadHashesMatched:reads,compactedTrials:compactions,cleanupVerified:report.trials.every(t=>t.cleanup==='verified')};
}
