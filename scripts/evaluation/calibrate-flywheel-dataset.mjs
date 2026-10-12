import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Runtime, createSandboxTestPackPlugin, createSandboxTestPlugin, sandboxTestService } from '../../dist/src/index.js';
import { contentHash } from '../../dist/src/json.js';
import { EvaluationRunner } from '../../dist/src/evaluation/index.js';
import { createCodingTrialExecutor } from '../../dist/src/evaluation/coding-executor.js';
import { referenceModel, referenceWithFault } from '../gold-seeds/reference.mjs';
import { executeConversation } from '../gold-seeds/conversation.mjs';
import { calibrationScenarios } from '../gold-seeds/scenarios.mjs';
import { directory, root, sha } from './build-flywheel-dataset.mjs';

async function dataset() {
  const bytes = await readFile(resolve(directory, 'manifest.json')), manifest = JSON.parse(bytes);
  const files = {};
  for (const [path, hash] of Object.entries(manifest.files)) {
    const data = await readFile(resolve(directory, path)); assert.equal(sha(data), hash, `Dataset changed: ${path}`); files[path] = data;
  }
  const index = JSON.parse(files['index.json']);
  const cases = index.cases.map(row => { const seed = JSON.parse(files[row.file]); assert.equal(contentHash(seed), row.contentHash); return seed; });
  return {hash: sha(bytes), cases, packs: ['parent.tests.json', 'prior.tests.json', 'boundary.tests.json'].map(path => JSON.parse(files[path]))};
}
async function runtimeFingerprint() {
  const files = {};
  async function walk(path) {
    for (const item of (await readdir(path, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = resolve(path, item.name);
      if (item.isDirectory()) await walk(child);
      else if (item.name.endsWith('.js')) files[relative(root, child)] = sha(await readFile(child));
    }
  }
  await walk(resolve(root, 'dist/src'));
  for (const path of ['package-lock.json', 'scripts/gold-seeds/conversation.mjs', 'scripts/gold-seeds/reference.mjs', 'scripts/gold-seeds/scenarios.mjs', 'scripts/evaluation/calibrate-flywheel-dataset.mjs']) files[path] = sha(await readFile(resolve(root, path)));
  return {hash: sha(JSON.stringify(files)), node: process.version, files};
}
function verify(trial, scenario) {
  assert.equal(trial.cleanup, 'verified'); assert.equal(trial.passed, !scenario.negative);
  assert.ok(trial.graders.length && trial.graders.every(g => ['passed', 'failed'].includes(g.status)), 'Oracle errors are not calibrated failures');
  if (!scenario.negative) assert.ok(trial.graders.every(g => g.status === 'passed'));
  for (const id of scenario.override?.expectedFailedGraders ?? []) assert.ok(trial.graders.some(g => g.id === id && g.status === 'failed'), `Missing intended failure: ${id}`);
  for (const id of scenario.override?.expectedPassedGraders ?? []) assert.ok(trial.graders.some(g => g.id === id && g.status === 'passed'), `Unrelated grader regressed: ${id}`);
}
export async function calibrate({sandbox = 'native', image} = {}) {
  const source = await dataset(), fingerprint = await runtimeFingerprint();
  const parent = resolve(root, '.minicah/flywheel-calibration'); await mkdir(parent, {recursive: true, mode: 0o700});
  const output = await mkdtemp(resolve(parent, 'calibration-'));
  const report = {schemaVersion: 1, purpose: 'deterministic-reference-and-counterexample-calibration', dataset: 'gold-flywheel-v1@1.0.0',
    manifestHash: source.hash, runtimeFingerprint: fingerprint, modelApiCalls: 0, agentCompletionChecks: 'off-calibrate-independent-graders',
    status: 'running', humanReview: 'pending', releaseReady: false, trials: [], evidence: []};
  const reportPath = resolve(output, 'report.json'), save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  const evidence = async path => report.evidence.push({path, hash: sha(await readFile(path))});
  const runner = new EvaluationRunner(); let runtime;
  await save();
  try {
    runtime = await Runtime.create({plugins: [...source.packs.map(pack => createSandboxTestPackPlugin(pack)), createSandboxTestPlugin({backend: sandbox, ...(image ? {image} : {})})]});
    const jobs = source.cases.filter(seed => seed.execution.kind === 'coding').flatMap(seed => calibrationScenarios(seed).map(scenario => ({seed, scenario})));
    const session = await runtime.openSession();
    await session.run(async run => {
      for (const id of [...new Set(jobs.map(job => job.scenario.id))]) {
        const group = jobs.filter(job => job.scenario.id === id), byId = new Map(group.map(job => [job.seed.case_id, job]));
        console.log(`Flywheel calibration ${id}: ${group.length}`);
        const result = await runner.run({schemaVersion: 1, id: `flywheel-${id}`, version: '1.0.0', split: 'regression', tasks: group.map(job => job.seed.execution.tasks[0])}, request => {
          const {seed, scenario} = byId.get(request.task.id);
          return createCodingTrialExecutor({allowWrites: true, modelFactory: () => referenceModel(request.task, referenceWithFault(seed.execution.references[0], scenario.override))})(request);
        }, {outputDirectory: output, repetitions: 1, concurrency: 1, sandboxTests: run.services.get(sandboxTestService)});
        const file = resolve(result.artifactDirectory, 'report.json'); await evidence(file);
        for (const trial of result.trials) {
          const {scenario} = byId.get(trial.taskId);
          for (const journal of trial.journalRefs) await evidence(resolve(result.artifactDirectory, journal));
          report.trials.push({caseId: trial.taskId, scenarioId: id, negative: scenario.negative, passed: trial.passed, cleanup: trial.cleanup,
            failedGraders: trial.graders.filter(g => g.status === 'failed').map(g => g.id), report: file});
        }
        await save(); assert.equal(result.status, 'completed');
        for (const trial of result.trials) verify(trial, byId.get(trial.taskId).scenario);
      }
    });
    for (const seed of source.cases.filter(seed => seed.execution.kind === 'conversation')) for (const scenario of calibrationScenarios(seed)) {
      console.log(`Flywheel conversation ${seed.case_id}: ${scenario.id}`);
      const result = await executeConversation(seed, resolve(output, `${seed.case_id}-${scenario.id}`), {override: scenario.override});
      const file = resolve(output, `${seed.case_id}-${scenario.id}/report.json`); await writeFile(file, JSON.stringify(result, null, 2) + '\n', {mode: 0o600});
      await evidence(file); await evidence(result.journal);
      const target = scenario.override?.stage ?? 0;
      report.trials.push({caseId: seed.case_id, scenarioId: scenario.id, negative: scenario.negative, passed: result.passed, cleanup: result.cleanup,
        failedGraders: result.turns[target].graders.filter(g => g.status === 'failed').map(g => g.id), report: file});
      await save(); assert.equal(result.passed, !scenario.negative);
      for (const [i, turn] of result.turns.entries()) verify({...turn, cleanup: result.cleanup}, i === target ? scenario : {negative: false});
    }
    assert.equal((await dataset()).hash, source.hash); assert.equal((await runtimeFingerprint()).hash, fingerprint.hash, 'Compiled runtime changed during calibration');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally {
    try { await runtime?.close(); await runner.close(); }
    catch (error) { report.status = 'failed'; report.error = 'CLEANUP_UNCONFIRMED'; throw error; }
    finally { await save(); }
  }
  return {status: report.status, cases: source.cases.length, trials: report.trials.length, positives: report.trials.filter(t => !t.negative).length,
    negatives: report.trials.filter(t => t.negative).length, modelApiCalls: 0, report: reportPath};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options: {sandbox: {type: 'string', default: 'native'}, image: {type: 'string'}}});
  console.log(JSON.stringify(await calibrate(values)));
}
