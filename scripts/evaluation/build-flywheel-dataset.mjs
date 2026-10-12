import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../../dist/src/json.js';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const sourceDirectory = resolve(root, 'evals/private/gold-mutations-v2');
export const directory = resolve(root, 'evals/private/gold-flywheel-v1');
export const baselineDirectory = resolve(root, '.minicah/gold-expansion-baselines/baseline-FxEhmE');
export const version = '1.0.0';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const migrationFamily = 'GS-A2-02';
const dialogueFamilies = new Set(['GS-A5-01', 'GS-A5-02']);
export const migrationRule = '迁移范围仅限每个文件的根对象：只删除顶层 retries 并新增顶层 retry；嵌套对象及数组中的 retries 不迁移，其他字段和值保持不变。';
export const freshReadRule = paths => `本轮必须先用 read_file 分别读取 ${paths.join('、')}，取得当前完整内容和 hash；即使请求值已满足、无需修改，也必须完成本轮读取核实。搜索命中、之前轮次的读取或摘要不能替代本轮完整快照。`;

// These paths are a public contract of the existing tasks, never grader output.
function publicReadPaths(seed, turn) {
  const initial = seed.execution.tasks[0].prompt;
  if (seed.family_id === migrationFamily) {
    assert.match(initial, /迁移 dev\.json 与 prod\.json/);
    return ['dev.json', 'prod.json'];
  }
  assert.match(initial, /dev\.json/);
  if (seed.family_id === 'GS-A5-02' && turn === 0) {
    assert.match(initial, /读取 dev\.json 和 prod\.json/);
    return ['dev.json', 'prod.json'];
  }
  return ['dev.json'];
}

export function reviseCase(original) {
  if (original.family_id !== migrationFamily && !dialogueFamilies.has(original.family_id)) return structuredClone(original);
  const seed = structuredClone(original);
  const decisions = original.family_id === migrationFamily
    ? ['root-only-migration', 'explicit-read-file-snapshot']
    : ['fresh-read-including-noop', 'explicit-read-file-snapshot'];
  const changes = [];
  for (const [i, task] of seed.execution.tasks.entries()) {
    const clauses = [];
    if (seed.family_id === migrationFamily) clauses.push(migrationRule);
    clauses.push(freshReadRule(publicReadPaths(original, i)));
    task.prompt += '\n' + clauses.join('\n');
    const taskSource = task.contract.sources.find(source => source.id === 'task');
    assert.ok(taskSource, `${seed.case_id} must declare its public task source`);
    Object.assign(taskSource, {reference: `evals/private/gold-flywheel-v1/cases/${seed.case_id}.json#execution.tasks[${i}].prompt`, version, statement: task.prompt});
    task.contract.sources.push({id: 'flywheel-clarification', reference: 'docs/evaluation-flywheel-gt.md', version, statement: clauses.join('\n')});
    for (const assertion of task.contract.assertions) assertion.sourceIds.push('flywheel-clarification');
    changes.push({turn: i + 1, taskId: task.id, beforePromptHash: sha(original.execution.tasks[i].prompt), afterPromptHash: sha(task.prompt), decisions});
  }
  if (seed.execution.compaction) {
    // Only persistent rules already made public are added. No next-turn goal or answer.
    seed.execution.compaction.text += '\n持续读取约束：每轮先用 read_file 获取本轮目标的当前完整内容和 hash，即使请求值已满足也要核实；摘要不能替代本轮读取。';
  }
  seed.review = {status: 'pending', authorKind: 'AI-assisted'};
  seed.flywheelRevision = {dataset: 'gold-flywheel-v1', version, sourceCaseContentHash: contentHash(original), decisions, changes, gradersChanged: false, referencesChanged: false, historicalTrialsRegraded: false};
  return seed;
}

const candidates = {
  'outcome-no-write': ['public-completion-state-check', 'bounded-continuation', 'latest-task-after-summary'],
  'incorrect-write': ['complete-public-contract-review', 'consumer-interface-regression'],
  'approval-flow': ['tool-error-vs-denial-evidence', 'bounded-argument-correction'],
  'response-only': ['public-response-schema-check', 'location-evidence-check'],
  'gt-migration-scope': ['root-only-migration'],
  'gt-noop-read': ['fresh-read-including-noop'],
  'gt-reading-tool': ['explicit-read-file-snapshot'],
};
const localReference = path => relative(root, resolve(path));
export function buildCasePool(catalog, baseline, baselineHash) {
  assert.equal(catalog.baselineHash, baselineHash, 'Catalog must refer to the frozen baseline');
  assert.equal(baseline.trials.length, 858);
  const failed = baseline.trials.filter(trial => trial.passed === false);
  assert.equal(failed.length, 120);
  assert.equal(catalog.trials.length, failed.length);
  const observed = new Set();
  const records = catalog.trials.map(item => {
    const key = `${item.caseId}-r${item.repetition}`;
    assert.ok(!observed.has(key), `Duplicate failure ${key}`); observed.add(key);
    const trial = failed.find(t => t.taskId === item.caseId && t.repetition === item.repetition);
    assert.ok(trial, `Catalog contains a non-failure ${key}`);
    assert.ok(candidates[item.category], `Unrecognized category ${item.category}`);
    const controls = baseline.trials.filter(t => t.taskId === item.caseId && t.passed === true);
    const ambiguity = item.category.startsWith('gt-');
    return {
      id: key, caseId: item.caseId, repetition: item.repetition, turn: item.turn,
      observation: {category: item.category, categoryLabel: catalog.categoryNames[item.category], failedGraders: item.failedGraders, facts: item.observations},
      evidence: {baselineReport: '.minicah/gold-expansion-baselines/baseline-FxEhmE/report.json', baselineHash,
        trialReport: localReference(item.sourceReport), journal: localReference(item.journal), finalEventSeq: item.finalEventSeq,
        readableTrial: `docs/evaluation-failures/trials/${key}.md`},
      attribution: {status: ambiguity ? 'contract-clarified-for-new-version-historical-adjudication-pending' : 'observed-mechanism-causal-attribution-pending', confidence: 'observed-trace-only', causalClaim: null},
      proposedFixes: candidates[item.category],
      revision: {dataset: 'gold-flywheel-v1', changedContract: ambiguity, implementationVersion: null},
      regression: {status: 'not-run', firstAttemptPassed: null, finalPassed: null, report: null},
      successControls: controls.map(t => ({caseId: t.taskId, repetition: t.repetition, report: localReference(t.report), historicalPassed: true})),
      successControlStatus: controls.length ? 'historical-same-case-controls-available' : 'no-historical-same-case-success',
      humanReview: 'pending', closure: {status: 'open', closedAt: null, reason: null},
    };
  });
  return {schemaVersion: 1, version, dataset: 'gold-flywheel-v1', sourceDataset: 'gold-mutations-v2@2.0.0', baselineHash,
    failureCount: records.length, affectedCases: new Set(records.map(r => r.caseId)).size,
    historicalCounts: catalog.counts, records,
    policy: 'Historical evidence is immutable. Implementation, rerun, and human decisions must be recorded separately; a proposed fix does not close a case.'};
}

export async function materialize({source = sourceDirectory, baselinePath = baselineDirectory} = {}) {
  const manifestBytes = await readFile(resolve(source, 'manifest.json')), manifest = JSON.parse(manifestBytes);
  const blobs = {};
  for (const [path, hash] of Object.entries(manifest.files)) {
    const bytes = await readFile(resolve(source, path));
    assert.equal(sha(bytes), hash, `Frozen source changed: ${path}`);
    blobs[path] = bytes;
  }
  const index = JSON.parse(blobs['index.json']);
  const originals = index.cases.map(row => {
    const seed = JSON.parse(blobs[row.file]); assert.equal(contentHash(seed), row.contentHash); return seed;
  });
  const cases = originals.map(reviseCase);
  const reportBytes = await readFile(resolve(baselinePath, 'report.json'));
  const catalog = JSON.parse(await readFile(resolve(baselinePath, 'badcase-catalog-v1.json')));
  assert.equal(sha(reportBytes), '38f93b90fe8d12cae304a7adfb6a9691aab78cbe7fc3c7bc41348f1c469a2153', 'Historical score report must remain frozen');
  const pool = buildCasePool(catalog, JSON.parse(reportBytes), sha(reportBytes));
  for (const record of pool.records) {
    const seed = cases.find(item => item.case_id === record.caseId);
    record.revision.changedContract = Boolean(seed.flywheelRevision);
    record.revision.caseContentHash = contentHash(seed);
  }
  return {manifestHash: sha(manifestBytes), index, originals, cases, blobs, pool, baselineHash: sha(reportBytes), catalogHash: sha(await readFile(resolve(baselinePath, 'badcase-catalog-v1.json')))};
}

export async function build({output = directory} = {}) {
  assert.notEqual(resolve(output), sourceDirectory, 'Cannot overwrite the historical dataset');
  const data = await materialize(), {cases, index, originals, blobs, pool} = data;
  const artifacts = {};
  const put = (name, value) => { artifacts[name] = Buffer.isBuffer(value) ? value : Buffer.from(json(value)); };
  const revised = cases.filter(seed => seed.flywheelRevision);
  assert.equal(cases.length, 150); assert.equal(revised.length, 34);
  for (const [i, seed] of cases.entries()) put(index.cases[i].file, seed.flywheelRevision ? seed : blobs[index.cases[i].file]);
  const rows = cases.map((seed, i) => ({...index.cases[i], contentHash: contentHash(seed), origin: seed.flywheelRevision ? 'public-contract-clarification' : 'byte-preserved-v2', sourceContentHash: contentHash(originals[i])}));
  put('index.json', {schemaVersion: 1, id: 'gold-flywheel-v1', version, status: 'derived-candidates', sourceVersion: '2.0.0', caseCount: 150,
    revisedCases: 34, unchangedCases: 116, parentFamilies: 10, newIndependentSeeds: 0, hiddenCases: 0, cases: rows});
  for (const name of ['parent.tests.json', 'prior.tests.json', 'boundary.tests.json']) put(name, blobs[name]);
  put('agent-suite.json', {schemaVersion: 1, id: 'gold-flywheel-v1-single-turn', version, split: 'capability', tasks: cases.filter(s => s.execution.kind === 'coding').map(s => s.execution.tasks[0])});
  put('conversations.json', {schemaVersion: 1, cases: cases.filter(s => s.execution.kind === 'conversation').map(s => ({id: s.case_id, file: `cases/${s.case_id}.json`, turns: s.execution.tasks.length}))});
  put('lineage.json', {schemaVersion: 1, sourceManifestHash: data.manifestHash, sourceDataset: 'gold-mutations-v2@2.0.0', cases: rows,
    note: 'All 150 cases remain exposed gold_dev descendants; no new independent or held-out families.'});
  put('contract-decisions.json', {schemaVersion: 1, version, status: 'implemented-public-contract-clarifications', humanReview: 'pending',
    historicalAdjudication: 'pending-no-regrading', gradersChanged: false, fixturesChanged: false, referencesChanged: false,
    cases: revised.map(seed => ({id: seed.case_id, family: seed.family_id, ...seed.flywheelRevision}))});
  put('case-pool.json', pool);
  put('buckets.json', {schemaVersion: 1, coverage: rows.map(r => r.id), regressionCandidates: [...new Set(pool.records.map(r => r.caseId))],
    regression: [], humanGold: [], hidden: [], note: 'Candidates become confirmed regressions only after a recorded fix and passing rerun.'});
  const files = Object.fromEntries(Object.entries(artifacts).map(([path, bytes]) => [path, sha(bytes)]));
  const sourceFiles = ['scripts/evaluation/build-flywheel-dataset.mjs', 'scripts/evaluation/build-flywheel-dataset.test.mjs', 'docs/evaluation-flywheel-gt.md'];
  const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, sha(await readFile(resolve(root, path)))])));
  put('manifest.json', {schemaVersion: 1, id: 'gold-flywheel-v1', version, files, sources,
    source: {directory: 'evals/private/gold-mutations-v2', manifestHash: data.manifestHash}, baseline: {hash: data.baselineHash, catalogHash: data.catalogHash},
    humanReview: 'pending', releaseReady: false, runtimeFingerprintPolicy: 'Bind runtime separately in every evaluation report; dataset review is bound to dataset content.'});
  // Identical builds are safe. Never silently overwrite later evidence or reviews.
  for (const [path, bytes] of Object.entries(artifacts)) {
    const destination = resolve(output, path); await mkdir(dirname(destination), {recursive: true, mode: 0o700});
    try { await writeFile(destination, bytes, {flag: 'wx', mode: 0o600}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(sha(await readFile(destination)), sha(bytes), `Refusing to replace existing artifact: ${destination}`); }
  }
  try { await writeFile(resolve(output, 'human-reviews.json'), json({schemaVersion: 1, decisions: []}), {flag: 'wx', mode: 0o600}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return {directory: output, cases: cases.length, revised: revised.length, unchanged: 116, failures: pool.failureCount, humanReview: 'pending', modelApiCalls: 0};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await build()));
