import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build, materialize, reviseCase, sha, sourceDirectory } from './build-flywheel-dataset.mjs';
import { executeConversation } from '../gold-seeds/conversation.mjs';
import { referenceModel } from '../gold-seeds/reference.mjs';
import { EvaluationRunner } from '../../dist/src/evaluation/index.js';
import { createCodingTrialExecutor } from '../../dist/src/evaluation/coding-executor.js';

const data = await materialize();
const get = id => data.cases.find(seed => seed.case_id === id);
const temp = async t => { const path = await mkdtemp(resolve(tmpdir(), 'flywheel-contract-')); t.after(() => rm(path, {recursive: true, force: true})); return path; };

test('all 150 tasks preserve fixtures, graders, references, policies and repeat counts; only 34 related cases change', () => {
  assert.equal(data.cases.length, 150);
  assert.equal(data.cases.filter(seed => seed.flywheelRevision).length, 34);
  for (const [i, seed] of data.cases.entries()) {
    const previous = data.originals[i];
    assert.deepEqual(seed.initial_state, previous.initial_state);
    assert.deepEqual(seed.execution.references, previous.execution.references);
    assert.deepEqual(seed.negative_cases, previous.negative_cases);
    assert.deepEqual(seed.trial_protocol, previous.trial_protocol);
    for (const [turn, task] of seed.execution.tasks.entries()) {
      assert.deepEqual(task.graders, previous.execution.tasks[turn].graders);
      assert.deepEqual(task.executionPolicy, previous.execution.tasks[turn].executionPolicy);
      if (seed.flywheelRevision) assert.equal(task.contract.sources.find(s => s.id === 'task').statement, task.prompt);
    }
    if (!seed.flywheelRevision) assert.deepEqual(seed, previous);
  }
});

test('family-wide public contracts clarify root-only migration, every-turn no-op reads, and read_file snapshots', () => {
  for (const seed of data.cases.filter(s => s.flywheelRevision)) {
    assert.equal(seed.review.status, 'pending');
    for (const task of seed.execution.tasks) {
      assert.match(task.prompt, /read_file/); assert.match(task.prompt, /完整内容和 hash/);
      assert.match(task.prompt, /即使请求值已满足、无需修改/);
      if (seed.family_id === 'GS-A2-02') assert.match(task.prompt, /嵌套对象及数组中的 retries 不迁移/);
    }
  }
});

test('clarification is independent of hidden graders and references, and compaction receives no new goal values', () => {
  for (const original of data.originals.filter(s => ['GS-A2-02', 'GS-A5-01', 'GS-A5-02'].includes(s.family_id))) {
    const copy = structuredClone(original);
    copy.execution.references = [{privateSentinel: 'SECRET_EXPECTED_RESULT'}];
    copy.execution.tasks.forEach(task => { task.graders = [{privateSentinel: 'SECRET_EXPECTED_RESULT'}]; });
    const changed = reviseCase(copy), real = get(original.case_id);
    assert.deepEqual(changed.execution.tasks.map(t => t.prompt), real.execution.tasks.map(t => t.prompt));
    assert.deepEqual(changed.execution.compaction, real.execution.compaction);
    if (real.execution.compaction) {
      const suffix = real.execution.compaction.text.slice(original.execution.compaction.text.length);
      assert.ok(!/\d/.test(suffix)); assert.ok(!suffix.includes('SECRET_EXPECTED_RESULT'));
    }
  }
});

test('120 immutable failures map to 197 unique same-case historical success controls, and none are marked fixed', () => {
  const pool = data.pool; assert.equal(pool.failureCount, 120); assert.equal(pool.affectedCases, 51);
  const controls = new Set(pool.records.flatMap(row => row.successControls.map(c => `${c.caseId}-${c.repetition}`)));
  assert.equal(controls.size, 197);
  assert.equal(pool.records.filter(row => row.observation.category.startsWith('gt-')).length, 17);
  for (const row of pool.records) {
    assert.equal(row.closure.status, 'open'); assert.equal(row.regression.status, 'not-run');
    assert.equal(row.regression.finalPassed, null); assert.equal(row.revision.implementationVersion, null);
    assert.equal(row.humanReview, 'pending'); assert.equal(row.attribution.causalClaim, null);
    assert.ok(row.evidence.trialReport); assert.ok(row.evidence.journal);
    assert.ok(row.successControls.every(c => c.caseId === row.caseId));
  }
  assert.equal(pool.records.find(r => r.caseId === 'GM-D19').successControlStatus, 'no-historical-same-case-success');
});

test('build is reproducible, preserves 116 original case bytes and leaves human decisions intact', async t => {
  const output = await temp(t); const result = await build({output}); assert.equal(result.revised, 34);
  for (const [i, seed] of data.cases.entries()) if (!seed.flywheelRevision) {
    const file = data.index.cases[i].file;
    assert.equal(sha(await readFile(resolve(output, file))), sha(await readFile(resolve(sourceDirectory, file))));
  }
  const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json')));
  for (const [path, hash] of Object.entries(manifest.files)) assert.equal(sha(await readFile(resolve(output, path))), hash);
  const ledger = JSON.stringify({schemaVersion: 1, decisions: [{status: 'pending', comment: 'test-only existing review note'}]});
  await writeFile(resolve(output, 'human-reviews.json'), ledger); await build({output});
  assert.equal(await readFile(resolve(output, 'human-reviews.json'), 'utf8'), ledger);
  await writeFile(resolve(output, 'case-pool.json'), '{}');
  await assert.rejects(build({output}), /Refusing to replace existing artifact/);
  await assert.rejects(build({output: sourceDirectory}), /Cannot overwrite/);
});

test('root-only reference passes; recursively migrating nested retries fails the actual frozen outcome grader', async t => {
  const output = await temp(t), seed = get('GM-B17'), runner = new EvaluationRunner(); t.after(() => runner.close());
  const run = async recursive => {
    const reference = structuredClone(seed.execution.references[0]);
    if (recursive) {
      const dev = JSON.parse(reference.files['dev.json']);
      dev.child.retry = {maxAttempts: dev.child.retries + 1, delayMs: 100}; delete dev.child.retries;
      reference.files['dev.json'] = JSON.stringify(dev) + '\n';
    }
    return runner.run({schemaVersion: 1, id: 'flywheel-migration-calibration', version: '1.0.0', split: 'regression', tasks: seed.execution.tasks},
      createCodingTrialExecutor({allowWrites: true, modelFactory: () => referenceModel(seed.execution.tasks[0], reference)}), {outputDirectory: output, repetitions: 1, concurrency: 1});
  };
  const good = (await run(false)).trials[0], bad = (await run(true)).trials[0];
  assert.equal(good.passed, true); assert.equal(bad.passed, false);
  assert.deepEqual(bad.graders.filter(g => g.status !== 'passed').map(g => g.id), ['result-dev']);
});

for (const id of ['GM-D10', 'GM-D23']) test(`${id}: no-op with fresh read passes; a silent completed response fails only the read criterion`, async t => {
  const output = await temp(t), seed = get(id);
  const good = await executeConversation(seed, resolve(output, 'good'));
  assert.equal(good.passed, true);
  let stage = 0;
  const bad = await executeConversation(seed, resolve(output, 'bad'), {modelFactory: task => {
    const reference = structuredClone(seed.execution.references[stage]);
    if (stage++ === 2) { reference.mode = 'read'; reference.files = {}; reference.readPaths = []; }
    return referenceModel(task, reference);
  }});
  assert.equal(bad.passed, false); assert.equal(bad.turns[2].graders.find(g => g.id === 'result').status, 'passed');
  assert.deepEqual(bad.turns[2].graders.filter(g => g.status !== 'passed').map(g => g.id), ['read-0']);
});

test('GM-D28: full read_file snapshots pass; complete one-line search hits alone fail explicit snapshot requirements', async t => {
  const output = await temp(t), seed = get('GM-D28');
  const good = await executeConversation(seed, resolve(output, 'good')); assert.equal(good.passed, true);
  let stage = 0;
  const bad = await executeConversation(seed, resolve(output, 'bad'), {modelFactory: task => {
    const reference = referenceModel(task, seed.execution.references[stage]);
    if (stage++ !== 0) return reference;
    let called = false;
    return {...reference, async complete() {
      if (!called) { called = true; return {message: {role: 'assistant', content: null, tool_calls: [{id: 'search-only', type: 'function', function: {name: 'search_text', arguments: JSON.stringify({query: 'timeout'})}}]}, finishReason: 'tool_calls', usage: null, providerId: 'search-only'}; }
      return {message: {role: 'assistant', content: '{"status":"ready"}'}, finishReason: 'stop', usage: null, providerId: 'search-done'};
    }};
  }});
  assert.equal(bad.passed, false);
  assert.deepEqual(bad.turns[0].graders.filter(g => g.status !== 'passed').map(g => g.id), ['read-0', 'read-1']);
  assert.ok(bad.turns.slice(1).every(turn => turn.passed));
});
