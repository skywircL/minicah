/** A deliberately narrow compiler for this campaign's PUBLIC task templates.
 * It never reads graders, references, executionPolicy, case ids or future turns.
 * Unknown prose stays unverified: this is not a natural-language correctness oracle.
 */
export function publicAgentOptions({ prompt, history = [] }) {
  if (typeof prompt !== 'string' || !Array.isArray(history) || history.some(p => typeof p !== 'string')) throw new TypeError('Public prompts required');
  const completion = { maxContinuations: 1 }, pastAndCurrent = [...history, prompt].join('\n');
  const examples = [...prompt.matchAll(/\{[^{}\n]*"status"\s*:[^{}\n]*\}/g)].flatMap(match => {
    try { return [JSON.parse(match[0])]; } catch { return []; }
  });
  const first = examples[0];
  if (first) {
    const options = [first];
    if (first.status !== 'ready' && /Host.*审批|审批.*Host/s.test(prompt)) {
      const denied = examples.find(value => value.status === 'denied');
      if (denied && first.status !== 'denied') options.push(denied);
    }
    const schemas = options.map(value => ({ type: 'object', additionalProperties: false,
      required: Object.keys(value), properties: Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
        typeof v === 'string' && /^<.*>$/.test(v) ? { type: 'string', minLength: 1 }
          : key === 'line' && /占位|示例数字/.test(prompt) ? { type: 'integer', minimum: 1 }
          : { const: v }])) }));
    completion.responseSchema = schemas.length === 1 ? schemas[0] : { anyOf: schemas };
    completion.responseStatus = { pointer: '/status', completed: 'completed', denied: 'denied' };
  } else if (/最终.*JSON|只返回\s*JSON/.test(prompt)) completion.responseSchema = { type: 'object' };

  // Only the CURRENT instruction supplies the new value. History resolves references.
  const goal = /\b(port|timeout)\b[^\n。；;]{0,35}?(?:改成|设为|设置为|改为)\s*(-?\d+)(?![\d.])/.exec(prompt)
    ?? /(端口|超时)[^\n。；;]{0,35}?(?:改成|设为|设置为|改为)\s*(-?\d+)(?![\d.])/.exec(prompt);
  if (goal) {
    const field = ({ 端口: 'port', 超时: 'timeout' })[goal[1]] ?? goal[1];
    const paths = [...pastAndCurrent.matchAll(/([A-Za-z0-9_./-]+\.json)\s*的\s*(port|timeout)/g)].filter(m => m[2] === field);
    const path = paths.at(-1)?.[1], value = Number(goal[2]);
    if (path && Number.isSafeInteger(value)) {
      completion.jsonTargets = [{ path, pointer: '/' + field, value }];
      if (/其他字段|除题述目标外/.test(pastAndCurrent)) completion.preserveJsonOtherFields = true;
    }
  }
  const protectedPaths = [...pastAndCurrent.matchAll(/([A-Za-z0-9_./-]+\.json)\s*(?:永远)?(?:不得(?:修改|写入)|不能修改)/g)].map(m => m[1]);
  if (protectedPaths.length) completion.preservePaths = [...new Set(protectedPaths)];

  // Explicit new-version snapshot requirement only. Mere search/read prose is not narrowed.
  const read = /本轮必须先用 read_file 分别读取 ([^，\n]+)，取得当前完整内容和 hash/.exec(prompt);
  if (read) completion.readPaths = read[1].split('、');
  // Preserve visible workspace files outside explicitly authorized paths.
  // This proves scope only, never that a code patch implements its full contract.
  const changes = [...prompt.matchAll(/只(?:允许)?修改\s*([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g)].map(m => m[1]);
  const migration = /迁移\s+([A-Za-z0-9_./-]+\.json)\s*与\s*([A-Za-z0-9_./-]+\.json)/.exec(prompt);
  if (migration) changes.push(migration[1], migration[2]);
  changes.push(...(completion.jsonTargets ?? []).map(target => target.path));
  if (changes.length && /其他文件|仅题述目标路径可写|除题述目标外/.test(pastAndCurrent)) completion.allowedChanges = [...new Set(changes)];
  else if (first?.status === 'ready' && /只读取/.test(prompt)) completion.allowedChanges = [];
  return Object.keys(completion).length > 1 ? { completion } : {};
}
