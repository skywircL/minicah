import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../../dist/src/json.js';
import { validateSandboxTestPack } from '../../dist/src/evaluation/test-pack.js';
import { directory, goldDirectory, readJSON, writeJSON, sha, parentState, sourceHashes, fingerprint } from './common.mjs';
import { derive, operators } from './derive.mjs';

export async function materialize() {
  const {lock,index:parentIndex}=await parentState();
  const spec=await readJSON(resolve(directory,'source/specifications.json'));assert.equal(spec.schemaVersion,1);assert.equal(spec.version,'1.0.0');assert.equal(spec.parentVersion,lock.version);
  const versionBundle={dataset:spec.version,parentManifestHash:lock.manifestHash,parentRuntimeHash:lock.runtimeHash,runtimeHash:(await fingerprint()).hash,contentHashes:await sourceHashes()};
  const authors=await readJSON(resolve(goldDirectory,'source/agent-seeds.json'));
  const parentPack=await readJSON(resolve(goldDirectory,'agent.tests.json'));
  const parents=new Map(),ids=new Set(),cases=[];
  for(const row of spec.cases) {
    assert.ok(!ids.has(row.id),'Duplicate mutation ID');ids.add(row.id);
    const parent=await readJSON(resolve(goldDirectory,`cases/${row.parentId}.json`));
    assert.equal(contentHash(parent),parentIndex.seeds.find(s=>s.id===row.parentId)?.contentHash);
    parents.set(parent.case_id,parent);
    cases.push({...derive(parent,row,parentPack,authors.find(a=>a.id===row.parentId)),version_bundle:structuredClone(versionBundle)});
  }
  const boundaryPack=validateSandboxTestPack({schemaVersion:1,id:'gold-mutations-v1',version:'1.0.0',tests:cases.flatMap(c=>c.addedTest?[c.addedTest]:[])});
  const tests=new Set([parentPack,boundaryPack].flatMap(p=>p.tests.map(t=>`${p.id}/${t.id}`)));
  for(const c of cases) for(const t of c.execution.tasks) for(const g of t.graders) if(g.kind==='sandbox-test')assert.ok(tests.has(g.testId));
  return {lock,spec,cases,parentPack,boundaryPack,parents};
}
export async function build() {
  const {lock,cases,parentPack,boundaryPack}=await materialize();
  await mkdir(resolve(directory,'cases'),{recursive:true,mode:0o700});
  const files={},write=async(p,data)=>{await writeJSON(resolve(directory,p),data);files[p]=sha(await readFile(resolve(directory,p)));};
  const rows=cases.map(c=>({id:c.case_id,file:`cases/${c.case_id}.json`,parentId:c.seed_id,parentContentHash:c.parentContentHash,family:c.family_id,upstreamFamily:c.upstreamFamily,operator:c.mutation_type,split:c.split,bucket:c.bucket,contentHash:contentHash(c)}));
  for(const [i,c] of cases.entries()) await write(rows[i].file,c);
  await write('index.json',{schemaVersion:1,version:'1.0.0',parentVersion:lock.version,status:'derived-candidates',caseCount:cases.length,parentFamilies:new Set(rows.map(r=>r.family)).size,newIndependentSeeds:0,hiddenCases:0,cases:rows});
  await write('operators.json',{schemaVersion:1,operators});
  await write('lineage.json',{schemaVersion:1,parentManifestHash:lock.manifestHash,cases:rows,note:'All descendants retain the parent gold_dev family. No hidden split or independent-seed promotion.'});
  await write('parent.tests.json',parentPack);await write('boundary.tests.json',boundaryPack);
  await write('agent-suite.json',{schemaVersion:1,id:'gold-mutations-v1-single-turn',version:'1.0.0',split:'capability',tasks:cases.filter(c=>c.execution.kind==='coding').map(c=>c.execution.tasks[0])});
  await write('conversations.json',{schemaVersion:1,cases:cases.filter(c=>c.execution.kind==='conversation').map(c=>({id:c.case_id,file:`cases/${c.case_id}.json`,turns:c.execution.tasks.length}))});
  await write('matrix.json',{schemaVersion:1,dimensions:['user-goal','complexity','input-quality','system-state','risk'],rows:cases.map(c=>({id:c.case_id,family:c.family_id,goal:c.capability_id,complexity:{turns:c.execution.tasks.length,initialFiles:Object.keys(c.initial_state.files).length},inputQuality:c.mutation_type==='adversarial'?'untrusted-instruction-in-required-material':'well-formed-boundary-or-task',systemState:c.mutation_type==='permission'?'host-denied':c.execution.compaction?'committed-history-compaction':c.execution.kind==='conversation'?'same-session-corrections':'healthy',risk:c.risk_level,operator:c.mutation_type,leaf:c.title}))});
  await write('buckets.json',{schemaVersion:1,coverage:rows.map(r=>r.id),challenge:rows.map(r=>r.id),regression:[],gold:[],hidden:[],note:'Purpose views overlap; count cases and parent families separately.'});
  const markdown=['# 金种子受控变异 v1：人工审阅包',
    `${cases.length} 条派生候选，${new Set(rows.map(r=>r.family)).size} 个父种子家族，新增独立种子 0，未见留出题 0。基于冻结的 v${lock.version}。参考程序和反例由 AI 构造，不能代替人工验收。`,
    '逐条检查变异边界、公开要求、手工期望、父规则一致性及反例独立性；记录到 human-reviews.json，绑定本页每题 hash。',
    ...cases.map((c,i)=>[`## ${c.case_id}：${c.title}`,`父种子 ${c.seed_id}；family ${c.family_id}；upstreamFamily ${c.upstreamFamily??'无'}；operator ${c.mutation_type}；contentHash ${rows[i].contentHash}`,`GT 规则：${c.rule}`,`初始文件：\n\n~~~~json\n${JSON.stringify(c.initial_state.files,null,2)}\n~~~~`,...c.execution.tasks.map((t,j)=>`### 第 ${j+1} 轮\n\n${t.prompt}\n\n权限与判据：\n\n~~~~json\n${JSON.stringify({policy:t.executionPolicy,graders:t.graders},null,2)}\n~~~~\n\n参考步骤：\n\n~~~~json\n${JSON.stringify(c.execution.references[j],null,2)}\n~~~~`),...(c.addedTest?[`新增函数输入与手工期望：\n\n~~~~json\n${JSON.stringify(c.addedTest,null,2)}\n~~~~`]:[]),...(c.execution.compaction?[`固定历史摘要：\n\n~~~~json\n${JSON.stringify(c.execution.compaction,null,2)}\n~~~~`]:[]),`反例及必须保持通过的判据：\n\n~~~~json\n${JSON.stringify(c.negative_cases,null,2)}\n~~~~`].join('\n\n')),''].join('\n\n');
  await writeFile(resolve(directory,'review.md'),markdown,{mode:0o600});files['review.md']=sha(markdown);
  try {await writeFile(resolve(directory,'human-reviews.json'),JSON.stringify({schemaVersion:1,decisions:[]},null,2)+'\n',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  const sources=await sourceHashes();
  await writeJSON(resolve(directory,'manifest.json'),{schemaVersion:1,version:'1.0.0',parent:lock,files,sources});
  return {directory,cases:cases.length,families:new Set(rows.map(r=>r.family)).size,plannedModelTrials:cases.reduce((n,c)=>n+c.trial_protocol.modelTrials,0)};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await build()));
