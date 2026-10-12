import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, readJSON, sha } from './common.mjs';

export const provenancePath = 'evals/private/gold-seeds-v2/source/upstream-sources.json';
const snapshotPrefix = 'evals/private/gold-seeds-v2/source/upstream/';
export function validateProvenance(registry, seedIds) {
  assert.equal(registry.schemaVersion, 1);
  const records = new Map(), bindings = new Map(), families = new Map();
  for (const record of registry.records) {
    assert.ok(record.id && !records.has(record.id), 'Duplicate upstream source');
    assert.ok(['upstream-fix','upstream-release','benchmark-task'].includes(record.kind));
    assert.match(record.url, /^https:\/\//);
    assert.ok(record.summary && record.license && record.evidence.length > 0);
    if (record.kind === 'upstream-fix') {
      assert.match(record.fixCommit, /^[0-9a-f]{40}$/);
      assert.match(record.baseCommit, /^[0-9a-f]{40}$/);
    } else if (record.kind === 'benchmark-task') {
      assert.ok(record.taskId && record.dataset);
      assert.match(record.datasetRevision, /^[0-9a-f]{40}$/);
      assert.match(record.baseCommit, /^[0-9a-f]{40}$/);
    } else {
      assert.ok(record.releaseTag && record.releasedAt);
    }
    for (const evidence of record.evidence) {
      assert.ok(evidence.path.startsWith(snapshotPrefix) && !evidence.path.includes('..'), 'Evidence must be a local upstream snapshot');
      assert.match(evidence.sha256, /^[0-9a-f]{64}$/);
      assert.match(evidence.url, /^https:\/\//);
    }
    records.set(record.id, record);
  }
  for (const binding of registry.bindings) {
    assert.ok(seedIds.includes(binding.caseId) && !bindings.has(binding.caseId), 'Unknown or duplicate source binding');
    assert.ok(['upstream-regression','benchmark-derived','project-contract-corroborated'].includes(binding.origin));
    assert.ok(binding.sourceIds.length > 0 && new Set(binding.sourceIds).size === binding.sourceIds.length);
    assert.ok(binding.sourceIds.every(id => records.has(id)), 'Unknown upstream source');
    assert.ok(binding.adaptation && binding.upstreamFamily);
    // All descendants of an upstream issue/task stay in the same local family.
    const family = binding.familyId ?? binding.caseId;
    assert.ok(!families.has(binding.upstreamFamily) || families.get(binding.upstreamFamily) === family, 'An upstream family cannot be split into independent seeds');
    families.set(binding.upstreamFamily, family);
    if (binding.origin === 'benchmark-derived') assert.ok(binding.sourceIds.some(id => records.get(id).kind === 'benchmark-task'));
    if (binding.origin === 'upstream-regression') assert.ok(binding.sourceIds.some(id => records.get(id).kind === 'upstream-fix'), 'A release note alone is not an executable regression source');
    bindings.set(binding.caseId, binding);
  }
  for (const id of records.keys()) assert.ok(registry.bindings.some(b => b.sourceIds.includes(id)), 'Unused upstream source');
  return { records, bindings };
}

export async function loadProvenance(seedIds) {
  const registry = await readJSON(resolve(root, provenancePath));
  const validated = validateProvenance(registry, seedIds);
  for (const record of registry.records) for (const evidence of record.evidence) {
    assert.equal(sha(await readFile(resolve(root, evidence.path))), evidence.sha256, `Changed upstream evidence: ${evidence.path}`);
  }
  return { registry, ...validated };
}

export function attachProvenance(seed, { records, bindings }) {
  const binding = bindings.get(seed.case_id);
  seed.provenance = binding ? {
    origin: binding.origin, sourceIds: binding.sourceIds, upstreamFamily: binding.upstreamFamily,
    adaptation: binding.adaptation, upstreamReproduction: 'not-run',
  } : { origin: 'project-contract', sourceIds: [], upstreamFamily: null, adaptation: '依据 minicah 能力承诺构造；无外部真实故障出处。', upstreamReproduction: 'not-applicable' };
  if (!binding) return [];
  seed.family_id = binding.familyId ?? seed.case_id;
  const paths = [provenancePath];
  for (const id of binding.sourceIds) {
    const record = records.get(id);
    seed.sources.push({ id: `upstream-${id}`, reference: `${provenancePath}#${id}`, statement: record.summary });
    paths.push(...record.evidence.map(e => e.path));
  }
  seed.limitations.push('上游故障在 minicah 中按本项目契约改编；未执行上游仓库的修复前后复现，不声称 minicah 曾出现该故障。');
  if (binding.origin === 'benchmark-derived') seed.limitations.push('公开 benchmark 的缩小重写任务；不代表官方分数、原题难度或未见留出集。');
  return paths;
}
