import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const BASE = '.minicah/gold-expansion-baselines/baseline-FxEhmE';
const sha = text => createHash('sha256').update(text).digest('hex');
const canonical = x => x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x)
  ? `[${x.map(canonical).join(',')}]`
  : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
const pretty = x => typeof x === 'string' ? x : JSON.stringify(x, null, 2);
const parse = s => { try { return JSON.parse(s); } catch { return undefined; } };
export const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const embeddedJSON = x => JSON.stringify(x).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
export const layers = { outcome: '结果', behavior: '行为', response: '回复' };
const phases = { attempted: '尝试', dispatched: '派发', 'approval-denied': 'Host 审批拒绝', 'attempted-after-denial': '拒绝后再次尝试' };
const toolNames = { read_file: '读取文件', search_text: '搜索内容', list_files: '列出文件', write_file: '写入文件', edit_file: '编辑文件', run_command: '执行命令' };

export function testActual(c) {
  const lines = (c.diagnostics?.value?.stdout ?? '').split('\n');
  const frames = lines.filter(s => s.startsWith('MINICAH_SANDBOX_TEST ')).map(s => parse(s.slice(21))).filter(Boolean);
  const ready = frames[0]?.caseId === c.id && frames[0]?.type === 'ready' ? frames[0] : null;
  const results = frames.filter(x => x.caseId === c.id && x.type === 'result' && ready && x.nonce === ready.nonce);
  if (frames.length === 2 && results.length === 1 && !c.diagnostics?.truncated) {
    const r = results[0];
    if (r.kind === 'return') return { known: true, value: r.value, text: JSON.stringify(r.value, null, 2) };
    return { known: false, text: r.kind === 'invalid-return' ? '返回值不能表示为 JSON' : `执行结果：${r.kind}`, kind: r.kind };
  }
  return { known: false, text: c.status === 'passed' ? '通过；日志未保存返回值' : `未保存可解析返回值（${c.code ?? c.status}）` };
}

// Reconstruct only writes with an explicit successful commit result. A planned,
// dispatched, rejected or denied call is never evidence of a successful write.
export function reconstruct(initial, events) {
  const state = { ...initial }, planned = new Map(), commits = [], issues = [];
  for (const e of events) {
    const d = e.data;
    if (d.type === 'tool.planned') planned.set(e.callId, d);
    if (d.type !== 'tool.completed') continue;
    const p = planned.get(e.callId), name = p?.tool?.id ?? e.tool?.id, r = d.result;
    if (!['write_file', 'edit_file'].includes(name) || r.status !== 'completed' || !r.dispatched || r.value?.ok !== true) continue;
    if (!p || typeof p.input?.path !== 'string') { issues.push(`seq ${e.seq}：成功写入缺少参数`); continue; }
    const input = p.input, path = input.path.replace(/^\.\//, '');
    if (name === 'write_file' && typeof input.content === 'string') state[path] = input.content;
    else if (name === 'edit_file' && typeof state[path] === 'string' && typeof input.oldText === 'string' && input.oldText.length
      && state[path].split(input.oldText).length === 2 && typeof input.newText === 'string') {
      state[path] = state[path].replace(input.oldText, () => input.newText);
    } else { state[path] = null; issues.push(`seq ${e.seq}：${path} 无法精确重建`); continue; }
    if (r.value.hash && sha(canonical(state[path])) !== r.value.hash) {
      issues.push(`seq ${e.seq}：${path} 与写入结果 hash 不一致`); state[path] = null;
    }
    commits.push({ seq: e.seq, path });
  }
  return { state, commits, issues };
}

function timeline(events) {
  const planned = new Map(), requested = new Map();
  const items = [];
  for (const e of events) {
    const d = e.data, common = { seq: e.seq, timestamp: e.timestamp };
    if (d.type === 'model.completed') {
      const message = d.response?.completion?.message;
      const calls = message?.tool_calls ?? [];
      for (const c of calls) {
        const id = d.response?.calls?.find(x => x.providerId === c.id)?.callId;
        if (id) requested.set(id, { name: c.function.name, raw: c.function.arguments });
      }
      items.push({ ...common, kind: 'model', tone: calls.length ? 'neutral' : 'info', title: calls.length ? `Agent 请求 ${calls.length} 个工具` : 'Agent 最终回复', text: d.text ?? message?.content ?? '', calls: calls.map(c => ({ name: c.function.name, arguments: c.function.arguments })) });
    }
    if (d.type === 'tool.planned') planned.set(e.callId, d);
    if (d.type === 'tool.completed') {
      const p = planned.get(e.callId), name = p?.tool?.id ?? e.tool?.id, r = d.result, v = r.value;
      const ok = r.status === 'completed' && r.dispatched && v?.ok !== false;
      items.push({ ...common, kind: 'tool', tone: ok ? 'good' : 'bad', name,
        title: `${toolNames[name] ?? name} · ${p?.input?.path ?? p?.input?.query ?? ''}`,
        text: ok ? (['write_file','edit_file'].includes(name) && v?.ok === true ? '写入已成功提交' : '工具执行完成') : `工具未成功：${v?.code ?? r.code ?? r.status}`,
        input: p?.input, result: v, status: r.status, dispatched: r.dispatched });
    }
    if (d.type === 'permission.decided' && e.tool && ['write_file','edit_file'].includes(e.tool.id)) {
      items.push({ ...common, kind: 'approval', tone: d.decision === 'deny' ? 'warn' : 'neutral', title: d.decision === 'deny' ? 'Host 拒绝写入' : 'Host 允许写入', text: `${e.tool.id} · ${planned.get(e.callId)?.input?.path ?? ''}；${d.reason ?? ''}` });
    }
    if (d.type === 'pipeline.rejected') {
      const call = requested.get(d.rejectedCallId);
      items.push({ ...common, kind: 'rejected', tone: 'bad', name: d.name, title: `${d.name} 参数/管线校验未通过`, text: `${d.code}；本事件不是 Host 审批拒绝。`, input: call ? (parse(call.raw) ?? call.raw) : undefined });
    }
    if (['tool.cancelled','tool.failed'].includes(d.type)) {
      items.push({ ...common, kind: 'cancelled', tone: 'warn', title: `${e.tool?.id ?? '工具'} 未执行完成`, text: d.reason ?? d.code ?? d.type });
    }
  }
  return items;
}

function graderView(def, result, before, after, finalText, tests) {
  let label = def.id, expected = '', actual = '', cases = [];
  if (def.kind === 'tool-call-count') {
    const path = def.path ? ` · ${def.path}` : def.exceptPaths ? ` · 除 [${def.exceptPaths.join('、') || '无豁免路径'}] 外` : '';
    label = `${(def.tools ?? []).map(n => toolNames[n] ?? n).join(' / ')}${path}`;
    const range = def.min === def.max ? `必须为 ${def.min} 次` : def.max >= 1000000 ? `至少 ${def.min} 次` : `${def.min}–${def.max} 次`;
    expected = `${phases[def.phase] ?? def.phase}：${range}`;
    actual = result.observedCount === undefined ? '报告未保存次数' : `${result.observedCount} 次`;
  } else if (def.kind === 'file-json-equals') {
    label = `${def.path} 的最终内容`; expected = pretty(def.expected); actual = after[def.path] ?? '没有可重建文件内容';
  } else if (def.kind === 'text-json-equals') {
    label = '最终回复：严格 JSON 及字段'; expected = pretty(def.expected); actual = finalText;
  } else if (def.kind === 'workspace-unchanged-except') {
    label = '保护文件与写入范围'; expected = def.paths.length ? `仅允许改变 ${def.paths.join('、')}；其余文件保持原样` : '所有文件保持原样';
    const changed = [...new Set([...Object.keys(before),...Object.keys(after)])].filter(p => before[p] !== after[p]);
    actual = changed.length ? `观察到变化：${changed.join('、')}` : '没有文件变化';
  } else if (def.kind === 'sandbox-test') {
    const definition = tests.get(def.testId);
    assert(definition, `缺少测试定义：${def.testId}`);
    assert.equal(definition.frozenHash, result.test?.definitionHash, `函数测试定义版本变化：${def.testId}`);
    label = `函数测试 · ${definition.module} → ${definition.export}`;
    for (const c of result.test?.cases ?? []) {
      const cd = definition.cases.find(x => x.id === c.id);
      assert(cd, `缺少测试输入：${def.testId}/${c.id}`);
      cases.push({ id: c.id, args: cd.args, expected: cd.throws ? `应抛出 ${cd.throws}` : cd.expected, status: c.status, actual: testActual(c) });
    }
    expected = `${cases.length} 个用例全部通过`;
    actual = `${cases.filter(c => c.status === 'failed').length} 个失败 / ${cases.filter(c => c.status === 'passed').length} 个通过`;
  }
  return { id: def.id, kind: def.kind, layer: result.layer, status: result.status, label, expected, actual, cases, path: def.path, expectedValue: def.expected, errorCode: result.errorCode };
}

const explanations = {
  'outcome-no-write': ['需要的文件修改没有落地', '失败轮没有派发写入，结果判据未满足。完成回复不能证明文件已经修改。', '按最新任务要求读取并修改目标文件，再依据真实结果回复。'],
  'incorrect-write': ['提交了修改，但仍违反功能契约', '实际文件已改变，独立函数测试仍失败。下方列出具体输入、实际返回值和正确预期，可结合代码差异核对遗漏的条件。', '满足全部公开功能约束并保留调用端接口；参考实现只是一个可行解。'],
  'approval-flow': ['最终状态缺少实际审批事实', '题目要求发生真实 Host 拒绝；未发起请求或参数校验失败，都不能算作 Host 拒绝。', '发起合法目标写请求；实际拒绝后停止写尝试，保持文件原样并回复 denied。'],
  'response-only': ['结果与行为通过，最终回复未满足约束', '仅回复层判据失败。需要区分多余正文/围栏与 JSON 内字段事实错误。', '依据实际观察填写正确字段，只返回约定的合法 JSON。'],
  'gt-migration-scope': ['GT 待裁决：迁移只到顶层吗？', '模型也迁移了 child.retries；冻结 GT 要求保留嵌套字段。题面没有明确仅处理顶层。此处保留原始失败判定。', '先明确只迁移顶层或递归迁移。下方预期为冻结 GT，不代表该争议已经裁决。'],
  'gt-noop-read': ['GT 待裁决：无须修改也必须重读吗？', '请求值已经是当前值，最终状态正确；失败来自未调用 read_file。题面是修改前重读，GT 却对本轮无条件计数。', '先明确每次请求都重读，还是仅在实际修改前重读。保留原始分数，不能直接改判通过。'],
  'gt-reading-tool': ['GT 待裁决：搜索读取是否等价？', 'search_text 返回两份文件的完整单行内容，本轮只读；冻结判据只认可 read_file。没有调用 read_file 不等于没有看到内容。', '明确需要读取内容，还是必须取得指定工具的完整快照/hash。不能无条件把所有搜索视为完整读取。'],
};

export async function buildData(root = ROOT) {
  const json = async p => JSON.parse(await readFile(resolve(root, p), 'utf8'));
  const report = await json(`${BASE}/report.json`), audit = await json(`${BASE}/completion-audit.json`), catalog = await json(`${BASE}/badcase-catalog-v1.json`);
  const verified = new Map();
  const verify = async (p, hash) => {
    const path = resolve(root, p);
    if (verified.has(path)) { assert.equal(verified.get(path), hash); return; }
    assert.equal(sha(await readFile(path)), hash, `冻结证据已变化：${p}`); verified.set(path, hash);
  };
  for (const [p, h] of Object.entries(audit.artifactHashes)) await verify(`${BASE}/${p}`, h);
  assert.equal(catalog.baselineHash, audit.artifactHashes['report.json']);
  assert.equal(catalog.failureEvidenceHash, audit.artifactHashes['failure-evidence.json']);
  const evidence = new Map(report.evidence.map(e => [resolve(root,e.path),e.hash]));
  const tests = new Map();
  for (const p of ['parent','prior','boundary']) {
    const pack = await json(`evals/private/gold-mutations-v2/${p}.tests.json`);
    for (const t of pack.tests) tests.set(`${pack.id}/${t.id}`, { ...t, frozenHash: sha(canonical({ packId: pack.id, packVersion: pack.version, definition: t })) });
  }
  const data = { meta: { baseline: 'baseline-FxEhmE', model: report.model.model, thinking: report.model.thinking,
    dataset: catalog.datasetVersion, total: catalog.totalTrials, failed: catalog.failedTrials, caseCount: catalog.affectedCases,
    reportHash: catalog.baselineHash, counts: catalog.counts, artifactHashes: audit.artifactHashes }, categories: catalog.categoryNames, cases: [] };
  for (const item of catalog.cases) {
    const seedPath = `evals/private/gold-mutations-v2/cases/${item.caseId}.json`, seed = await json(seedPath);
    assert.equal(sha(canonical(seed)), report.cases.find(c => c.caseId === item.caseId).contentHash, `题目版本变化：${item.caseId}`);
    const c = { id: item.caseId, title: item.title, total: item.plannedTrials, failed: item.failedTrials, categories: Object.keys(item.categories),
      capability: seed.capability_id, risk: seed.risk_level, kind: seed.execution.kind, rule: seed.rule, seedPath, trials: [] };
    for (const bt of report.trials.filter(t => t.taskId === c.id)) {
      assert(evidence.has(bt.report), `报告不在冻结证据中：${bt.report}`); await verify(bt.report, evidence.get(bt.report));
      const source = await json(bt.report);
      const results = source.turns ?? [source.trials.find(t => t.taskId === c.id && t.repetition === bt.repetition)];
      const journal = source.journal ?? resolve(dirname(bt.report), results[0].journalRefs[0]);
      assert(evidence.has(journal), `轨迹不在冻结证据中：${journal}`); await verify(journal, evidence.get(journal));
      const events = (await readFile(journal, 'utf8')).trim().split('\n').flatMap(s => { const x = JSON.parse(s); return x.events ?? [x]; });
      const entry = catalog.trials.find(t => t.caseId === c.id && t.repetition === bt.repetition);
      assert.equal(Boolean(entry), !bt.passed, `分类与报告不一致：${c.id}/${bt.repetition}`);
      let state = { ...seed.execution.tasks[0].files };
      const trial = { repetition: bt.repetition, passed: bt.passed, category: entry?.category ?? null, durationMs: bt.durationMs,
        sourceReport: relative(root, bt.report), journal: relative(root, journal), reportHash: evidence.get(bt.report), journalHash: evidence.get(journal), turns: [] };
      for (let i = 0; i < results.length; i++) {
        const r = results[i], task = seed.execution.tasks[i], runEvents = events.filter(e => e.runId === r.runId);
        const before = state, rebuilt = reconstruct(before, runEvents); state = rebuilt.state;
        assert.deepEqual(rebuilt.issues, [], `${c.id}/${bt.repetition}/turn-${i+1} 状态重建存在疑点`);
        const models = runEvents.filter(e => e.data.type === 'model.completed');
        const finalText = models.at(-1)?.data.text ?? '';
        const graders = r.graders.map(g => { const def = task.graders.find(x => x.id === g.id); assert(def); return graderView(def, g, before, state, finalText, tests); });
        const steps = timeline(runEvents), request = runEvents.find(e => e.data.type === 'model.requested')?.data.request;
        assert(request, '缺少模型输入');
        const category = r.passed ? null : entry?.category;
        let summary = category ? explanations[category] : ['本轮所有判据通过', '此轮达到冻结 GT 的结果、行为与回复要求。', '通过状态仅说明本轮符合当前评测契约。'];
        if (c.id === 'GM-P11' && bt.repetition === 1 && !r.passed) summary = [
          '写入参数未通过校验，仍声称完成',
          'write_file 多传了 oldText 字段；JSON 本身合法，但不符合工具 schema，在进入 Host 审批前被拦截。随后 Agent 返回 completed，文件实际未变。',
          explanations['approval-flow'][2],
        ];
        const ref = seed.execution.references?.[i];
        trial.turns.push({ number: r.turn ?? i+1, passed: r.passed, runId: r.runId, prompt: task.prompt, policy: task.executionPolicy,
          summary: { title: summary[0], explanation: summary[1], expected: summary[2] }, category,
          before, after: { ...state }, reference: ref?.mode === 'write' ? ref.files : {}, finalText, graders, steps,
          context: request.messages, modelConfig: { model: request.model, thinking: request.thinking, maxTokens: request.max_tokens, tools: request.tools.map(t => t.function.name) },
          modelCalls: models.length, successfulWrites: rebuilt.commits.length,
          denied: steps.filter(s => s.kind === 'approval' && s.tone === 'warn').length,
          toolCalls: models.reduce((n,m) => n + (m.data.response?.completion?.message?.tool_calls?.length ?? 0), 0),
          stateSource: source.finalFiles ? '成功写入事件重建；执行末态已与原报告 finalFiles 核对' : '初始文件 + 已成功提交的写入事件重建（单轮工作区已清理）',
        });
      }
      if (source.finalFiles) assert.deepEqual(state, source.finalFiles, `${c.id}/${bt.repetition} 末态不一致`);
      c.trials.push(trial);
    }
    assert.equal(c.trials.length, c.total); data.cases.push(c);
  }
  assert.equal(data.cases.length, data.meta.caseCount);
  assert.equal(data.cases.flatMap(c => c.trials).filter(t => !t.passed).length, data.meta.failed);
  data.meta.loadedTrials = data.cases.reduce((n,c) => n + c.trials.length, 0);
  data.meta.verifiedFiles = verified.size;
  return data;
}

// Markdown is a readable fallback for environments that preview .html as source.
const fence = text => { const s = pretty(text) ?? ''; const n = Math.max(3,...[...s.matchAll(/`+/g)].map(m=>m[0].length+1)); return `${'`'.repeat(n)}\n${s}\n${'`'.repeat(n)}`; };
const md = s => String(s ?? '').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/\|/g,'\\|').replace(/\n/g,'<br>');
const joinMarkdown = blocks => blocks.join('\n\n').replace(/^(\|[^\n]*\|)\n\n(?=\|)/gm, '$1\n');
function turnMarkdown(t) {
  const lines = [`## 第 ${t.number} 轮 · ${t.passed ? '通过' : '失败'}`, `**${t.summary.title}**`, t.summary.explanation,
    `### 题目原文`, fence(t.prompt), `### Agent 实际操作`, `模型调用 ${t.modelCalls} 次；请求工具 ${t.toolCalls} 次；成功写入 ${t.successfulWrites} 次；Host 拒绝 ${t.denied} 次。`,
    `| 事件 | 动作 | 结果 |`, `| --- | --- | --- |`,
    ...t.steps.map(s=>`| seq ${s.seq} | ${md(s.title)} | ${md(s.text)} |`),
    `### 最终回复`, fence(t.finalText), `### 为什么失败 / 正确预期`, t.summary.expected,
    `| 判据 | 状态 | 预期 | 实际 |`, `| --- | --- | --- | --- |`,
    ...t.graders.map(g=>`| ${md(g.label)} | ${g.status==='passed'?'通过':'**失败**'} | ${md(g.expected)} | ${md(g.actual)} |`)];
  for (const g of t.graders) for (const c of g.cases.filter(x=>x.status!=='passed')) {
    lines.push(`#### 失败函数用例：${g.id} / ${c.id}`, '输入参数：',fence(c.args), '正确返回：', fence(JSON.stringify(c.expected,null,2)), '实际返回：', fence(c.actual.text));
  }
  if(t.steps.some(s=>s.input!==undefined||s.result!==undefined))lines.push('### 工具证据详情');
  for (const s of t.steps.filter(s => s.input !== undefined || s.result !== undefined)) {
    lines.push(`<details>\n<summary>seq ${s.seq} · ${escapeHTML(s.title)}</summary>\n\n${s.input === undefined ? '' : '调用参数：\n\n'+fence(s.input)+'\n\n'}${s.result === undefined ? '' : '实际返回：\n\n'+fence(s.result?.text ?? s.result)+'\n\n'}</details>`);
  }
  lines.push('### 文件变化',t.stateSource);
  for (const path of Object.keys(t.after)) {
    lines.push(`#### ${path} · ${t.before[path]===t.after[path]?'未变化':'已变化'}`, '本轮开始：', fence(t.before[path]), '本轮结束：', fence(t.after[path]));
    const expected=t.graders.find(g=>g.kind==='file-json-equals'&&g.path===path);
    if(expected)lines.push('冻结 GT 预期：',fence(expected.expectedValue));
    if(t.reference[path])lines.push('参考实现（一个可行解，非唯一正确答案）：',fence(t.reference[path]));
  }
  lines.push('### 实际模型输入（本轮首次请求）');
  for(const m of t.context)lines.push(`**${m.role}**`,fence(m.content??''),...(m.tool_calls?.length?['请求工具：',fence(m.tool_calls)]:[]));
  return joinMarkdown(lines);
}

export async function generate(root = ROOT) {
  const data = await buildData(root), out = resolve(root, 'docs/evaluation-failures');
  await mkdir(resolve(out,'cases'), { recursive:true }); await mkdir(resolve(out,'trials'), { recursive:true });
  const template = await readFile(resolve(ROOT,'scripts/evaluation/failure-explorer.html'), 'utf8');
  const html = template.replace('/*__REPORT_DATA__*/', () => embeddedJSON(data));
  await writeFile(resolve(out,'index.html'),html);
  const index = ['# 失败分析阅读入口', '打开 [交互分析页面](index.html) 可以搜索题目、筛选失败机制，并切换重复执行、轮次与成功对照。',
    `当前纳入 ${data.meta.caseCount} 道失败题目的全部 ${data.meta.loadedTrials} 次执行，其中 ${data.meta.failed} 次失败。原评测总计 858 次执行，738 次通过、120 次失败。`,
    '下列链接打开可直接阅读的题目和轨迹页；原始 JSON 只作为页尾证据保留。',
    '## 使用方法',
    '1. 搜索题号或筛选失败机制/判分层；点击题目后默认定位失败重复与失败轮。\n2. 在“诊断概览”核对题面、实际动作和失败判据；在“动作时间线”展开工具参数与返回。\n3. 在“文件对比”选择文件，查看本轮开始与结束的差异、冻结 GT 或参考实现。\n4. 点击同题“通过”重复作为对照；“模型上下文”展示实际输入。“GT 待裁决”保留原始失败分数。',
    '## 题目目录',
    '| 题目 | 场景 | 失败 / 执行 | 失败重复 |','| --- | --- | ---: | --- |'];
  for (const c of data.cases) {
    const reps = c.trials.filter(t=>!t.passed).map(t=>`[第 ${t.repetition} 次](trials/${c.id}-r${t.repetition}.md)`).join('、');
    index.push(`| [${c.id}](cases/${c.id}.md) | ${c.title} | ${c.failed}/${c.total} | ${reps} |`);
    const caseLines = [`# ${c.id} · ${c.title}`,`[全部题目](../README.md) · [交互页面](../index.html#case=${c.id})`,
      `冻结判定：${c.failed}/${c.total} 次失败。能力 ${c.capability}。${c.rule??''}`,
      `| 重复 | 判定 | 机制 |`, `| --- | --- | --- |`,
      ...c.trials.map(t=>`| [第 ${t.repetition} 次执行](../trials/${c.id}-r${t.repetition}.md) | ${t.passed?'通过':'失败'} | ${data.categories[t.category]??'全部判据通过'} |`),
      '## 测试内容',...c.trials[0].turns.flatMap(t=>[`### 第 ${t.number} 轮`,fence(t.prompt)]),
      `原始定义：[${c.id}.json](../../../${c.seedPath})`];
    await writeFile(resolve(out,`cases/${c.id}.md`),joinMarkdown(caseLines)+'\n');
    for(const t of c.trials) {
      const lines=[`# ${c.id} · 第 ${t.repetition} 次执行`, `[返回题目](../cases/${c.id}.md) · [交互页面](../index.html#case=${c.id}&rep=${t.repetition})`,
        `**原始判定：${t.passed?'通过':'失败'}**。${data.categories[t.category]??'全部判据通过'}。${t.category?.startsWith('gt-')?'GT 待裁决，保留冻结分数，不代表已确认误判。':''}`,
        t.passed ? '' : `失败发生在第 ${t.turns.filter(u=>!u.passed).map(u=>u.number).join('、')} 轮。下文优先展示失败轮，再补充其他轮次。`,
        ...[...t.turns.filter(u=>!u.passed),...t.turns.filter(u=>u.passed)].map(turnMarkdown),'## 原始证据',`[执行报告](../../../${t.sourceReport}) · [事件轨迹](../../../${t.journal})`,
        `报告 SHA-256：${t.reportHash}\n\n轨迹 SHA-256：${t.journalHash}`];
      await writeFile(resolve(out,`trials/${c.id}-r${t.repetition}.md`),joinMarkdown(lines)+'\n');
    }
  }
  index.push('## 重新生成', '在项目根目录执行：', '```sh\nnode scripts/evaluation/build-failure-explorer.mjs\nnode --test scripts/evaluation/build-failure-explorer.test.mjs\n```',
    '页面自包含，可直接用浏览器打开 index.html，不依赖网络。若 Markdown 阅读器不执行 HTML，请使用本目录的题目/执行阅读页。',
    '生成前核对冻结报告、源轨迹和题目版本。可视化是派生视图，不重跑模型，不改写 GT 或原始得分。函数测试通过时若日志未保存返回值，显示“未保存”，不会用预期值冒充实际值。',
    '时间线显示实际模型回复与工具事件，不提供模型内部推理。文件状态由已成功写入的事件重建，多轮末态再与原始 finalFiles 核对。');
  await writeFile(resolve(out,'README.md'),joinMarkdown(index)+'\n');
  const docPath=resolve(root,'docs/evaluation-expansion-badcases.md');
  let doc=await readFile(docPath,'utf8');
  doc=doc.replace(/\[(GM-[BIDP]\d+)\]\(\.\.\/evals\/private\/gold-mutations-v2\/cases\/GM-[BIDP]\d+\.json\)/g,(_,id)=>`[${id}](evaluation-failures/cases/${id}.md)`);
  for(const c of data.cases)for(const t of c.trials.filter(t=>!t.passed))doc=doc.replace(`[${t.repetition}](../${t.journal})`,`[${t.repetition}](evaluation-failures/trials/${c.id}-r${t.repetition}.md)`);
  doc=doc.replace('题目链接可查看原始公开任务，轨迹链接对应确切失败重复。','题目链接打开可读的任务页，重复编号打开对应执行的操作时间线、文件变化与判据对比。');
  if(!doc.includes('交互分析页面'))doc=doc.replace('\n\n分析日期', '\n\n**阅读入口：[交互分析页面](evaluation-failures/index.html) · [可读题目与轨迹目录](evaluation-failures/README.md)**。支持筛选失败机制，切换重复与轮次，并对照实际行为和正确预期。\n\n分析日期');
  await writeFile(docPath,doc);
  const manifest={ schemaVersion:1,sourceReportHash:data.meta.reportHash,cases:data.cases.length,loadedTrials:data.meta.loadedTrials,failedTrials:data.meta.failed,verifiedSourceFiles:data.meta.verifiedFiles,htmlSha256:sha(html) };
  await writeFile(resolve(out,'generation-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(JSON.stringify(await generate(),null,2));
