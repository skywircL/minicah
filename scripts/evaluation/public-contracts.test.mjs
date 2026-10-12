import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAgentOptions } from './public-contracts.mjs';

test('zero and rollback goals use only the current public request, never hidden graders', () => {
  const task = { id: 'unrelated-id', prompt: '再次更新：把先前指定目标的 port 设为 0。只返回 JSON {"status":"completed"}',
    history: ['把 dev.json 的 port 改成4000，prod.json 永远不能修改。'],
    graders: [{ expected: { port: 999 } }], executionPolicy: { writeApproval: 'deny' } };
  const options = publicAgentOptions(task);
  assert.deepEqual(options.completion.jsonTargets, [{ path: 'dev.json', pointer: '/port', value: 0 }]);
  assert.deepEqual(options.completion.preservePaths, ['prod.json']);
  assert.equal(options.completion.expectedDenial, undefined);
  assert.ok(!JSON.stringify(options).includes('999'));
  assert.deepEqual(publicAgentOptions({ ...task, graders: [], executionPolicy: {} }), options);
});
test('history resolves a field and path, but cannot introduce a stale target', () => {
  const history = ['读取 dev.json 和 prod.json。后续修改目标是 dev.json 的 timeout；prod.json 永远不得修改。'];
  assert.equal(publicAgentOptions({ history, prompt: '把刚才约定的超时改成30。' }).completion.jsonTargets[0].value, 30);
  assert.equal(publicAgentOptions({ history: ['把 dev.json 的 port 改成4000'], prompt: '只返回 JSON {"status":"ready"}' }).completion.jsonTargets, undefined);
});
test('placeholder response examples specify shape, not hidden answers', () => {
  const { completion } = publicAgentOptions({ prompt: '返回 JSON，例如 {"status":"completed","symbol":"<函数名>","definition":"<路径>","line":1}，占位值和示例数字替换。' });
  assert.deepEqual(completion.responseSchema.properties.line, { type: 'integer', minimum: 1 });
  assert.deepEqual(completion.responseSchema.properties.symbol, { type: 'string', minLength: 1 });
});
test('strict response schemas preserve ready and conditional denied alternatives', () => {
  assert.deepEqual(publicAgentOptions({ prompt: '只读取并返回 JSON {"status":"ready"}。未另述时返回 {"status":"completed"}' }).completion.responseSchema.properties.status, { const: 'ready' });
  const { completion } = publicAgentOptions({ prompt: '完成返回 {"status":"completed","verification":"not-run"}；Host 审批拒绝返回 {"status":"denied"}。' });
  assert.equal(completion.responseSchema.anyOf.length, 2);
  assert.deepEqual(completion.responseSchema.anyOf[0].required, ['status', 'verification']);
});
test('fresh reads require an explicit public snapshot contract; ordinary read/no-op is untouched', () => {
  const prompt = '本轮必须先用 read_file 分别读取 dev.json、prod.json，取得当前完整内容和 hash；即使无需修改。';
  assert.deepEqual(publicAgentOptions({ prompt }).completion.readPaths, ['dev.json', 'prod.json']);
  assert.deepEqual(publicAgentOptions({ prompt: '读取 dev.json 和 prod.json。' }), {});
});
test('scope protection comes from public permitted paths, never grader expected files', () => {
  const { completion } = publicAgentOptions({ prompt: '只修改 src/select.cjs，其他文件保持不变。最终返回 {"status":"completed"}', graders: [{ paths: ['prod.json'] }] });
  assert.deepEqual(completion.allowedChanges, ['src/select.cjs']);
  const config = publicAgentOptions({ prompt: '把 dev.json 的 port 改成0，其他字段不变；其他文件不变。' }).completion;
  assert.equal(config.preserveJsonOtherFields, true);
  assert.deepEqual(config.allowedChanges, ['dev.json']);
});
