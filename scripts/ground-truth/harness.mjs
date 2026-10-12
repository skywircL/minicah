// Repository-owned deterministic contract track. Never executes candidate commands.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runtimeFingerprint, reportPointer } from './version.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export async function harnessContracts() {
  const selected = JSON.parse(await readFile(new URL('./harness-cases.json', import.meta.url), 'utf8'));
  return Promise.all(selected.map(async c => {
    assert.match(c.file, /^test\/[a-z0-9-]+\.test\.ts$/);
    const source = await readFile(resolve(root, c.file), 'utf8');
    assert.ok(source.includes(`test(${JSON.stringify(c.name)}`), `Missing named contract ${c.id}`);
    return { ...c, reset: 'fresh-node-test-fixture', initialState: `The named fixture in ${c.file} creates the specified state and failure point.`, oracle: { kind: 'trusted-node-test', exactName: c.name }, sourceHash: sha(source), requirementHash: sha(await readFile(resolve(root, c.source))), mutation: /uncertain|partial|conflict|intent|cancel|approval/.test(c.id) ? 'state-or-permission' : /context|summary|compaction|batch/.test(c.id) ? 'conversation-or-context' : 'none' };
  }));
}
async function execute(file, pattern, signal) {
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', pattern, resolve(root, file.replace(/^test\//, 'dist/test/').replace(/\.ts$/, '.js'))], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, MINICAH_NATIVE_TEST: '0', MINICAH_SANDBOX_IMAGE: '', MINICAH_PTC_IMAGE: '' } });
  let output = '', reason = null;
  const stop = code => { reason ??= code; try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
  const onAbort = () => stop('cancelled'); signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => stop('timeout'), 60000);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes.toString(); if (Buffer.byteLength(output) > 2 * 1024 * 1024) { output = output.slice(0, 2 * 1024 * 1024); stop('output-limit'); } });
  try {
    const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    return { code, reason, output };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
export async function runHarness(signal) {
  const fingerprint = await runtimeFingerprint();
  const contracts = await harnessContracts();
  const outputRoot = resolve(root, '.minicah/gt-validation'); await mkdir(outputRoot, { recursive: true });
  const artifacts = await mkdtemp(resolve(outputRoot, 'harness-'));
  const report = { schemaVersion: 1, track: 'deterministic-harness-contracts', modelApiCalls: 0, runtimeHash: fingerprint.hash, contractsHash: sha(JSON.stringify(contracts)), status: 'running', cases: [], evidence: [], platformIsolation: 'not-validated-by-this-command', artifacts };
  await writeFile(resolve(artifacts, 'runtime.json'), JSON.stringify(fingerprint, null, 2) + '\n', { mode: 0o600 });
  for (const file of [...new Set(contracts.map(c => c.file))]) {
    const group = contracts.filter(c => c.file === file);
    const run = await execute(file, `^(?:${group.map(c => escape(c.name)).join('|')})$`, signal);
    const evidence = resolve(artifacts, file.split('/').pop() + '.tap');
    await writeFile(evidence, run.output, { mode: 0o600 });
    report.evidence.push({ path: evidence, hash: sha(run.output) });
    for (const c of group) {
      const observed = new RegExp(`^ok \\d+ - ${escape(c.name)}$`, 'm').test(run.output);
      const sameSource = sha(await readFile(resolve(root, file))) === c.sourceHash;
      report.cases.push({ id: c.id, status: run.code === 0 && !run.reason && observed && sameSource ? 'passed' : 'failed', observed, sameSource, sourceHash: c.sourceHash, expectedState: c.expectedState });
    }
    if (run.code !== 0 || run.reason) break;
  }
  report.runtimeUnchanged = (await runtimeFingerprint()).hash === fingerprint.hash;
  report.status = report.runtimeUnchanged && report.cases.length === contracts.length && report.cases.every(c => c.status === 'passed') ? 'passed' : 'failed';
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const target = resolve(root, 'evals/private/ground-truth-v1'); await mkdir(target, { recursive: true });
  await writeFile(resolve(target, 'harness-latest.json'), JSON.stringify(await reportPointer(resolve(artifacts, 'report.json'), { status: report.status, contractsHash: report.contractsHash, runtimeHash: fingerprint.hash }), null, 2) + '\n', { mode: 0o600 });
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), stop = () => controller.abort(); process.on('SIGINT', stop);
  try { const report = await runHarness(controller.signal); process.stdout.write(JSON.stringify({ status: report.status, cases: report.cases.length, artifacts: report.artifacts }) + '\n'); process.exitCode = report.status === 'passed' ? 0 : 1; }
  finally { process.off('SIGINT', stop); }
}
