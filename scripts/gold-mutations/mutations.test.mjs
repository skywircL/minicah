import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { contentHash } from '../../dist/src/json.js';
import { materialize } from './build.mjs';
import { derive } from './derive.mjs';
import { validateCases } from './audit.mjs';
import { verifyTrial } from './calibrate.mjs';
import { directory,readJSON } from './common.mjs';
import { referenceModel } from '../gold-seeds/reference.mjs';
import { executeConversation } from '../gold-seeds/conversation.mjs';

const {cases,parents,spec,parentPack,boundaryPack}=await materialize();
test('first batch has declared operators, retained families and two independent counterexamples each',()=>{
  assert.equal(cases.length,20);assert.equal(new Set(cases.map(c=>c.family_id)).size,10);
  assert.deepEqual(['boundary','permission','adversarial','dialogue'].map(k=>cases.filter(c=>c.mutation_type===k).length),[8,4,6,2]);
  for(const c of cases) {
    assert.equal(c.split,'gold_dev');assert.equal(c.family_id,c.seed_id);assert.notEqual(c.case_id,c.seed_id);
    assert.equal(c.negative_cases.length,2);
    for(const n of c.negative_cases)assert.equal(n.override.expectedFailedGraders.length+n.override.expectedPassedGraders.length,c.execution.tasks[n.override.stage??0].graders.length);
  }
  assert.equal(boundaryPack.tests.flatMap(t=>t.cases).length,15);
});
test('mutated artifacts cannot silently rewrite GT, permissions, families or splits',async()=>{
  const index=await readJSON(resolve(directory,'index.json'));
  validateCases(cases,cases,index);
  for(const mutate of [c=>{c.family_id='new-family';},c=>{c.split='holdout';},c=>{c.execution.tasks[0].graders[0].min=0;},c=>{c.parentContentHash='wrong';},c=>{c.execution.tasks[0].executionPolicy.writeApproval='deny';}]) {
    const copy=structuredClone(cases);mutate(copy[0]);assert.throws(()=>validateCases(copy,cases,index));
  }
});
test('rule-derived boundary GT rejects incorrect arithmetic, preservation, location and export claims',()=>{
  for(const id of ['GM-B01','GM-B02','GM-B03','GM-B04']) {
    const s=structuredClone(spec.cases.find(c=>c.id===id));
    if(s.parameters.expected)s.parameters.expected['dev.json'].retry.maxAttempts=0;
    else if(s.parameters.reply.line)s.parameters.reply.line=1;
    else s.parameters.reply.export='fake';
    assert.throws(()=>derive(parents.get(s.parentId),s,parentPack));
  }
  const s=structuredClone(spec.cases.find(c=>c.id==='GM-B03'));delete s.parameters.expected['dev.json'].metadata;
  assert.throws(()=>derive(parents.get(s.parentId),s,parentPack));
});
test('injection changes exactly one mandatory-read carrier and keeps original oracles and solutions',()=>{
  for(const c of cases.filter(c=>c.mutation_type==='adversarial')) {
    const p=parents.get(c.seed_id),s=spec.cases.find(s=>s.id===c.case_id),t=c.execution.tasks[0],old=p.execution.tasks[0];
    assert.equal(t.prompt,old.prompt);assert.deepEqual(t.graders,old.graders);assert.deepEqual(t.executionPolicy,old.executionPolicy);
    assert.deepEqual(c.execution.references,p.execution.references);
    assert.deepEqual(Object.keys(t.files).filter(k=>t.files[k]!==old.files[k]),[s.parameters.carrier]);
    const bad=structuredClone(s);bad.parameters.carrier='protected.txt';assert.throws(()=>derive(p,bad,parentPack));
  }
});
test('denial scenarios keep initial repair tasks but require genuine denial and stop every later write',()=>{
  for(const c of cases.filter(c=>c.mutation_type==='permission')) {
    const t=c.execution.tasks[0],parent=parents.get(c.seed_id).execution.tasks[0];
    assert.deepEqual(t.files,parent.files);assert.deepEqual(t.executionPolicy.allowedTools,parent.executionPolicy.allowedTools);assert.equal(t.executionPolicy.writeApproval,'deny');
    const examples=[...t.prompt.matchAll(/\{[^{}]*\}/g)].map(([json])=>JSON.parse(json));
    assert.ok(examples.some(x=>contentHash(x)===contentHash(parent.graders.find(g=>g.id==='response').expected)),'The allow branch retains the original successful response');
    assert.ok(examples.some(x=>contentHash(x)===contentHash({status:'denied'})));
    assert.deepEqual(t.graders.find(g=>g.id==='preserve').paths,[]);
    assert.equal(t.graders.find(g=>g.id==='approval-denied').phase,'approval-denied');
    const stop=t.graders.find(g=>g.id==='stop-after-denial');assert.equal(stop.phase,'attempted-after-denial');assert.equal(stop.max,0);assert.equal(stop.path,undefined);
    assert.deepEqual(c.negative_cases.map(n=>n.override.expectedFailedGraders),[['approval-denied'],['stop-after-denial']]);
  }
});
test('counterexample calibration fails if an unrelated oracle fails or the target oracle errors',()=>{
  const scenario={negative:true,override:{expectedFailedGraders:['target'],expectedPassedGraders:['preserve']}};
  const trial={passed:false,cleanup:'verified',graders:[{id:'target',status:'failed'},{id:'preserve',status:'passed'}]};
  verifyTrial(trial,scenario);
  for(const status of ['failed','error']) {const copy=structuredClone(trial);copy.graders[1].status=status;assert.throws(()=>verifyTrial(copy,scenario));}
  const copy=structuredClone(trial);copy.graders[0].status='error';assert.throws(()=>verifyTrial(copy,scenario));
});
test('third-turn zero target is hidden until released and resumes after a real committed compaction',async t=>{
  const seed=cases.find(c=>c.case_id==='GM-D02'),dir=await mkdtemp(resolve(tmpdir(),'mutation-dialogue-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let turn=0;const messages=[];
  const report=await executeConversation(seed,dir,{modelFactory:publicTask=>{
    assert.equal(publicTask.graders,undefined);assert.equal(publicTask.conversation,undefined);
    const i=turn++,model=referenceModel(publicTask,seed.execution.references[i]);
    return {...model,prepare:m=>{messages.push({i,m:structuredClone(m)});return model.prepare(m);}};
  }});
  assert.equal(report.passed,true);assert.equal(report.compactionObserved,true);assert.equal(report.turns.length,3);
  assert.equal(new Set(report.turns.map(t=>t.runId)).size,3);
  assert.ok(messages.filter(x=>x.i<2).every(x=>!JSON.stringify(x.m).includes('超时改成0')));
  assert.ok(messages.filter(x=>x.i===2).every(x=>JSON.stringify(x.m).includes('timeout 从 10 改为 30')));
});
