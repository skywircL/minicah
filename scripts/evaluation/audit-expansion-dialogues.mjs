import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, sha, directory } from '../gold-expansion/common.mjs';

export async function auditDialogues(path) {
  const bytes=await readFile(path),report=JSON.parse(bytes),evidence=new Map(report.evidence.map(e=>[e.path,e.hash]));
  assert.equal(report.status,'completed');
  const rows=report.trials.filter(t=>report.cases.find(c=>c.caseId===t.taskId)?.kind==='conversation');
  const observations=[];
  for(const row of rows){
    const seed=await readJSON(resolve(directory,`cases/${row.taskId}.json`)),sourceBytes=await readFile(row.report);
    assert.equal(sha(sourceBytes),evidence.get(row.report));const source=JSON.parse(sourceBytes);
    const logBytes=await readFile(source.journal);assert.equal(sha(logBytes),evidence.get(source.journal));
    const events=logBytes.toString().trim().split('\n').flatMap(l=>{const x=JSON.parse(l);return x.events??[x];});
    for(const [i,turn] of source.turns.entries()){
      const request=events.find(e=>e.runId===turn.runId&&e.data.type==='model.requested');assert.ok(request);
      const messages=request.data.request.messages,users=messages.filter(m=>m.role==='user');
      assert.equal(users.at(-1)?.content,seed.execution.tasks[i].prompt,'Current user turn omitted from model input');
      const earlier=new Set(seed.execution.tasks.slice(0,i+1).map(t=>t.prompt));
      const novelFuture=seed.execution.tasks.slice(i+1).map(t=>t.prompt).filter(p=>!earlier.has(p));
      assert.ok(novelFuture.every(p=>!users.some(m=>m.content===p)),'Future user turn leaked into model input');
      const tools=request.data.request.tools?.map(t=>t.function.name)??[];
      assert.ok(tools.every(name=>name!=='run_command'&&seed.execution.tasks[i].executionPolicy.allowedTools.includes(name)));
      const afterCompaction=seed.execution.compaction&&i>seed.execution.compaction.afterStage;
      if(afterCompaction)assert.ok(users.some(m=>m.content.includes(seed.execution.compaction.text)));
      observations.push({caseId:row.taskId,repetition:row.repetition,turn:i+1,runId:turn.runId,journal:source.journal,requestSeq:request.seq,currentPromptVerified:true,novelFuturePromptsAbsent:true,toolAllowListVerified:true,fixedSummaryPresent:!!afterCompaction});
    }
  }
  const audit={schemaVersion:1,baselineReport:path,baselineHash:sha(bytes),driverHash:sha(await readFile(fileURLToPath(import.meta.url))),status:'passed',episodes:rows.length,turns:observations.length,observations};
  await writeJSON(resolve(dirname(path),'dialogue-input-audit.json'),audit);
  console.log(JSON.stringify({status:audit.status,episodes:audit.episodes,turns:audit.turns}));return audit;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){assert.ok(process.argv[2]);await auditDialogues(resolve(process.argv[2]));}
