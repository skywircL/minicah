import assert from 'node:assert/strict';
import { mkdir, mkdtemp, copyFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReplay, frozenCheck, executeTrial, variant } from './diagnose-premature-completion.mjs';
import { deepSeekModel } from '../../dist/src/agent/deepseek.js';
import { loadCliEnvironment } from '../../dist/src/cli/environment.js';
import { root, writeJSON, sha } from '../gold-expansion/common.mjs';
import { wilson } from './expansion-statistics.mjs';

const self = fileURLToPath(import.meta.url);
export function followupVariant(arm, replay) {
  if (['original', 'final-after-action'].includes(arm)) return variant(arm, replay);
  assert.ok(['final-scope-only', 'action-precondition-only'].includes(arm));
  return { prefix: structuredClone(replay.compactPrefix), prompt: replay.prompt.replace('只返回 JSON', arm === 'final-scope-only' ? '最终回复只返回 JSON' : '完成上述修改后，只返回 JSON') };
}
function summarize(rows) {
  return [...new Set(rows.map(t => `${t.caseId}/${t.arm}`))].map(key => {
    const selected = rows.filter(t => `${t.caseId}/${t.arm}` === key), passed = selected.filter(t => t.phases[0].passed).length;
    return { group: key, trials: selected.length, passed, wilson95: wilson(passed, selected.length), outcomePassed: selected.filter(t => t.phases[0].publicState.satisfied).length,
      firstResponseNoTools: selected.filter(t => t.calls[0].finishReason === 'stop').length };
  });
}
export async function main(planOnly = false) {
  const frozen = await frozenCheck(), replays = { 'GM-D19': await loadReplay('GM-D19'), 'GM-D04': await loadReplay('GM-D04') };
  let state = 2026100302; const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const order = [];
  for (let repetition = 1; repetition <= 6; repetition++) {
    const block = ['original', 'final-scope-only', 'action-precondition-only'].map(arm => ({ caseId: 'GM-D19', arm, repetition }));
    if (repetition <= 4) block.push(...['original', 'final-after-action'].map(arm => ({ caseId: 'GM-D04', arm, repetition })));
    for (let j = block.length - 1; j > 0; j--) { const k = Math.floor(random() * (j + 1)); [block[j], block[k]] = [block[k], block[j]]; }
    order.push(...block);
  }
  const plan = { version: 1, purpose: 'Adaptive follow-up selected after the initial 48-trial result; separately reported', frozen, model: replays['GM-D19'].model, order,
    protocol: { trials: 26, concurrency: 1, retries: 0, recovery: false, ordering: 'randomized blocks with seed 2026100302', D19: 'six repeats of concurrent original control, final-scope-only and action-precondition-only', D04: 'four repeats of concurrent original control and combined wording; new synthetic target port=0', sampling: 'same provider defaults as initial study', limitations: 'exploratory adaptive experiment, small fixed scenarios and prefixes; not independent benchmark release evidence' },
    publicContracts: { 'GM-D19': { path: 'dev.json', field: 'timeout', value: 10 }, 'GM-D04': { path: 'dev.json', field: 'port', value: 0 } },
    variants: Object.entries(replays).flatMap(([caseId, replay]) => [...new Set(order.filter(x => x.caseId === caseId).map(x => x.arm))].map(arm => ({ caseId, arm, ...followupVariant(arm, replay) }))),
    sourceJournals: Object.entries(replays).map(([caseId, r]) => ({ caseId, path: r.sourceJournal, hash: r.sourceJournalHash })),
    authorization: 'Current user asks to test and analyze cause and propose improvements; follows the existing official DeepSeek API authorization, same synthetic payload boundary' };
  if (planOnly) { console.log(JSON.stringify({ order, protocol: plan.protocol, model: plan.model })); return; }
  await loadCliEnvironment(); assert.ok(process.env.DEEPSEEK_API_KEY);
  const parent = resolve(root, '.minicah/premature-completion-diagnostics'); await mkdir(parent, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(resolve(parent, 'followup-')); await writeJSON(resolve(output, 'plan.json'), plan);
  for (const name of ['diagnose-premature-completion.mjs', 'diagnose-premature-completion-followup.mjs']) await copyFile(resolve(root, 'scripts/evaluation', name), resolve(output, name));
  const report = { ...plan, driverHash: sha(await readFile(self)), output, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, trials: [] };
  const save = async () => { report.groups = summarize(report.trials); await writeJSON(resolve(output, 'report.json'), report); };
  await save(); console.log(`Follow-up artifacts: ${output}`);
  try {
    for (const row of order) {
      const replay = replays[row.caseId];
      const result = await executeTrial({ ...row, replay, directory: resolve(output, `${row.caseId}-${row.repetition}-${row.arm}`), adapter: deepSeekModel(plan.model, process.env.DEEPSEEK_API_KEY), selectedOverride: followupVariant(row.arm, replay), publicContract: plan.publicContracts[row.caseId] });
      report.trials.push({ ...result, caseId: row.caseId }); await save();
      console.log(JSON.stringify({ done: report.trials.length, total: order.length, ...row, passed: result.phases[0].passed, calls: result.calls.length }));
      assert.equal(result.cleanup, 'verified'); assert.ok(result.calls.every(c => c.status === 'completed'), 'Provider failure'); assert.ok(result.phases[0].graders.every(g => g.status !== 'error'), 'Grader failure');
    }
    report.status = 'completed';
  } catch { report.status = 'stopped'; }
  finally { report.finishedAt = new Date().toISOString(); report.frozenAfter = await frozenCheck(); await save(); }
  console.log(JSON.stringify({ output, status: report.status, groups: report.groups }));
  if (report.status !== 'completed') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === self) await main(process.argv.includes('--plan'));
