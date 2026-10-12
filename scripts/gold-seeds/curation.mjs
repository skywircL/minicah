import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { contentHash } from '../../dist/src/json.js';
import { root, readJSON, sha } from './common.mjs';
import { loadRevisions } from './revisions.mjs';

export const curationPath = 'evals/private/gold-seeds-v2/source/curation.json';
const archivePrefix = 'evals/private/gold-seeds-v2/archive/v2.1.0/';

export function validateCuration(curation, activeIds) {
  assert.equal(curation.schemaVersion, 1);
  assert.equal(curation.version, '2.2.0');
  const originals = new Set(curation.originalCaseIds);
  assert.equal(originals.size, 33);
  assert.equal(curation.entries.length, originals.size);
  const seen = new Set();
  for (const entry of curation.entries) {
    assert.ok(originals.has(entry.caseId) && !seen.has(entry.caseId), 'Missing or duplicate original decision');
    seen.add(entry.caseId);
    assert.ok(['retain', 'strengthen', 'replace'].includes(entry.decision));
    assert.ok(entry.reason && entry.activeCaseIds.length === 1);
    assert.ok(entry.activeCaseIds.every(id => activeIds.includes(id)), 'Replacement must be executable in the active corpus');
    if (entry.decision === 'replace') {
      assert.ok(!activeIds.includes(entry.caseId), 'Retired cases must not count as active seeds');
      assert.notEqual(entry.activeCaseIds[0], entry.caseId);
    } else assert.deepEqual(entry.activeCaseIds, [entry.caseId]);
    assert.ok(entry.previousCase.path.startsWith(archivePrefix) && !entry.previousCase.path.includes('..'));
    assert.equal(curation.archiveFiles[entry.previousCase.path], entry.previousCase.sha256);
    assert.equal(entry.addedChecks.length > 0, entry.decision === 'strengthen');
  }
  assert.deepEqual(activeIds.filter(id => !originals.has(id)).sort(), curation.activeAdditionsSinceOriginal.slice().sort());
  for (const [path, hash] of Object.entries(curation.archiveFiles)) {
    assert.ok(path.startsWith(archivePrefix) && !path.includes('..'), 'Archive must stay in its historical directory');
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
  return curation;
}

export async function loadCuration(agents, engineering, registry) {
  const current = new Map([...agents, ...engineering].map(spec => [spec.id, spec]));
  // The v2.2 selection is immutable history. Later repairs use stable IDs and
  // independently bound revision records, instead of inventing new seeds.
  await loadRevisions([...current.values()]);
  const selectedSpecs=(await Promise.all(['agent-seeds','engineering-seeds'].map(name=>readJSON(resolve(root,'evals/private/gold-seeds-v2/archive/v2.2.0/source',`${name}.json`))))).flat();
  const selected = new Map(selectedSpecs.map(spec=>[spec.id,spec]));
  const curation = validateCuration(await readJSON(resolve(root, curationPath)), [...current.keys()]);
  for (const [path, hash] of Object.entries(curation.archiveFiles)) {
    assert.equal(sha(await readFile(resolve(root, path))), hash, `Changed historical evidence: ${path}`);
  }
  const previous = new Map((await Promise.all(['agent-seeds', 'engineering-seeds'].map(name =>
    readJSON(resolve(root, archivePrefix, `source/${name}.json`))))).flat().map(spec => [spec.id, spec]));
  for (const entry of curation.entries) {
    const old = await readJSON(resolve(root, entry.previousCase.path));
    assert.equal(old.case_id, entry.caseId);
    assert.equal(contentHash(old), entry.previousCase.contentHash);
    if (entry.decision === 'retain') assert.deepEqual(selected.get(entry.caseId), previous.get(entry.caseId), 'Historical retained contracts must remain unchanged');
    if (entry.decision === 'strengthen') {
      const before = previous.get(entry.caseId), after = selected.get(entry.caseId);
      assert.deepEqual(after.checks, [...before.checks, ...entry.addedChecks], 'Strengthening must preserve old checks and add the recorded checks');
      assert.notDeepEqual(after.expected, before.expected, 'New checks need explicit expected-state assertions');
    }
    const binding = registry.bindings.find(b => b.caseId === entry.activeCaseIds[0]);
    assert.deepEqual(entry.sourceIds, binding?.sourceIds ?? [], 'Curation sources must match the active case provenance');
  }
  return curation;
}

export function curationMarkdown(curation) {
  const counts = Object.fromEntries(['retain','strengthen','replace'].map(d => [d, curation.entries.filter(e => e.decision === d).length]));
  const labels = {retain:'保留',strengthen:'补强',replace:'替换并归档'};
  return ['# 原 33 条候选的逐条取舍（v2.2）',
    '此表保留 v2.2 选题决定；当前版本的逐题修复见 [修复记录](revision-review.md)，保留编号不代表拒绝修订。',
    `保留 ${counts.retain} 条、补强 ${counts.strengthen} 条、替换 ${counts.replace} 条。活跃候选合计 38 条，旧题不重复计数。此表是选题记录，不是人工验收。`,
    '历史 v2.1 包、来源、工具和文档见 archive/v2.1.0；历史 hash 与当前 manifest 绑定。既有工程测试加入种子判据，不等于新增 Harness 实现。',
    ['| 原候选 | 决定 | 当前候选 | 原因 |', '| --- | --- | --- | --- |',
    ...curation.entries.map(e => `| [${e.caseId}](archive/v2.1.0/cases/${e.caseId}.json) | ${labels[e.decision]} | ${e.activeCaseIds.map(id => `[${id}](cases/${id}.json)`).join('、')} | ${e.reason} |`)].join('\n'),
    '\n## 补强的可执行判据',
    ...curation.entries.filter(e => e.decision === 'strengthen').map(e => `\n### ${e.caseId}\n\n${e.addedChecks.map(c => '- '+c.file+'：'+c.name).join('\n')}`),
    '\n未覆盖的边界：A2 新建文件及双模块同时写入的旧基础样例仅归档，不计活跃金种子；H1 上游内部 scheduler 异常的首错传播和全部 sibling drain 仍未复现；A3 未开放 Agent 自主命令验证。',
  ].join('\n\n')+'\n';
}
