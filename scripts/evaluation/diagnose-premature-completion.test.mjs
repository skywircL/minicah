import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { arms, variant, schedule, publicStateCheck, shouldContinue, executeTrial } from './diagnose-premature-completion.mjs';
import { deepSeekConfig, deepSeekModel } from '../../dist/src/agent/deepseek.js';
import { contentHash } from '../../dist/src/json.js';
import { followupVariant } from './diagnose-premature-completion-followup.mjs';
const initial = { 'dev.json': '{"timeout":30}\n', 'prod.json': '{"timeout":60}\n', 'protected.txt': 'KEEP\n' };
test('wording factors change only their intended message', () => {
  const r = { compactPrefix: [{ role: 'user', content: '历史：前两轮已完成，约束保持。' }], fullPrefix: [{ role: 'user', content: '完整历史' }], prompt: '设为10。只返回 JSON {}；不得执行命令。' };
  assert.deepEqual(variant('final-after-action', r).prefix, r.compactPrefix);
  assert.equal(variant('remove-completed-history', r).prompt, r.prompt);
  assert.equal(variant('remove-completed-history', r).prefix[0].content, '历史：约束保持。');
  assert.equal(variant('both-wording', r).prompt, variant('final-after-action', r).prompt);
  assert.deepEqual(variant('full-history', r).prefix, r.fullPrefix);
  assert.ok(r.compactPrefix[0].content.includes('前两轮已完成'));
});
test('interleaved schedule contains each arm once per block', () => {
  const rows = schedule(); assert.equal(rows.length, 48); assert.deepEqual(schedule(), rows);
  for (let i = 1; i <= 8; i++) assert.deepEqual(rows.filter(x => x.repetition === i).map(x => x.arm).sort(), [...arms].sort());
});
test('follow-up separates final-answer scope from action precondition without altering history', () => {
  const r = { compactPrefix: [{ role: 'user', content: '历史不变' }], prompt: '任务。只返回 JSON {}；不得执行命令。' };
  const scope = followupVariant('final-scope-only', r), action = followupVariant('action-precondition-only', r);
  assert.deepEqual(scope.prefix, r.compactPrefix); assert.deepEqual(action.prefix, r.compactPrefix);
  assert.equal(scope.prompt, '任务。最终回复只返回 JSON {}；不得执行命令。');
  assert.equal(action.prompt, '任务。完成上述修改后，只返回 JSON {}；不得执行命令。');
  assert.equal(publicStateCheck({ 'dev.json': '{"port":4100}' }, { 'dev.json': '{"port":0}' }, { path: 'dev.json', field: 'port', value: 0 }).satisfied, true);
});
test('public state gate permits legitimate no-op and rejects partial or protected changes', () => {
  const good = { ...initial, 'dev.json': '{"timeout":10}\n' };
  assert.equal(publicStateCheck(initial, initial).satisfied, false);
  assert.equal(publicStateCheck(initial, good).satisfied, true);
  assert.equal(publicStateCheck(good, good).satisfied, true);
  assert.equal(publicStateCheck(initial, { ...good, 'prod.json': '{}' }).satisfied, false);
  assert.equal(publicStateCheck(initial, { ...good, 'extra.txt': 'x' }).satisfied, false);
  assert.equal(publicStateCheck(initial, { ...good, 'dev.json': 'bad' }).satisfied, false);
  const p = { status: 'completed', trace: { approvalDenials: { counts: {} } } };
  assert.equal(shouldContinue(p, publicStateCheck(initial, initial)), true);
  assert.equal(shouldContinue(p, publicStateCheck(initial, good)), false);
  assert.equal(shouldContinue({ ...p, trace: { approvalDenials: { counts: { write_file: 1 } } } }, publicStateCheck(initial, initial)), false);
});
test('real harness preserves premature first stop and separately executes bounded recovery', async () => {
  const adapter = deepSeekModel(deepSeekConfig({}), 'fixture-unused-no-network'); let n = 0;
  const fake = { ...adapter, async complete(request) {
    n++; let tool_calls;
    if (n === 2) tool_calls = [{ id: 'r', type: 'function', function: { name: 'read_file', arguments: '{"path":"dev.json"}' } }];
    if (n === 3) tool_calls = [{ id: 'w', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'dev.json', content: '{"timeout":10}\n', expectedHash: contentHash(initial['dev.json']) }) } }];
    assert.ok(!JSON.stringify(request).includes('file-json-equals'), 'Hidden grader leaked');
    return { message: { role: 'assistant', content: tool_calls ? null : '{"status":"completed"}', ...(tool_calls ? { tool_calls } : {}) }, finishReason: tool_calls ? 'tool_calls' : 'stop', usage: null, providerId: `fixture-${n}` };
  } };
  const task = { id: 'diagnostic-test', prompt: '将 dev.json 的 timeout 改成10；只返回 JSON {"status":"completed"}。', files: initial,
    executionPolicy: { allowedTools: ['read_file', 'write_file', 'edit_file'], writeApproval: 'allow' }, graders: [{ id: 'result', kind: 'file-json-equals', path: 'dev.json', expected: { timeout: 10 } }, { id: 'response', kind: 'text-json-equals', expected: { status: 'completed' } }] };
  const prefix = [{ role: 'system', content: 'Use file tools.' }, { role: 'system', content: 'Retained constraints:\n/source' }, { role: 'user', content: '已明确目标为dev.json。' }];
  const replay = { sourceWorkspace: '/source', compactPrefix: prefix, fullPrefix: prefix, prompt: task.prompt, initialFiles: initial, task };
  // Test arm avoids exact frozen-request equality, which is separately asserted for live original trials.
  const directory = await mkdtemp(resolve(tmpdir(), 'minicah-diagnostic-test-'));
  const result = await executeTrial({ replay, arm: 'final-after-action', repetition: 1, directory, adapter: fake, allowContinuation: true });
  assert.equal(result.cleanup, 'verified'); assert.equal(result.phases.length, 2);
  assert.equal(result.phases[0].passed, false); assert.equal(result.phases[0].finalFiles['dev.json'], initial['dev.json']);
  assert.equal(result.phases[1].passed, true); assert.equal(result.calls.length, 4);
});
