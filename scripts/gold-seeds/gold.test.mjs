import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { directory, readJSON, allCapabilities } from './common.mjs';
import { validateSeeds } from './schema.mjs';
import { acceptedReviews } from './audit.mjs';
import { executeConversation } from './conversation.mjs';
import { referenceModel } from './reference.mjs';
import { loadProvenance, validateProvenance } from './provenance.mjs';
import { curationPath, loadCuration, validateCuration } from './curation.mjs';
import { loadRevisions, validateRevisions } from './revisions.mjs';
import { calibrationScenarios } from './scenarios.mjs';

const index=await readJSON(resolve(directory,'index.json'));
const seeds=await Promise.all(index.seeds.map(r=>readJSON(resolve(directory,r.file))));
test('clarifications retain identities, invalidate previous human hashes, and expose complete oracle details',async()=>{
  const specs=(await Promise.all(['agent-seeds','engineering-seeds'].map(n=>readJSON(resolve(directory,`source/${n}.json`))))).flat();
  const {revision}=await loadRevisions(specs),previous=await readJSON(resolve(directory,'archive/v2.3.1/index.json'));
  assert.equal(revision.cases.filter(c=>c.classification==='clarification').length,14);
  assert.deepEqual(index.seeds.map(s=>s.id).sort(),previous.seeds.map(s=>s.id).sort());
  assert.ok(index.seeds.every(s=>s.contentHash!==previous.seeds.find(p=>p.id===s.id).contentHash));
  const changed=structuredClone(specs);changed[0].input+=' undisclosed change';
  assert.throws(()=>validateRevisions(revision,changed,previous));
  for(const s of seeds) for(const path of ['src/evaluation/sandbox-test-bootstrap.ts','src/evaluation/sandbox-tests.ts','src/evaluation/coding-executor.ts','src/tool-pipeline.ts','src/observability/project.ts','test/pipeline-helpers.ts','package-lock.json']) assert.ok(s.version_bundle.contentHashes[path],path);
  const scenarios=seeds.filter(s=>s.track==='agent-task').flatMap(calibrationScenarios);
  assert.equal(scenarios.filter(s=>!s.negative).length,19);
  assert.equal(scenarios.filter(s=>s.negative).length,28);
  const review=await readFile(resolve(directory,'review.md'),'utf8');
  for(const text of ['lone-high-at-cut','HTTP-404-with-fragment','skill summaries, bodies and resources resolve one immutable nearest-layer definition','commonjs-object','approval-denied','attempted-after-denial','known-failure-with-unavailable-path']) assert.ok(review.includes(text),text);
});
test('format clarification preserves business oracles and makes every public JSON example parseable',async()=>{
  const prior=resolve(directory,'archive/v2.3.1');
  const withoutInput=spec=>{
    const copy=structuredClone(spec);delete copy.input;
    for(const stage of copy.stages??[]) delete stage.input;
    return copy;
  };
  for(const name of ['agent-seeds','engineering-seeds']) {
    const current=await readJSON(resolve(directory,`source/${name}.json`));
    const old=await readJSON(resolve(prior,`source/${name}.json`));
    assert.deepEqual(current.map(withoutInput),old.map(withoutInput),'Only public author inputs may change');
  }
  assert.deepEqual(await readJSON(resolve(directory,'agent.tests.json')),await readJSON(resolve(prior,'agent.tests.json')));
  for(const seed of seeds) {
    const old=await readJSON(resolve(prior,`cases/${seed.case_id}.json`));
    for(const key of ['initial_state','expected_state','user_permissions','available_tools','tool_state','outcome_assertions','required_invariants','response_rubric','trial_protocol','reference_execution','negative_cases']) assert.deepEqual(seed[key],old[key],`${seed.case_id}/${key}`);
    const stripPrompt=execution=>{
      const copy=structuredClone(execution);
      for(const task of copy.tasks??[]) {
        delete task.prompt;
        for(const source of task.contract.sources) {
          delete source.version;
          if(source.id==='task') delete source.statement;
        }
      }
      return copy;
    };
    assert.deepEqual(stripPrompt(seed.execution),stripPrompt(old.execution),`${seed.case_id} execution and scoring are unchanged`);
    for(const task of seed.execution.tasks??[]) {
      const examples=[...task.prompt.matchAll(/\{[^{}]*\}/g)];
      assert.ok(examples.length,`${task.id} must have a public response example`);
      for(const [example] of examples) assert.doesNotThrow(()=>JSON.parse(example),`${task.id}: ${example}`);
    }
  }
});
test('seed package covers the attached A/H/P domains without counting mutations as seeds',async()=>{
  validateSeeds(seeds);
  assert.equal(seeds.length,38);
  assert.deepEqual([...new Set(seeds.map(s=>s.capability_id))].sort(),allCapabilities.slice().sort());
  assert.equal(seeds.filter(s=>s.track==='agent-task').length,14);
  assert.equal(seeds.filter(s=>s.execution.kind==='conversation').length,2);
  const pack=await readJSON(resolve(directory,'agent.tests.json'));
  const testIds=new Set(pack.tests.map(t=>`${pack.id}/${t.id}`));
  for(const seed of seeds) for(const task of seed.execution.tasks ?? []) for(const grader of task.graders) {
    if(grader.kind==='sandbox-test') assert.ok(testIds.has(grader.testId),`Unregistered behavior oracle: ${grader.testId}`);
  }
});
test('upstream evidence is pinned; release notes cannot masquerade as fix-backed seeds or split a source family',async()=>{
  const {registry}=await loadProvenance(seeds.map(s=>s.case_id));
  assert.equal(registry.records.length,10);
  assert.equal(seeds.filter(s=>s.provenance.origin==='upstream-regression').length,5);
  assert.equal(seeds.filter(s=>s.provenance.origin==='benchmark-derived').length,3);
  for(const alter of [
    r=>{r.records[0].fixCommit='main';},
    r=>{r.records[0].evidence[0].path='../../outside';},
    r=>{r.bindings[0].sourceIds=['missing'];},
    r=>{r.bindings.find(b=>b.origin==='project-contract-corroborated').origin='upstream-regression';},
    r=>{r.bindings[1].upstreamFamily=r.bindings[0].upstreamFamily;},
  ]) {const copy=structuredClone(registry);alter(copy);assert.throws(()=>validateProvenance(copy,seeds.map(s=>s.case_id)));}
  for(const seed of seeds.filter(s=>s.provenance.origin!=='project-contract')) {
    const binding=registry.bindings.find(b=>b.caseId===seed.case_id);
    for(const id of binding.sourceIds) for(const evidence of registry.records.find(r=>r.id===id).evidence) {
      assert.equal(seed.version_bundle.contentHashes[evidence.path],evidence.sha256,'Human acceptance must bind source evidence, not just the source URL');
    }
  }
});
test('all original seeds have auditable decisions; retired cases cannot inflate the active corpus',async()=>{
  const curation=await loadCuration(await readJSON(resolve(directory,'source/agent-seeds.json')),await readJSON(resolve(directory,'source/engineering-seeds.json')), (await loadProvenance(seeds.map(s=>s.case_id))).registry);
  assert.deepEqual(['retain','strengthen','replace'].map(d=>curation.entries.filter(e=>e.decision===d).length),[27,3,3]);
  for(const alter of [
    c=>{c.entries.pop();},
    c=>{c.entries[1]=structuredClone(c.entries[0]);},
    c=>{c.entries.find(e=>e.decision==='replace').activeCaseIds=['missing'];},
    c=>{c.entries.find(e=>e.decision==='strengthen').addedChecks=[];},
    c=>{c.entries[0].previousCase.sha256='changed';},
  ]) {const copy=structuredClone(curation);alter(copy);assert.throws(()=>validateCuration(copy,seeds.map(s=>s.case_id)));}
  const retired=curation.entries.find(e=>e.decision==='replace').caseId;
  assert.throws(()=>validateCuration(curation,[...seeds.map(s=>s.case_id),retired]));
  assert.ok(seeds.every(s=>s.version_bundle.contentHashes[curationPath]));
});
test('malformed, unsourced, unexecutable and mislabeled gold contracts are rejected',()=>{
  for(const alter of [
    s=>{s.required_invariants[0].sourceIds=['invented'];},
    s=>{s.outcome_assertions[0].oracleIds=['nonexistent'];},
    s=>{s.track='harness-contract';},
    s=>{s.review.status='accepted';},
    s=>{s.mutation_type='wording';},
    s=>{s.case_id='../escape';},
    s=>{s.initial_state.files['protected.txt']='changed';},
    s=>{s.execution.tasks[0].graders=[];},
  ]) {const copy=structuredClone(seeds[0]);alter(copy);assert.throws(()=>validateSeeds([copy]));}
});
test('human acceptance needs two distinct current-hash reviewers; AI and stale records cannot satisfy it',()=>{
  const row=index.seeds[0];
  const review=reviewer=>({caseId:row.id,contentHash:row.contentHash,reviewer,reviewerKind:'human',reviewedAt:'2026-10-02T00:00:00Z',decision:'accept',reason:'Reviewed explicit requirements and reference evidence.',checks:Object.fromEntries(['relevance','unambiguous','referenceCorrect','assertionsSourced','negativeMeaningful'].map(k=>[k,true]))});
  assert.deepEqual(acceptedReviews(index,{decisions:[review('one'),review(' ONE ')]}),[]);
  assert.deepEqual(acceptedReviews(index,{decisions:[review('one'),{...review('two'),contentHash:'stale'}]}),[]);
  assert.deepEqual(acceptedReviews(index,{decisions:[review('one'),review('two')]}),[row.id]);
  assert.throws(()=>acceptedReviews(index,{decisions:[{...review('AI'),reviewerKind:'AI'}]}));
  assert.deepEqual(acceptedReviews(index,{decisions:[review('one'),review('two'),{...review('one'),decision:'revise'}]}),[]);
});
test('a real same-Session reference gets prior turns but never receives future turns or graders',async t=>{
  const seed=seeds.find(s=>s.case_id==='GS-A5-01');
  const dir=await mkdtemp(resolve(tmpdir(),'gold-dialogue-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let turn=0;const observed=[];
  const report=await executeConversation(seed,dir,{modelFactory:publicTask=>{
    assert.equal('graders' in publicTask,false);assert.equal('conversation' in publicTask,false);
    const i=turn++,model=referenceModel(publicTask,seed.execution.references[i]);
    return {...model,prepare:messages=>{observed.push({turn:i,messages:structuredClone(messages)});return model.prepare(messages);}};
  }});
  assert.equal(report.passed,true);assert.equal(new Set(report.turns.map(t=>t.runId)).size,2);
  assert.ok(observed.filter(r=>r.turn===0).every(r=>!JSON.stringify(r.messages).includes('4100')));
  assert.ok(observed.filter(r=>r.turn===1).every(r=>JSON.stringify(r.messages).includes('prod.json 永远不能修改')));
});
