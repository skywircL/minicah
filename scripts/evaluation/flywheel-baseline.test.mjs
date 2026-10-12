import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyEvidence, combineFirstProposals, trialFailurePatch, mustStopTrial, closeBaselineResources, isSummaryRequest, scheduleTrials, summarizeTrials, summarizeUsage, verifySnapshot, loadDataset, runFlywheelBaseline, root } from './flywheel-baseline.mjs';

const seed = (id, repetitions, turns = 1) => ({ case_id: id, trial_protocol: { modelTrials: repetitions }, execution: { tasks: Array(turns).fill({}) } });

test('full episode pairs alternate AB/BA and preserve different risk repetition counts', () => {
  const schedule = scheduleTrials([seed('normal', 3), seed('dialogue', 7, 4)]);
  assert.equal(schedule.length, 20);
  assert.deepEqual(schedule.slice(0, 4).map(row => row.arm), ['old', 'new', 'new', 'old']);
  assert.equal(schedule.filter(row => row.taskId === 'dialogue').length, 14);
  for (let i = 0; i < schedule.length; i += 2) {
    assert.equal(schedule[i].pairId, schedule[i + 1].pairId);
    assert.notEqual(schedule[i].arm, schedule[i + 1].arm);
    assert.equal(schedule[i].turns, schedule[i + 1].turns);
  }
  assert.equal(scheduleTrials([seed('x', 7)], 3).length, 6);
  assert.throws(() => scheduleTrials([seed('x', 7)], 0));
});

test('known required failure survives missing grader evidence; cleanup ambiguity remains excluded', () => {
  const graders = [{ required: true, status: 'failed', score: 0 }, { required: true, status: 'error', score: null }];
  assert.equal(classifyEvidence(graders).passed, false);
  assert.equal(classifyEvidence(graders.slice(1)).passed, null);
  assert.equal(classifyEvidence(graders, { cleanup: 'unconfirmed' }).passed, null);
  assert.equal(classifyEvidence([{ required: false, status: 'failed', score: 0 }, { status: 'passed', score: 1 }]).passed, true);
});

test('first-proposal failures dominate missing or ungraded turns without manufacturing passes', () => {
  const passed = { graders: [{ required: true, status: 'passed', score: 1 }] };
  const failed = { graders: [{ required: true, status: 'failed', score: 0 }] };
  assert.equal(combineFirstProposals([failed], 3).passed, false);
  assert.equal(combineFirstProposals([failed, {}], 3).passed, false);
  assert.equal(combineFirstProposals([passed], 3).passed, null);
  assert.equal(combineFirstProposals([passed, {}], 2).passed, null);
  assert.equal(combineFirstProposals([passed, passed], 2).passed, true);
  assert.equal(combineFirstProposals([failed, { graders: [{ status: 'error', cleanup: 'unconfirmed' }] }], 3).passed, null);
});

test('post-execution diagnostic exceptions preserve verified scores but never rescue unknown cleanup', () => {
  for (const passed of [false, true]) {
    const row = { cleanup: 'verified', passed, classification: passed ? 'success' : 'task-failure', score: passed ? 1 : 0, turns: 2, candidates: [] };
    const result = { ...row, ...trialFailurePatch(row, 'ERR_ASSERTION', '/workspace') };
    assert.equal(result.passed, passed);
    assert.equal(result.classification, row.classification);
    assert.equal(result.score, row.score);
    assert.equal(result.diagnosticErrorCode, 'ERR_ASSERTION');
    assert.equal(result.firstProposal.passed, null);
  }
  const observedFailure = { cleanup: 'verified', passed: true, turns: 2, candidates: [{ graders: [{ required: true, status: 'failed', score: 0 }] }, {}] };
  assert.equal(trialFailurePatch(observedFailure, 'ERR_ASSERTION', '/workspace').firstProposal.passed, false);
  const unknown = trialFailurePatch({ cleanup: 'unconfirmed', passed: false }, 'ERR_ASSERTION', '/workspace');
  assert.equal(unknown.passed, null);
  assert.equal(unknown.classification, 'infrastructure-failure');
  assert.equal(unknown.retainedWorkspace, '/workspace');
  assert.equal(trialFailurePatch({ passed: null }, 'ERR_ASSERTION', '/workspace').passed, null);
});

test('confirmed violations survive diagnostic failures without clearing unknown status or allowing another trial', async () => {
  const row={confirmedFailure:'COMPLETION_PROTECTED_CHANGED',cleanup:'unconfirmed',status:'unknown',classification:'agent-failure',passed:false,score:null};
  const result={...row,...trialFailurePatch(row,'JOURNAL_READ_FAILED','/retained/workspace')};
  assert.equal(result.passed,false);assert.equal(result.classification,'agent-failure');
  assert.equal(result.status,'unknown');assert.equal(result.cleanup,'unconfirmed');
  assert.equal(result.retainedWorkspace,'/retained/workspace');assert.equal(mustStopTrial(result),true);
  assert.equal(mustStopTrial({classification:'agent-failure',status:'failed',cleanup:'verified'}),false);
  assert.equal(mustStopTrial({classification:'task-failure',status:'completed',cleanup:'unconfirmed'}),true);
  let closed=0;
  const cleanup=await closeBaselineResources({close:async()=>{throw new Error('unknown cleanup');}},{close:async()=>{closed++;}});
  assert.equal(closed,1);assert.deepEqual(cleanup.map(item=>item.status),['rejected','fulfilled']);
});

function stoppedConversationSeed() {
  const files={'prod.json':'{"timeout":60}'};
  const task=id=>({id,prompt:'Keep prod.json unchanged. Reply only JSON.',files,
    executionPolicy:{allowedTools:['write_file','run_command'],writeApproval:'allow'},
    graders:[{id:'preserve',kind:'file-json-equals',path:'prod.json',expected:{timeout:60}}]});
  return {case_id:'guard-stop-fixture',initial_state:{files},trial_protocol:{timeoutMs:10_000},
    execution:{kind:'conversation',tasks:[task('first'),task('second')],compaction:{afterStage:0,text:'Historical checkpoint'}}};
}

async function stoppedConversationModel(withUnknown=false) {
  const {deepSeekModel,deepSeekConfig,contentHash}=await import('../../dist/src/index.js');
  const base=deepSeekModel(deepSeekConfig({}),'fixture-no-network');
  return {...base,async complete(){return {providerId:'local-fixture',finishReason:'tool_calls',usage:{prompt:1,completion:1,total:2},
    message:{role:'assistant',content:null,tool_calls:[
      {id:'write-protected',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'prod.json',content:'{"timeout":99}',expectedHash:contentHash('{"timeout":60}')})}},
      ...(withUnknown?[{id:'unknown-command',type:'function',function:{name:'run_command',arguments:JSON.stringify({command:'not-executed',args:[]})}}]:[]),
    ]}};}};
}

test('conversation retains a known protection failure alongside unknown tool facts and stops before another turn or compaction',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'flywheel-conversation-unknown-'));
  const {executeConversation}=await import('../gold-seeds/conversation.mjs');
  let turnsStarted=0;const model=await stoppedConversationModel(true);
  try {
    const report=await executeConversation(stoppedConversationSeed(),directory,{modelFactory:()=>{turnsStarted++;return model;},agentOptions:()=>({completion:{preservePaths:['prod.json']}})});
    assert.equal(turnsStarted,1);assert.equal(report.turns.length,1);assert.equal(report.compactionObserved,false);
    assert.equal(report.confirmedFailure,'COMPLETION_PROTECTED_CHANGED');assert.equal(report.passed,false);
    assert.equal(report.status,'unknown');assert.equal(report.cleanup,'unconfirmed');assert.ok(report.pendingCalls.length);
    assert.equal(report.retainedWorkspace,await realpath(resolve(directory,'workspace')));
    const {readJournalSnapshot}=await import('../../dist/src/session/file-journal.js'),{events}=await readJournalSnapshot(report.journal);
    assert.ok(events.some(event=>event.data.type==='tool.uncertain'));assert.ok(!events.some(event=>event.data.type==='surface.replaced'));
    assert.deepEqual(classifyEvidence([],{...report}),{classification:'agent-failure',passed:false,score:null});
    assert.equal(mustStopTrial(report),true);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('conversation cleanup rejection preserves the earlier confirmed failure and does not start the next turn',async t=>{
  const directory=await mkdtemp(resolve(tmpdir(),'flywheel-conversation-close-'));
  const {Runtime}=await import('../../dist/src/index.js'),{executeConversation}=await import('../gold-seeds/conversation.mjs');
  const original=Runtime.prototype.close;
  t.mock.method(Runtime.prototype,'close',async function(){await original.call(this);throw Object.assign(new Error('fixture cleanup rejection'),{code:'EVAL_CLEANUP_UNCONFIRMED'});});
  let turnsStarted=0;const model=await stoppedConversationModel();
  try {
    const report=await executeConversation(stoppedConversationSeed(),directory,{modelFactory:()=>{turnsStarted++;return model;},agentOptions:()=>({completion:{preservePaths:['prod.json']}})});
    assert.equal(turnsStarted,1);assert.equal(report.turns.length,1);assert.equal(report.compactionObserved,false);
    assert.equal(report.status,'unknown');assert.equal(report.cleanup,'unconfirmed');assert.equal(report.passed,false);
    assert.equal(report.cleanupErrorCode,'EVAL_CLEANUP_UNCONFIRMED');assert.equal(report.confirmedFailure,'COMPLETION_PROTECTED_CHANGED');
    const {readJournalSnapshot}=await import('../../dist/src/session/file-journal.js'),{events}=await readJournalSnapshot(report.journal);
    assert.ok(events.some(event=>event.data.type==='task.status' && event.data.detail==='COMPLETION_PROTECTED_CHANGED'));
    assert.equal(trialFailurePatch(report,'DIAGNOSTIC_FAILED',report.retainedWorkspace).passed,false);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('paired gains and first-proposal recoveries keep failures, unknown usage and incomplete pairs separate', () => {
  const known = { usage: { prompt: 10, completion: 5, total: 15 }, durationMs: 2, phase: 'first' };
  const unknown = { usage: null, durationMs: 3, phase: 'continuation' };
  const rows = [
    { pairId: 'a', arm: 'old', passed: false, firstProposal: { passed: false }, modelCalls: [known] },
    { pairId: 'a', arm: 'new', passed: true, firstProposal: { passed: false }, modelCalls: [known, unknown] },
    { pairId: 'b', arm: 'old', passed: true }, { pairId: 'b', arm: 'new', passed: false },
    { pairId: 'c', arm: 'old', passed: null }, { pairId: 'c', arm: 'new', passed: true },
  ];
  const result = summarizeTrials(rows);
  assert.deepEqual(result.paired, { eligible: 2, bothPassed: 0, bothFailed: 0, improved: 1, regressed: 1, incomplete: 1 });
  assert.equal(result.arms.new.recovered, 1);
  assert.equal(result.arms.new.continuationUsage.requests, 1);
  assert.equal(result.arms.new.continuationUsage.missingUsage, 1);
  assert.equal(result.arms.old.final.excluded, 1);
  assert.deepEqual(summarizeUsage([known, unknown]).observedTokens, { prompt: 10, completion: 5, total: 15 });
});

test('snapshot integrity verification rejects a changed input', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'flywheel-integrity-'));
  try {
    await writeFile(resolve(directory, 'snapshot.json'), JSON.stringify({ files: [{ path: 'src/agent/loop.ts', sha256: 'bad' }, { path: 'dist/src/agent/loop.js', sha256: 'bad' }] }));
    await assert.rejects(verifySnapshot(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('new dataset and pre-change snapshot verify independently from historical runtime locks', async () => {
  const [dataset, snapshot] = await Promise.all([loadDataset(resolve(root, 'evals/private/gold-flywheel-v1')), verifySnapshot(resolve(root, '.minicah/flywheel-iteration/pre-change'))]);
  assert.equal(dataset.seeds.length, 150);
  assert.equal(snapshot.hash.length, 64);
  assert.equal(dataset.index.cases.find(row => row.id === 'GM-D19').id, 'GM-D19');
});

test('scripted paired driver uses isolated complete episodes and offline first-proposal grading without API', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'flywheel-driver-'));
  const dataset = await loadDataset(resolve(root, 'evals/private/gold-flywheel-v1'));
  const { referenceModel } = await import('../gold-seeds/reference.mjs');
  try {
    const report = await runFlywheelBaseline({ cases: ['GM-B01', 'GM-D02'], repetitions: 1, output: directory,
      testModelFactory(task) {
        const selected = dataset.seeds.find(seed => seed.execution.tasks.some(turn => turn.id === task.id));
        const index = selected.execution.tasks.findIndex(turn => turn.id === task.id);
        return referenceModel(task, selected.execution.references[index]);
      } });
    assert.equal(report.status, 'completed', JSON.stringify(report.trials.map(row => ({ id: row.taskId, status: row.classification, error: row.errorCode }))));
    assert.equal(report.purpose, 'scripted-driver-validation');
    assert.equal(report.aggregate.paired.bothPassed, 2);
    assert.equal(report.aggregate.arms.old.firstProposal.passed, 2, JSON.stringify(report.trials.map(row=>({id:row.taskId,first:row.firstProposal,c:row.candidates.map(c=>c.graders)}))));
    assert.equal(report.aggregate.arms.new.firstProposal.passed, 2);
    assert.equal(report.aggregate.arms.new.continuationUsage.requests, 0);
    const journals = report.trials.flatMap(row => row.journals);
    assert.equal(new Set(journals).size, 4);
    assert.ok(report.trials.every(row => row.candidates.length === row.turns));
    const plan = JSON.parse(await readFile(resolve(report.artifactDirectory, 'plan.json'), 'utf8'));
    assert.equal(plan.protocol.hiddenGTToModel, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('only the trusted summary prompt marks compaction, including tool-free response repair', () => {
  const summary = { content: 'Trusted historical summary prompt' };
  assert.equal(isSummaryRequest([{ role: 'system', content: summary.content }], summary), true);
  assert.equal(isSummaryRequest([{ role: 'system', content: 'Agent system prompt' }, { role: 'user', content: summary.content }], summary), false);
  assert.equal(isSummaryRequest([], summary), false);
});

test('paired driver preserves first failure and charges guard and tool-free response repair separately', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'flywheel-recovery-'));
  const dataset = await loadDataset(resolve(root, 'evals/private/gold-flywheel-v1'));
  const { referenceModel } = await import('../gold-seeds/reference.mjs');
  try {
    const report = await runFlywheelBaseline({ cases: ['GM-D19', 'GM-B01'], repetitions: 1, output: directory,
      testModelFactory(task) {
        const selected = dataset.seeds.find(seed => seed.execution.tasks.some(turn => turn.id === task.id));
        const index = selected.execution.tasks.findIndex(turn => turn.id === task.id);
        const reference = referenceModel(task, selected.execution.references[index]);
        let first = true, fenced = false;
        return { ...reference, async complete(request) {
          if (selected.case_id === 'GM-D19' && index === 2 && first) {
            first = false;
            return { message: { role: 'assistant', content: '{"status":"completed"}' }, finishReason: 'stop', usage: { prompt: 1, completion: 1, total: 2 }, providerId: 'premature' };
          }
          const answer = await reference.complete(request);
          if (selected.case_id === 'GM-B01' && answer.finishReason === 'stop' && !fenced) {
            fenced = true; return { ...answer, message: { ...answer.message, content: '```json\n' + answer.message.content + '\n```' }, usage: { prompt: 2, completion: 3, total: 5 } };
          }
          return { ...answer, usage: { prompt: 2, completion: 3, total: 5 } };
        } };
      } });
    assert.equal(report.status, 'completed');
    assert.equal(report.aggregate.arms.old.final.failed, 2);
    assert.equal(report.aggregate.arms.new.final.passed, 2);
    assert.equal(report.aggregate.arms.new.firstProposal.failed, 2);
    assert.equal(report.aggregate.arms.new.recovered, 2);
    assert.equal(report.aggregate.arms.old.continuationUsage.requests, 0);
    assert.ok(report.aggregate.arms.new.continuationUsage.requests >= 4);
    assert.ok(report.trials.filter(row=>row.arm==='new').every(row=>row.guardEvents.some(event=>event.measurement.phase === 'candidate')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
