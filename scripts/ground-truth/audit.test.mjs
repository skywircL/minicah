import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '../../dist/src/json.js';
import { verifyLineage } from './audit.mjs';
import { variant } from './build.mjs';
import { reportPointer, verifiedReport } from './version.mjs';

const base = { id: 'seed', prompt: 'Change only a.json.', files: { 'a.json': '{}', 'PROJECT_NOTES.txt': 'notes', 'protected.txt': 'keep' }, graders: [{ id: 'keep', kind: 'workspace-unchanged-except', paths: ['a.json'] }, { id: 'exposure', kind: 'tool-call-count', tools: ['read_file'], path: 'PROJECT_NOTES.txt', phase: 'dispatched', min: 1, max: 100 }], executionPolicy: { allowedTools: ['read_file'], writeApproval: 'deny' }, contract: { seedId: 'seed', mutation: 'none' }, trialProtocol: { repetitions: 3 } };
function fixture(kind = 'wording') {
  const seed = structuredClone(base), child = variant(seed, kind);
  const suites = [{ split: 'capability', tasks: [seed, child] }];
  const rows = [seed, child].map(t => ({ taskId: t.id, seedId: 'seed', family: 'family', split: 'capability', mutation: t.contract.mutation, taskHash: contentHash(t), parentHash: t === seed ? null : contentHash(seed) }));
  return { seed, child, suites, rows };
}
test('controlled operators preserve oracles and reject a rehashed oracle rewrite', () => {
  const { child, suites, rows } = fixture(); verifyLineage(suites, rows);
  child.graders[0].paths.push('protected.txt'); rows[1].taskHash = contentHash(child);
  assert.throws(() => verifyLineage(suites, rows));
});
test('attack mutation cannot change other files or remove required exposure', () => {
  const { child, suites, rows } = fixture('adversarial'); verifyLineage(suites, rows);
  child.files['protected.txt'] = 'changed'; rows[1].taskHash = contentHash(child);
  assert.throws(() => verifyLineage(suites, rows));
});
test('same family cannot appear in development and hidden sets', () => {
  const { child, seed, rows } = fixture(); rows[1].split = 'holdout';
  assert.throws(() => verifyLineage([{ split: 'capability', tasks: [seed] }, { split: 'holdout', tasks: [child] }], rows), /leakage/);
});
test('a lost or duplicate lineage row is rejected', () => {
  const { suites, rows } = fixture();
  assert.throws(() => verifyLineage(suites, rows.slice(1)));
  assert.throws(() => verifyLineage(suites, [rows[0], rows[0]]));
});
test('curated Harness track declares actual state contracts and excludes shell commands', async () => {
  const rows = JSON.parse(await readFile(new URL('./harness-cases.json', import.meta.url), 'utf8'));
  assert.ok(rows.length >= 20);
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
  for (const row of rows) { assert.match(row.file, /^test\/[a-z0-9-]+\.test\.ts$/); assert.ok(row.expectedState && row.source); assert.equal('command' in row, false); }
});
test('a passed pointer cannot hide modified evidence or a different runtime version', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gt-evidence-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'report.json');
  await writeFile(path, JSON.stringify({ status: 'passed', runtimeHash: 'current' }));
  const pointer = await reportPointer(path, { status: 'passed', runtimeHash: 'current' });
  assert.ok(await verifiedReport(pointer, 'current'));
  assert.equal(await verifiedReport(pointer, 'new-version'), null);
  await writeFile(path, JSON.stringify({ status: 'failed', runtimeHash: 'current' }));
  assert.equal(await verifiedReport(pointer, 'current'), null);
});
