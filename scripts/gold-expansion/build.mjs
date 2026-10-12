import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../../dist/src/json.js';
import { validateSandboxTestPack } from '../../dist/src/evaluation/test-pack.js';
import { expansionSpecifications } from './catalog.mjs';
import { deriveExpansion } from './derive.mjs';
import { validateQuality,validateDefectDiversity } from './quality.mjs';
import { directory,goldDirectory,priorDirectory,readJSON,writeJSON,sha,parentState,sourceHashes,fingerprint } from './common.mjs';

export async function materialize() {
  const {lock,frozen,index:parentIndex}=await parentState();
  const spec=await readJSON(resolve(directory,'source/specifications.json'));assert.deepEqual(spec,expansionSpecifications());
  const versionBundle={dataset:'2.0.0',parentManifestHash:lock.manifestHash,parentRuntimeHash:lock.runtimeHash,priorManifestHash:frozen.manifestHash,runtimeHash:(await fingerprint()).hash,contentHashes:await sourceHashes()};
  const prior=await readJSON(resolve(priorDirectory,'index.json')),cases=[];
  for(const row of prior.cases){const c=await readJSON(resolve(priorDirectory,row.file));assert.equal(contentHash(c),row.contentHash);cases.push(c);}
  const authors=await readJSON(resolve(goldDirectory,'source/agent-seeds.json')),parentPack=await readJSON(resolve(priorDirectory,'parent.tests.json')),priorPack=await readJSON(resolve(priorDirectory,'boundary.tests.json'));
  const byId=new Map(cases.map(c=>[c.case_id,c])),parents=new Map();
  for(const row of spec.cases){
    assert.ok(!byId.has(row.id));const parent=await readJSON(resolve(goldDirectory,`cases/${row.parentId}.json`));
    assert.equal(contentHash(parent),parentIndex.seeds.find(s=>s.id===row.parentId).contentHash);parents.set(row.parentId,parent);
    const c=deriveExpansion(parent,row,parentPack,authors.find(a=>a.id===row.parentId),row.base?byId.get(row.base):null,versionBundle);cases.push(c);byId.set(c.case_id,c);
  }
  const tests=cases.slice(20).filter(c=>c.mutation_type==='boundary'&&c.addedTest).map(c=>c.addedTest);
  const boundaryPack=validateSandboxTestPack({schemaVersion:1,id:'gold-mutations-v2',version:'2.0.0',tests});
  const quality=validateQuality(cases,[parentPack,priorPack,boundaryPack],spec.cases);
  quality.initialDefectDiversity=validateDefectDiversity(spec.cases,parents,parentPack);
  return {lock,frozen,spec,cases,parentPack,priorPack,boundaryPack,parents,quality};
}
export async function build() {
  const spec=expansionSpecifications();assert.equal(spec.cases.length,130);
  await mkdir(resolve(directory,'cases'),{recursive:true,mode:0o700});await writeJSON(resolve(directory,'source/specifications.json'),spec);
  const {lock,frozen,cases,parentPack,priorPack,boundaryPack,quality}=await materialize();
  const files={},write=async(p,data)=>{await writeJSON(resolve(directory,p),data);files[p]=sha(await readFile(resolve(directory,p)));};
  const rows=cases.map((c,i)=>({id:c.case_id,file:`cases/${c.case_id}.json`,parentId:c.seed_id,parentContentHash:c.parentContentHash,family:c.family_id,upstreamFamily:c.upstreamFamily,operator:c.mutation_type,split:c.split,bucket:c.bucket,contentHash:contentHash(c),origin:i<20?'retained-v1':'new-v2',decisionBoundary:c.expansion?.decisionBoundary??c.title}));
  for(const [i,c] of cases.entries()){
    if(i<20){const bytes=await readFile(resolve(priorDirectory,rows[i].file));await writeFile(resolve(directory,rows[i].file),bytes,{mode:0o600});files[rows[i].file]=sha(bytes);}
    else await write(rows[i].file,c);
  }
  await write('index.json',{schemaVersion:1,version:'2.0.0',parentVersion:lock.version,status:'derived-candidates',caseCount:150,retainedCases:20,newCases:130,parentFamilies:10,newIndependentSeeds:0,hiddenCases:0,cases:rows});
  await write('lineage.json',{schemaVersion:1,parentManifestHash:lock.manifestHash,priorManifestHash:frozen.manifestHash,cases:rows,note:'All descendants remain in the exposed gold_dev parent family.'});
  await write('parent.tests.json',parentPack);await write('prior.tests.json',priorPack);await write('boundary.tests.json',boundaryPack);
  await write('agent-suite.json',{schemaVersion:1,id:'gold-mutations-v2-single-turn',version:'2.0.0',split:'capability',tasks:cases.filter(c=>c.execution.kind==='coding').map(c=>c.execution.tasks[0])});
  await write('conversations.json',{schemaVersion:1,cases:cases.filter(c=>c.execution.kind==='conversation').map(c=>({id:c.case_id,file:`cases/${c.case_id}.json`,turns:c.execution.tasks.length}))});
  await write('quality-gates.json',quality);await write('distribution.json',quality.gates.distribution);
  await write('matrix.json',{schemaVersion:1,rows:cases.map((c,i)=>({id:c.case_id,family:c.family_id,goal:c.capability_id,risk:c.risk_level,operator:c.mutation_type,decisionBoundary:rows[i].decisionBoundary,initialFiles:Object.keys(c.initial_state.files).length,turns:c.execution.tasks.length,writeApproval:c.execution.tasks.map(t=>t.executionPolicy.writeApproval),compactionAfter:c.execution.compaction?.afterStage??null,semanticSignature:quality.semanticSignatures[c.case_id]}))});
  await write('buckets.json',{schemaVersion:1,coverage:rows.map(r=>r.id),challenge:rows.filter(r=>r.operator!=='boundary').map(r=>r.id),regression:[],regressionCandidates:['GM-I02','GM-I05','GM-I06'],gold:[],canary:[],hidden:[],note:'Observed failures remain candidates until fixed; no synthetic case is promoted to human gold or hidden.'});
  const md=['# 150 条受控变体审阅包','20 条已验证变体逐字保留；130 条新增。10 个父家族，0 新独立种子，0 留出题。参考和反例由 AI 编写，等待人审。',...cases.map((c,i)=>[`## ${c.case_id}：${c.title}`,`父家族 ${c.family_id}；来源 ${rows[i].origin}；contentHash ${rows[i].contentHash}`,`规则：${c.rule}`,`初态与执行协议：\n\n~~~~json\n${JSON.stringify({initial:c.initial_state,protocol:c.trial_protocol,reset:c.reset_contract??'继承 v1 的 fresh workspace/session 协议',compaction:c.execution.compaction},null,2)}\n~~~~`,...c.execution.tasks.map((t,j)=>`### 第 ${j+1} 轮\n\n${t.prompt}\n\n~~~~json\n${JSON.stringify({policy:t.executionPolicy,graders:t.graders,contract:t.contract,reference:c.execution.references[j]},null,2)}\n~~~~`),`新增测试及反例：\n\n~~~~json\n${JSON.stringify({addedTest:c.addedTest,negative:c.negative_cases},null,2)}\n~~~~`].join('\n\n')),''].join('\n\n');
  await writeFile(resolve(directory,'review.md'),md,{mode:0o600});files['review.md']=sha(md);
  try{await writeFile(resolve(directory,'human-reviews.json'),JSON.stringify({schemaVersion:1,decisions:[]},null,2)+'\n',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  await writeJSON(resolve(directory,'manifest.json'),{schemaVersion:1,version:'2.0.0',parent:lock,prior:frozen,files,sources:await sourceHashes()});
  return {directory,cases:cases.length,retained:20,newCases:130,families:10,distribution:quality.gates.distribution};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await build()));
