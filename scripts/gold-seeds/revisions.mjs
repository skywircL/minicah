import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { contentHash } from '../../dist/src/json.js';
import { root, readJSON, sha } from './common.mjs';

export const revisionPath = 'evals/private/gold-seeds-v2/source/revisions.json';
const prefix = 'evals/private/gold-seeds-v2/archive/v2.3.1/';
const historicalPrefixes = ['evals/private/gold-seeds-v2/archive/v2.2.0/', 'evals/private/gold-seeds-v2/archive/v2.3.0/', prefix];
export async function semanticPaths() {
  const paths = ['package.json','package-lock.json','tsconfig.json'];
  async function walk(path) {
    for (const entry of await readdir(resolve(root,path),{withFileTypes:true})) {
      const next=`${path}/${entry.name}`;
      if(entry.isDirectory()) await walk(next);
      else if(entry.isFile() && entry.name.endsWith('.ts')) paths.push(next);
    }
  }
  await walk('src'); await walk('test');
  return paths.sort();
}
export function validateRevisions(revision, current, previousIndex) {
  assert.equal(revision.version,'2.3.2'); assert.equal(revision.previousVersion,'2.3.1');
  assert.equal(revision.archivePrefix,prefix);
  assert.deepEqual(current.map(s=>s.id).sort(),previousIndex.seeds.map(s=>s.id).sort(),'Repairs preserve existing seed identities');
  assert.equal(revision.cases.length,current.length);
  const seen=new Set();
  for(const row of revision.cases) {
    const spec=current.find(s=>s.id===row.caseId),previous=previousIndex.seeds.find(s=>s.id===row.caseId);
    assert.ok(spec && previous && !seen.has(row.caseId));seen.add(row.caseId);
    assert.equal(row.previousContentHash,previous.contentHash);
    assert.equal(row.authorHash,contentHash(spec),'Changed author contract needs an explicit revision record');
    assert.ok(row.reason && ['repair','clarification','evidence-update'].includes(row.classification));
    assert.equal(spec.capability,previous.capability);
  }
}
export async function loadRevisions(current) {
  const revision=await readJSON(resolve(root,revisionPath));
  for(const [path,hash] of Object.entries(revision.archiveFiles)) {
    assert.ok(historicalPrefixes.some(p=>path.startsWith(p)) && !path.includes('..'));
    assert.equal(sha(await readFile(resolve(root,path))),hash,`Changed historical archive: ${path}`);
  }
  const index=await readJSON(resolve(root,prefix,'index.json'));
  validateRevisions(revision,current,index);
  const previous=(await Promise.all(['agent-seeds','engineering-seeds'].map(name=>readJSON(resolve(root,prefix,`source/${name}.json`))))).flat();
  for(const row of revision.cases.filter(r=>r.classification==='evidence-update')) assert.deepEqual(current.find(s=>s.id===row.caseId),previous.find(s=>s.id===row.caseId));
  return {revision,previous};
}
export function revisionMarkdown(revision) {
  return '# v2.3.2 输出要求统一记录\n\n38 个 ID 保持不变；14 条 A 轨道题目的全部 16 个轮次统一使用合法 JSON 示例及仅 JSON 回复要求。系统提示先遵从用户指定的最终回复格式，未指定格式时才自然语言总结。业务期望、夹具、判据、参考解和反例保持不变。所有内容 hash 重新计算，旧人审不迁移。v2.3.1 的数据、代码、测试和文档保存在 archive/v2.3.1；该目录的 baseline-evidence.json 绑定修改前真实模型基线。此前 22/54 通过的成绩只属于 v2.3.1，本轮仅运行参考校准，不宣称真实模型成绩改善。本记录不代替复审。\n\n'
    +'| ID | 变更 | 修复及边界 |\n| --- | --- | --- |\n'
    +revision.cases.map(r=>`| [${r.caseId}](cases/${r.caseId}.json) | ${r.classification} | ${r.reason} |`).join('\n')+'\n';
}
