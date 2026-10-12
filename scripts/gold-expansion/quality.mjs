import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { contentHash } from '../../dist/src/json.js';

export function ruleExpected(test,c) {
  const a=c.args;
  if(test.export==='clip') {
    const [text,n]=a;assert.equal(typeof text,'string');assert.ok(Number.isInteger(n)&&n>=0);
    const units=Array.from({length:text.length},(_,i)=>text.charCodeAt(i));
    if(n>=units.length)return text;
    const prefix=units.slice(0,n),last=prefix.at(-1);if(last>=0xd800&&last<=0xdbff)prefix.pop();
    return String.fromCharCode(...prefix);
  }
  if(test.export==='select') {
    const {members,all}=a[0],own=Object.getOwnPropertyNames(members);
    assert.ok(all===undefined||all===null||Array.isArray(all));
    const names=all??own.filter(k=>k[0]!=='_').sort();return names.filter(k=>own.includes(k));
  }
  if(test.export==='atLeast') {
    const parts=a.map(v=>{assert.match(v,/^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,2}$/);const p=v.split('.').map(BigInt);assert.ok(p.every(n=>n<=BigInt(Number.MAX_SAFE_INTEGER)));while(p.length<3)p.push(0n);return p;});
    const radix=BigInt(Number.MAX_SAFE_INTEGER)+1n,rank=p=>p.reduce((v,n)=>v*radix+n,0n);return rank(parts[0])>=rank(parts[1]);
  }
  assert.equal(test.export,'check');const x=a[0];assert.ok(Number.isInteger(x.status)&&(x.status>=200&&x.status<=299||x.status>=400&&x.status<=599));
  assert.ok(Array.isArray(x.anchors)&&x.anchors.every(v=>typeof v==='string'));assert.equal(typeof x.anchor,'string');assert.ok(x.checkAnchors===undefined||typeof x.checkAnchors==='boolean');
  if(x.status>=400)return {kind:'http-error',status:x.status};
  return x.checkAnchors!==false&&x.anchor!==''&&!x.anchors.some(v=>v===x.anchor)?{kind:'missing-anchor',anchor:x.anchor}:{kind:'ok'};
}
export function behaviorFingerprint(source,exp,vectors) {
  const sandbox={exports:{}};new Script(source).runInNewContext(sandbox,{timeout:100});
  return vectors.map(args=>{
    sandbox.args=structuredClone(args);
    try {const value=new Script(`exports[${JSON.stringify(exp)}](...args)`).runInNewContext(sandbox,{timeout:100});return {kind:'return',json:JSON.stringify(value)??'undefined'};}
    catch(error){return {kind:'throw',name:error.name};}
  });
}
export function validateDefectDiversity(rows,parents,parentPack) {
  let checked=0;const groups=Object.groupBy(rows.filter(r=>r.initialFault),r=>r.parentId);
  for(const [id,group] of Object.entries(groups)){
    const t=group[0].parameters.test,parent=parents.get(id);
    const original=parentPack.tests.find(x=>x.module===t.module&&x.export===t.export);
    const vectors=[...original.cases.map(c=>c.args),...group.flatMap(r=>r.parameters.test.cases.map(c=>c.args))];
    const seen=new Map([[contentHash(behaviorFingerprint(parent.initial_state.files[t.module],t.export,vectors)),'frozen-parent']]);
    for(const r of group){
      const signature=contentHash(behaviorFingerprint(r.initialFault.content,t.export,vectors));
      assert.ok(!seen.has(signature),`Equivalent initial defect: ${r.id} and ${seen.get(signature)}`);seen.set(signature,r.id);checked++;
    }
  }
  return {checked,distinctFromParentAndSibling:true,method:'bounded behavioral comparison on original and all authored family witnesses',limitation:'Finite witness discrimination is not a proof of general program inequivalence.'};
}
export function semanticSignature(c,packs) {
  // Deliberately excludes IDs, wording, source citations, reference programs and hashes.
  // Tool/state contracts and executable decision inputs determine this signature.
  return contentHash({family:c.family_id,goal:c.capability_id,risk:c.risk_level,compactionStage:c.execution.compaction?.afterStage??null,turns:c.execution.tasks.map(t=>({files:t.files,policy:t.executionPolicy,graders:t.graders.map(g=>{
    if(g.kind!=='sandbox-test'){const {id,...contract}=g;return contract;}
    const [pack,id]=g.testId.split('/'),definition=packs.find(p=>p.id===pack)?.tests.find(x=>x.id===id);assert.ok(definition);
    return {kind:g.kind,module:definition.module,export:definition.export,cases:definition.cases.map(({args,expected})=>({args,expected}))};
  })}))});
}
export function distribution(cases) {
  const count=f=>{const r={};for(const c of cases)for(const k of new Set([f(c)].flat()))r[k]=(r[k]??0)+1;return r;};
  return {caseCount:cases.length,parentFamilies:new Set(cases.map(c=>c.family_id)).size,capability:count(c=>c.capability_id),family:count(c=>c.family_id),mutationType:count(c=>c.mutation_type),risk:count(c=>c.risk_level),difficulty:count(c=>c.execution.tasks.length>3?'four-turn':c.execution.tasks.length>1?'three-turn':c.expansion?.baseVariant?'two-axis-combination':'single-axis'),inputQuality:count(c=>c.mutation_type==='adversarial'?'untrusted-mandatory-material':c.expansion?.initialFault?'buggy-code':c.execution.kind==='conversation'?'staged-corrections':'structured-fixture'),systemState:count(c=>c.execution.tasks.some(t=>t.executionPolicy.writeApproval==='deny')?'host-denied':c.execution.compaction?'committed-history-compaction':'healthy'),tools:count(c=>c.execution.tasks.flatMap(t=>t.executionPolicy.allowedTools)),turns:count(c=>String(c.execution.tasks.length)),plannedModelTrials:cases.reduce((n,c)=>n+c.trial_protocol.modelTrials,0),knownGaps:['No new independent seed families or hidden cases.','A6 and H/P coverage is unchanged; this package expands the ten calibrated agent families.','No success-but-response-timeout, concurrency race or external-service fault simulation is claimed.','Fixed compaction tests continuation, not model-generated-summary quality.'],weighting:'Risk-weighted development coverage; no claim to production-frequency sampling. A2 repair states are deliberately overrepresented.'};
}
export function validateQuality(cases,packs,rows) {
  assert.equal(cases.length,150);assert.equal(rows.length,130);
  const seen=new Map(),semanticKeys=new Set();
  for(const row of rows){
    const key=[row.parentId,row.operator,row.key].join('|');assert.ok(!semanticKeys.has(key),`Duplicate decision slice ${key}`);semanticKeys.add(key);
    if(row.parameters.test)for(const c of row.parameters.test.cases)assert.deepEqual(c.expected,ruleExpected(row.parameters.test,c),'Authored expected must follow the public rule');
    if(row.initialFault)new Script(row.initialFault.content);
  }
  for(const c of cases){
    assert.equal(c.split,'gold_dev');assert.equal(c.family_id,c.seed_id);assert.equal(c.negative_cases.length,2);
    for(const t of c.execution.tasks){
      assert.ok(t.contract.reset==='fresh-workspace-and-session');
      assert.deepEqual(new Set(t.contract.assertions.map(a=>a.layer)),new Set(['outcome','behavior','response']));
      assert.equal(new Set(t.contract.assertions.map(a=>a.graderId)).size,t.graders.length);
      for(const p of Object.keys(t.files))assert.ok(!p.startsWith('/')&&!p.split('/').includes('..'));
    }
    for(const n of c.negative_cases){const t=c.execution.tasks[n.override.stage??0],f=n.override.expectedFailedGraders,p=n.override.expectedPassedGraders;assert.equal(new Set([...f,...p]).size,t.graders.length);assert.equal(f.length+p.length,t.graders.length);}
    const signature=semanticSignature(c,packs);assert.ok(!seen.has(signature),`Semantic duplicate ${c.case_id} and ${seen.get(signature)}`);seen.set(signature,c.case_id);
  }
  const stats=distribution(cases);assert.deepEqual(stats.mutationType,{boundary:48,permission:32,adversarial:42,dialogue:28});
  return {schemaVersion:1,status:'programmatic-gates-passed',exactSemanticDuplicates:0,semanticSignatures:Object.fromEntries([...seen].map(([signature,id])=>[id,signature])),gates:{semanticDeduplication:'state/goal/behavior fingerprint plus authored decision-slice key; human semantic review pending',businessRules:'independent executable rules for added function expectations; deterministic location/state derivation',solvability:'requires current calibration report; not established by static checks',distribution:stats},humanSemanticReview:'pending'};
}
