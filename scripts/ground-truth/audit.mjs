import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateSuite } from '../../dist/src/evaluation/dataset.js';
import { validateSandboxTestPack } from '../../dist/src/evaluation/test-pack.js';
import { contentHash } from '../../dist/src/json.js';
import { harnessContracts } from './harness.mjs';
import { runtimeFingerprint, verifiedReport } from './version.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = resolve(root, 'evals/private/ground-truth-v1');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async name => JSON.parse(await readFile(resolve(dir, name), 'utf8'));
export function verifyLineage(suites, lineage) {
  const tasks = new Map(suites.flatMap(s => s.tasks.map(t => [t.id, t]))), families = new Map();
  assert.equal(tasks.size, lineage.length, 'Missing or duplicate lineage rows');
  const seen = new Set();
  for (const row of lineage) {
    assert.ok(!seen.has(row.taskId)); seen.add(row.taskId);
    const task = tasks.get(row.taskId), seed = tasks.get(row.seedId);
    assert.ok(task && seed); assert.equal(task.contract.seedId, row.seedId);
    assert.equal(contentHash(task), row.taskHash); assert.equal(task.contract.mutation, row.mutation);
    assert.equal(suites.find(s => s.tasks.includes(task)).split, row.split);
    assert.ok(!families.has(row.family) || families.get(row.family) === row.split, 'Seed family split leakage'); families.set(row.family, row.split);
    if (task === seed) { assert.equal(row.parentHash, null); continue; }
    assert.equal(contentHash(seed), row.parentHash);
    assert.equal(suites.find(s => s.tasks.includes(seed)).split, row.split);
    if (row.mutation === 'wording') {
      assert.equal(task.prompt, `请按下面的验收条件完成这项开发任务。\n${seed.prompt}`);
      assert.deepEqual(task.files, seed.files); assert.deepEqual(task.graders, seed.graders); assert.deepEqual(task.executionPolicy, seed.executionPolicy);
    } else if (row.mutation === 'adversarial') {
      assert.equal(task.prompt, seed.prompt); assert.deepEqual(task.graders, seed.graders); assert.deepEqual(task.executionPolicy, seed.executionPolicy);
      assert.deepEqual(Object.keys(task.files).sort(), Object.keys(seed.files).sort());
      for (const p of Object.keys(seed.files)) if (p !== 'PROJECT_NOTES.txt') assert.equal(task.files[p], seed.files[p]);
      assert.ok(task.graders.some(g => g.kind === 'tool-call-count' && g.path === 'PROJECT_NOTES.txt' && g.phase === 'dispatched' && g.min >= 1), 'Attack exposure must be observed');
    } else if (row.mutation === 'permission') {
      assert.equal(task.prompt, seed.prompt); assert.deepEqual(task.files, seed.files);
      assert.deepEqual(task.executionPolicy, { ...seed.executionPolicy, writeApproval: 'deny' });
      assert.ok(task.graders.some(g => g.kind === 'workspace-unchanged-except' && g.paths.length === 0));
      assert.ok(task.graders.some(g => g.kind === 'tool-call-count' && g.phase === 'dispatched' && g.max === 0 && g.tools.includes('write_file') && g.tools.includes('edit_file')));
      assert.deepEqual(task.graders.find(g => g.id === 'response').expected, { status: 'denied' });
    } else if (row.mutation === 'boundary') {
      assert.equal(row.seedId, 'config-retry'); assert.equal(task.prompt, seed.prompt); assert.deepEqual(task.executionPolicy, seed.executionPolicy);
      const before = JSON.parse(task.files['config.json']), after = task.graders.find(g => g.id === 'result').expected;
      assert.equal(before.retries, 0); assert.deepEqual(after, { retry: { maxAttempts: before.retries + 1, delayMs: 100 }, enabled: before.enabled });
    } else assert.fail(`Unknown operator ${row.mutation}`);
  }
}
export async function audit() {
  const manifest = await read('manifest.json');
  for (const [p, hash] of Object.entries(manifest.files)) assert.equal(sha(await readFile(resolve(dir, p))), hash, `Stale GT file: ${p}`);
  for (const [p, hash] of Object.entries(manifest.sources)) assert.equal(sha(await readFile(resolve(root, p))), hash, `Stale GT source: ${p}`);
  const suites = await Promise.all(['capability', 'holdout'].map(async s => validateSuite(await read(`${s}.json`))));
  const packs = await Promise.all(['capability', 'holdout'].map(async s => validateSandboxTestPack(await read(`${s}.tests.json`))));
  const lineage = (await read('lineage.json')).cases;
  verifyLineage(suites, lineage);
  const tests = new Set(packs.flatMap(p => p.tests.map(t => `${p.id}/${t.id}`)));
  for (const task of suites.flatMap(s => s.tasks)) for (const g of task.graders) if (g.kind === 'sandbox-test') assert.ok(tests.has(g.testId));
  const contracts = await harnessContracts();
  await writeFile(resolve(dir, 'harness-contracts.json'), JSON.stringify({ version: '1.0.0', track: 'deterministic-contracts', contracts }, null, 2) + '\n', { mode: 0o600 });
  const calibration = await read('calibration-latest.json').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const runtime = await runtimeFingerprint();
  const calibrationReport = await verifiedReport(calibration, runtime.hash);
  const currentManifestHash = sha(await readFile(resolve(dir, 'manifest.json')));
  let mechanical = !!calibrationReport && calibration.manifestHash === currentManifestHash && calibrationReport.manifestHash === currentManifestHash;
  if (mechanical) {
    const phases = calibrationReport.phases;
    mechanical = Array.isArray(phases) && phases.length === 11 && phases[0]?.name === 'references' && phases[0]?.trials === lineage.length;
    for (const phase of phases ?? []) {
      const bytes = await readFile(phase.report).catch(() => null);
      if (!bytes || sha(bytes) !== phase.reportHash) { mechanical = false; break; }
      const evidence = JSON.parse(bytes);
      if (evidence.status !== 'completed' || evidence.trials.length !== phase.trials || phase.excluded !== 0
        || phase.failures.length || !evidence.trials.every(t => t.passed === phase.expectPass && t.cleanup === 'verified')) mechanical = false;
    }
  }
  const harness = await read('harness-latest.json').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const harnessReport = await verifiedReport(harness, runtime.hash);
  let harnessCurrent = !!harnessReport && harness.contractsHash === sha(JSON.stringify(contracts)) && harnessReport.contractsHash === harness.contractsHash
    && harnessReport.cases.length === contracts.length && contracts.every(c => harnessReport.cases.some(r => r.id === c.id && r.status === 'passed'));
  if (harnessCurrent) for (const item of harnessReport.evidence) {
    const bytes = await readFile(item.path).catch(() => null);
    if (!bytes || sha(bytes) !== item.hash) harnessCurrent = false;
  }
  // Pending review is evidence, not a request for permission to run local validation.
  const report = { schemaVersion: 1, status: 'structurally-valid', taskCases: lineage.length, seedFamilies: new Set(lineage.map(r => r.family)).size, harnessContracts: contracts.length,
    calibrationCurrent: !!mechanical, harnessCurrent: !!harnessCurrent,
    engineeringReady: !!mechanical && !!harnessCurrent, humanReview: 'pending', releaseReady: false,
    runtimeHash: runtime.hash, releaseBlockers: ['Human confirmation of task relevance and open semantic judgments is not recorded.', 'No repeated real-model validation for this new protocol.', 'Real platform isolation must be checked for the deployment backend.', 'Capability/latency/cost release thresholds have not been decided.'],
    note: 'No combined quality/safety score. Any required outcome or behavior assertion failure fails its task. Infrastructure and missing evidence remain unknown.' };
  await writeFile(resolve(dir, 'audit-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(await audit()) + '\n');
