import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { buildData, reconstruct, testActual, embeddedJSON, escapeHTML, ROOT } from './build-failure-explorer.mjs';
const data = await buildData();
const trial = (id, rep) => data.cases.find(c => c.id === id).trials.find(t => t.repetition === rep);

test('all 120 frozen failures and 197 successful controls are represented, including 17 pending GT trials', () => {
  assert.equal(data.cases.length, 51);
  const trials = data.cases.flatMap(c=>c.trials);
  assert.equal(trials.length,317);
  assert.equal(trials.filter(t=>!t.passed).length,120);
  assert.equal(trials.filter(t=>t.passed).length,197);
  assert.equal(trials.filter(t=>t.category?.startsWith('gt-')).length,17);
  const counts=Object.fromEntries(Object.keys(data.categories).map(k=>[k,trials.filter(t=>t.category===k).length]));
  assert.deepEqual(counts,data.meta.counts);
});

test('D19 starts turn 3 from the actual prior state and retains the failed target separately', () => {
  const t=trial('GM-D19',1).turns[2];
  assert.equal(JSON.parse(t.before['dev.json']).timeout,30);
  assert.equal(JSON.parse(t.after['dev.json']).timeout,30);
  assert.equal(t.graders.find(g=>g.id==='result').expectedValue.timeout,10);
  assert.equal(t.toolCalls,0);
  assert.equal(t.successfulWrites,0);
  assert.equal(t.finalText,'{"status":"completed"}');
  assert(t.context.some(m=>m.content?.includes('当前值是 30')));
});

test('B33 presents real function input/output and a passing control without inventing actual values', () => {
  const t=trial('GM-B33',2).turns[0];
  assert.equal(t.successfulWrites,1);
  const c=t.graders.find(g=>g.id==='boundary').cases[0];
  assert.deepEqual(c.args,[{members:{ok:1},all:['toString','ok','valueOf']}]);
  assert.deepEqual(c.expected,['ok']);
  assert.deepEqual(c.actual.value,['toString','ok','valueOf']);
  const passed=trial('GM-B33',1).turns[0].graders.find(g=>g.id==='boundary').cases[0];
  assert.equal(passed.actual.known,false);
  assert.equal(passed.actual.value,undefined);
});

test('P11 schema rejection is not a successful write or Host refusal', () => {
  const t=trial('GM-P11',1).turns[0];
  assert.equal(t.denied,0);
  assert.equal(t.successfulWrites,0);
  const rejected=t.steps.find(s=>s.kind==='rejected');
  assert(rejected.input.oldText);
  assert.match(rejected.text,/INVALID_ARGUMENTS/);
  assert.deepEqual(t.before,t.after);
});

test('GT cases retain their frozen failures, and D28 shows search content rather than claiming no reading', () => {
  const t=trial('GM-D28',5);
  assert.equal(t.passed,false);
  assert.equal(t.category,'gt-reading-tool');
  const search=t.turns[0].steps.find(s=>s.name==='search_text');
  assert.equal(search.result.truncated,false);
  assert(search.result.matches.some(m=>m.text.includes('"timeout":10')));
  assert.equal(trial('GM-D23',1).turns[2].graders.find(g=>g.id==='result').status,'passed');
});

test('state reconstruction ignores denied/dispatched-only writes, handles literal replacement, and detects bad hashes', () => {
  const planned=(id,input,tool='write_file')=>({callId:id,data:{type:'tool.planned',tool:{id:tool},input}});
  const completed=(id,result)=>({seq:2,callId:id,data:{type:'tool.completed',result}});
  const input={path:'a',content:'changed'};
  for(const result of [{status:'cancelled',dispatched:false},{status:'completed',dispatched:true,value:{ok:false}}]){
    assert.deepEqual(reconstruct({a:'original'},[planned('c',input),completed('c',result)]).state,{a:'original'});
  }
  const r=reconstruct({a:'hello'},[planned('c',{path:'a',oldText:'hello',newText:'$&'},'edit_file'),completed('c',{status:'completed',dispatched:true,value:{ok:true}})]);
  assert.equal(r.state.a,'$&');
  const bad=reconstruct({a:'original'},[planned('c',input),completed('c',{status:'completed',dispatched:true,value:{ok:true,hash:'bad'}})]);
  assert.equal(bad.state.a,null);assert.equal(bad.issues.length,1);
});

test('missing or ambiguous test protocol evidence is marked unknown', () => {
  assert.equal(testActual({status:'passed'}).known,false);
  const frame=x=>'MINICAH_SANDBOX_TEST '+JSON.stringify(x)+'\n';
  const ready={type:'ready',caseId:'x',nonce:'a'}, result={type:'result',caseId:'x',nonce:'a',kind:'return',value:0};
  assert.deepEqual(testActual({id:'x',diagnostics:{value:{stdout:frame(ready)+frame(result)}}}).value,0);
  const utf16=testActual({id:'x',diagnostics:{value:{stdout:frame(ready)+frame({...result,value:'\ud800'})}}});
  assert.equal(utf16.text,JSON.stringify('\ud800'));
  for(const stdout of [frame(result)+frame(ready),frame(ready)+frame({...result,nonce:'b'}),frame(ready)+frame(result)+frame(result)]){
    assert.equal(testActual({id:'x',diagnostics:{value:{stdout}}}).known,false);
  }
});

test('untrusted task/code text cannot break out of embedded JSON or HTML', () => {
  const source='</script><img src=x onerror="alert(1)">\u2028&';
  const embedded=embeddedJSON({source});
  assert(!embedded.includes('<'));
  assert.deepEqual(JSON.parse(embedded),{source});
  assert(!escapeHTML(source).includes('<img'));
});

test('generated UI script parses, data is complete, and original table links open readable pages', async () => {
  const html=await readFile(resolve(ROOT,'docs/evaluation-failures/index.html'),'utf8');
  const scripts=[...html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,2);
  const embedded=JSON.parse(scripts[0][1]);assert.equal(embedded.meta.loadedTrials,317);
  new Script(scripts[1][1]);
  const manifest=JSON.parse(await readFile(resolve(ROOT,'docs/evaluation-failures/generation-manifest.json'),'utf8'));
  assert.equal(manifest.htmlSha256,createHash('sha256').update(html).digest('hex'));
  const doc=await readFile(resolve(ROOT,'docs/evaluation-expansion-badcases.md'),'utf8');
  const table=doc.split('## 完整 51 条失败题目清单')[1].split('\n## ')[0];
  assert.equal((table.match(/evaluation-failures\/cases\//g)??[]).length,51);
  assert.equal((table.match(/evaluation-failures\/trials\//g)??[]).length,120);
  assert(!table.includes('.jsonl)'));
  for(const c of data.cases){
    for(const t of c.trials){
      const path=resolve(ROOT,`docs/evaluation-failures/trials/${c.id}-r${t.repetition}.md`);
      assert((await stat(path)).isFile());
    }
  }
  const md=await readFile(resolve(ROOT,'docs/evaluation-failures/trials/GM-D19-r1.md'),'utf8');
  assert(md.indexOf('## 第 3 轮')<md.indexOf('## 第 1 轮'));
  assert(!/^\|[^\n]*\|\n\n\|/m.test(md),'CommonMark table rows must be contiguous');
});
