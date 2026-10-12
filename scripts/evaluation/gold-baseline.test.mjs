import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationOutcome } from './gold-baseline.mjs';
const grader=(status,required=true)=>({status,required,score:status==='error'?null:status==='passed'?1:0,weight:1});
const report=graders=>({cleanup:'verified',turns:[{status:'completed',graders}]});
test('dialogue failures survive unavailable evidence, while optional failures do not establish failure',()=>{
  assert.deepEqual(conversationOutcome(report([grader('failed'),grader('error')])),{classification:'task-failure',passed:false,score:null});
  assert.deepEqual(conversationOutcome(report([grader('failed',false),grader('error')])),{classification:'grader-failure',passed:null,score:null});
  assert.deepEqual(conversationOutcome(report([grader('passed'),grader('failed',false)])),{classification:'success',passed:true,score:0.5});
});
test('provider failures and unconfirmed cleanup cannot become model-quality failures',()=>{
  const failed={cleanup:'verified',turns:[{status:'failed',graders:[grader('failed')]}]};
  assert.equal(conversationOutcome(failed,[{turn:0,code:'MODEL_HTTP_401'}]).passed,null);
  assert.equal(conversationOutcome({...failed,cleanup:'unconfirmed'}).passed,null);
  assert.equal(conversationOutcome(failed).passed,false);
  assert.equal(conversationOutcome(report([grader('passed')]),[{turn:0,code:'MODEL_CONTEXT_OVERFLOW'}]).passed,true,'A recovered provider rejection does not invalidate a completed turn');
});

// Diagnostic extraction must handle unrelated inline JSON and string braces.
import { containsExpectedJson, loadBaselineSeed } from './analyze-gold-baseline.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { contentHash } from '../../dist/src/json.js';
test('embedded JSON diagnostics neither miss trailing objects nor invent valid JSON from pseudo-JSON',()=>{
  assert.equal(containsExpectedJson('Files {"port":4000}.\n```json\n{"status":"completed"}\n```',{status:'completed'}),true);
  assert.equal(containsExpectedJson('Object: {"value":{"text":"brace } in a string"}}',{value:{text:'brace } in a string'}}),true);
  assert.equal(containsExpectedJson('{status:"completed"}',{status:'completed'}),false);
  assert.equal(containsExpectedJson('{"status":"denied"}',{status:'completed'}),false);
});
test('historical baseline analysis uses only an exact retained seed hash after requirements change',async t=>{
  const base=await mkdtemp(resolve(tmpdir(),'baseline-archive-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const taskId='GS-A1-01',old={prompt:'old',expected:'old'},current={prompt:'new',expected:'new'};
  const report={datasetVersion:'2.3.1',cases:[{caseId:taskId,contentHash:contentHash(old)}]};
  const archived=resolve(base,'archive/v2.3.1/cases');
  await mkdir(resolve(base,'cases'),{recursive:true});await mkdir(archived,{recursive:true});
  await writeFile(resolve(base,`cases/${taskId}.json`),JSON.stringify(current));
  await assert.rejects(()=>loadBaselineSeed(report,taskId,base),/No current or archived seed matches/);
  await writeFile(resolve(archived,`${taskId}.json`),JSON.stringify(old));
  assert.deepEqual(await loadBaselineSeed(report,taskId,base),old);
  await writeFile(resolve(archived,`${taskId}.json`),JSON.stringify(current));
  await assert.rejects(()=>loadBaselineSeed(report,taskId,base),/No current or archived seed matches/);
});
