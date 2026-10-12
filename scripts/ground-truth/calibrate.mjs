// Reference execution and adversarial grader calibration; never a real-model score.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { Runtime, createSandboxTestPackPlugin, createSandboxTestPlugin, sandboxTestService, definition } from '../../dist/src/index.js';
import { EvaluationRunner, readSuite } from '../../dist/src/evaluation/index.js';
import { readSandboxTestPack } from '../../dist/src/evaluation/test-pack.js';
import { createCodingTrialExecutor } from '../../dist/src/evaluation/coding-executor.js';
import { runtimeFingerprint, reportPointer, sha } from './version.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = resolve(root, 'evals/private/ground-truth-v1');
const read = async name => JSON.parse(await readFile(resolve(directory, name), 'utf8'));
export function referenceModel(task, reference, fault) {
  let step = 0;
  return {
    definition: () => definition('model', 'trusted-gt-reference', '1.0.0', { taskId: task.id, purpose: 'oracle-calibration', fault: fault ?? null }),
    limits: () => ({ contextWindow: 32768, maxOutputTokens: 8192 }),
    prepare: messages => ({ messages }),
    async complete(request) {
      const reply = (calls, text = null) => ({ message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls.map((c, i) => ({ id: `ref-${step}-${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) }, finishReason: calls.length ? 'tool_calls' : 'stop', usage: null, providerId: `ref-${step}` });
      if (step++ === 0) {
        const paths = new Set([...(fault === 'skip-exposure' ? [] : ['PROJECT_NOTES.txt']), ...(fault === 'out-of-scope-same-content' ? ['protected.txt'] : []), ...(reference.readPaths ?? []), ...Object.keys(reference.files).filter(p => Object.hasOwn(task.files, p))]);
        return paths.size ? reply([...paths].map(path => ({ name: 'read_file', args: { path } }))) : reply([], reference.finalText);
      }
      if (step === 2) {
        const hashes = {};
        for (const message of request.messages) if (message.role === 'tool') {
          const data = JSON.parse(message.content ?? 'null');
          if (data?.value?.path && data.value.hash) hashes[data.value.path] = data.value.hash;
        }
        const calls = [];
        if (reference.mode !== 'read' && fault !== 'always-refuse') {
          for (const [path, content] of Object.entries(reference.files)) calls.push({ name: 'write_file', args: { path, content, expectedHash: hashes[path] ?? null } });
        }
        if (fault === 'command') calls.push({ name: 'run_command', args: { command: 'node', args: ['--version'] } });
        if (fault === 'collateral') calls.push({ name: 'write_file', args: { path: 'unrequested.txt', expectedHash: null, content: 'unrequested' } });
        if (fault === 'out-of-scope-same-content') calls.push({ name: 'write_file', args: { path: 'protected.txt', expectedHash: hashes['protected.txt'], content: task.files['protected.txt'] } });
        if (calls.length) return reply(calls);
      }
      assert.ok(step <= 3, 'Reference fixture exceeded its fixed program');
      return reply([], fault === 'response' ? '{"status":"invented-success"}' : fault === 'always-refuse' ? '{"status":"denied"}' : reference.finalText);
    },
  };
}

export async function calibrate({ sandbox = 'native', image, signal } = {}) {
  const fingerprint = await runtimeFingerprint();
  const manifest = await read('manifest.json');
  for (const [name, hash] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(await readFile(resolve(directory, name))).digest('hex'), hash, `Stale GT file ${name}`);
  for (const [name, hash] of Object.entries(manifest.sources)) assert.equal(createHash('sha256').update(await readFile(resolve(root, name))).digest('hex'), hash, `Stale GT source ${name}`);
  const suites = await Promise.all(['capability', 'holdout'].map(s => readSuite(resolve(directory, `${s}.json`))));
  const packs = await Promise.all(['capability', 'holdout'].map(s => readSandboxTestPack(resolve(directory, `${s}.tests.json`))));
  const refs = await read('references.json');
  const output = resolve(root, '.minicah/gt-validation'); await mkdir(output, { recursive: true, mode: 0o700 });
  const artifacts = await mkdtemp(resolve(output, 'calibration-'));
  const runner = new EvaluationRunner();
  const runtime = await Runtime.create({ plugins: [...packs.map(createSandboxTestPackPlugin), createSandboxTestPlugin({ backend: sandbox, ...(image ? { image } : {}) })] });
  const summary = { schemaVersion: 1, purpose: 'GT calibration, not model capability', modelApiCalls: 0, runtimeHash: fingerprint.hash, backend: sandbox, manifestHash: createHash('sha256').update(await readFile(resolve(directory, 'manifest.json'))).digest('hex'), status: 'running', phases: [], humanReview: 'pending', releaseReady: false, artifactDirectory: artifacts };
  await writeFile(resolve(artifacts, 'runtime.json'), JSON.stringify(fingerprint, null, 2) + '\n', { mode: 0o600 });
  const save = () => writeFile(resolve(artifacts, 'report.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  await save();
  try {
    const session = await runtime.openSession();
    await session.run(async run => {
      const sandboxTests = run.services.get(sandboxTestService);
      const tasks = suites.flatMap(s => s.tasks);
      const phase = async (name, selected, patch, expectPass, fault) => {
        if (signal) signal.throwIfAborted();
        process.stdout.write(`GT ${name}: ${selected.length} trials\n`);
        const suite = { schemaVersion: 1, id: `gt-calibration-${name}`, version: '1.0.0', split: 'regression', tasks: selected };
        const report = await runner.run(suite, request => {
          const reference = patch ? patch(refs[request.task.id], request.task.id) : refs[request.task.id];
          return createCodingTrialExecutor({ allowWrites: true, modelFactory: () => referenceModel(request.task, reference, fault) })(request);
        }, { outputDirectory: artifacts, repetitions: 1, concurrency: 1, sandboxTests, ...(signal ? { signal } : {}), reference: { executor: `trusted-gt-${name}` } });
        const reportFile = resolve(report.artifactDirectory, 'report.json');
        summary.phases.push({ name, trials: report.trials.length, passed: report.trials.filter(t => t.passed === true).length, expectPass, excluded: report.aggregate.excludedTrials, report: reportFile, reportHash: sha(await readFile(reportFile)), failures: report.trials.filter(t => t.passed !== expectPass).map(t => ({ id: t.taskId, classification: t.classification, error: t.errorCode, graders: t.graders.filter(g => g.status !== 'passed') })) });
        await save();
        assert.equal(report.status, 'completed', `${name}: incomplete cleanup or cancellation`);
        assert.ok(report.trials.every(t => t.passed === expectPass), `${name}: oracle calibration disagreed; inspect ${artifacts}/report.json`);
        return report;
      };
      await phase('references', tasks, null, true);
      const bases = tasks.filter(t => t.contract.mutation === 'none' && refs[t.id].negativeFiles.length);
      await phase('originals', bases, ref => ({ ...ref, files: {}, mode: 'read' }), false);
      for (let i = 0; i < Math.max(...bases.map(t => refs[t.id].negativeFiles.length)); i++) {
        const chosen = bases.filter(t => refs[t.id].negativeFiles[i]);
        const report = await phase(`wrong-code-${i + 1}`, chosen, ref => ({ ...ref, files: ref.negativeFiles[i].files }), false);
        assert.ok(report.trials.every(t => t.graders.some(g => g.id === 'result' && g.status === 'failed')), 'Wrong code must fail the behavior oracle, not just a collateral check');
      }
      const canary = tasks.filter(t => ['config-retry', 'create-module'].includes(t.id));
      for (const fault of ['response', 'command', 'collateral', 'skip-exposure', 'always-refuse']) await phase(`negative-${fault}`, canary, null, false, fault);
      const scopeReport = await phase('negative-out-of-scope-same-content', canary, null, false, 'out-of-scope-same-content');
      assert.ok(scopeReport.trials.every(t => t.graders.find(g => g.id === 'scope').status === 'passed' && t.graders.find(g => g.id === 'write-scope').status === 'failed'), 'Same-content forbidden writes must fail behavior even when final-state preservation passes');
    });
    assert.equal((await runtimeFingerprint()).hash, fingerprint.hash, 'Runtime changed during calibration');
    assert.equal(sha(await readFile(resolve(directory, 'manifest.json'))), summary.manifestHash, 'GT changed during calibration');
    summary.status = 'passed';
  } catch (error) { summary.status = 'failed'; summary.error = String(error.message); throw error; }
  finally { await runtime.close(); await runner.close(); await save(); }
  await writeFile(resolve(directory, 'calibration-latest.json'), JSON.stringify(await reportPointer(resolve(artifacts, 'report.json'), { manifestHash: summary.manifestHash, runtimeHash: fingerprint.hash, status: summary.status, modelApiCalls: 0, humanReview: 'pending' }), null, 2) + '\n', { mode: 0o600 });
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { sandbox: { type: 'string', default: 'native' }, image: { type: 'string' } } });
  const controller = new AbortController(); const abort = () => controller.abort(); process.on('SIGINT', abort);
  try { const result = await calibrate({ ...values, signal: controller.signal }); process.stdout.write(JSON.stringify({ status: result.status, artifacts: result.artifactDirectory }) + '\n'); }
  finally { process.off('SIGINT', abort); }
}
