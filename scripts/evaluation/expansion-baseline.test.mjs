import assert from 'node:assert/strict';
import test from 'node:test';
import { groupedResults } from './analyze-expansion-baseline.mjs';
import { conversationOutcome } from './expansion-baseline.mjs';
import { wilson, distribution, repeatedStatistics, familyBootstrap, intervalUnion } from './expansion-statistics.mjs';

test('small perfect samples retain wide uncertainty and empty samples remain unknown', () => {
  assert.ok(Math.abs(wilson(3, 3)[0] - 0.4385029682449546) < 1e-12);
  assert.ok(Math.abs(wilson(7, 7)[0] - 0.6456695649333126) < 1e-12);
  assert.equal(wilson(0, 0), null);
  assert.equal(distribution([null, undefined]).p50, null);
  assert.equal(distribution([1, 2, 3, 4, null]).p95, 3.8499999999999996);
});
test('missing trials cannot qualify as stable; all-k and pass^3 use different denominators', () => {
  const meta = [{ caseId: 'a', family: 'f', risk: 'low', repetitions: 3 }, { caseId: 'b', family: 'g', risk: 'high', repetitions: 7 }];
  const row = (taskId, passed) => ({ taskId, passed, classification: passed === null ? 'infrastructure-failure' : passed ? 'success' : 'task-failure' });
  const result = repeatedStatistics(meta, [row('a', true), row('a', true), row('a', null), ...Array.from({ length: 6 }, () => row('b', true)), row('b', false)]);
  assert.equal(result.stability[0].complete, 0);
  assert.equal(result.stability[1].allPassed, 0);
  assert.equal(result.stability[1].atLeastOne, 1);
  assert.ok(Math.abs(result.macroPassPower3 - 4 / 7) < 1e-12);
  assert.equal(result.cases[0].empiricalAllTrials, null);
});
test('family bootstrap is deterministic and does not invent variation in unanimous families', () => {
  const cases = [{ family: 'a', passAt1: 1 }, { family: 'a', passAt1: 1 }, { family: 'b', passAt1: 1 }];
  assert.deepEqual(familyBootstrap(cases, 100).caseMacro, [1, 1]);
  cases[2].passAt1 = 0;
  assert.deepEqual(familyBootstrap(cases, 100), familyBootstrap(cases, 100));
  assert.deepEqual(familyBootstrap(cases, 100).familyMacro, [0, 1]);
  assert.equal(familyBootstrap(cases.slice(0, 2)), null);
});
test('overlapping tool durations do not inflate wall time', () => {
  assert.equal(intervalUnion([[10, 30], [20, 40], [15, 17], [50, 55]]), 35);
});
test('four-turn explicit violations survive unrelated unavailable evidence', () => {
  const turns = Array.from({ length: 4 }, () => ({ status: 'completed', graders: [{ required: true, status: 'passed', weight: 1, score: 1 }] }));
  turns[3].graders = [{ required: true, status: 'failed', weight: 1, score: 0 }, { required: true, status: 'error', weight: 1, score: null }];
  assert.equal(conversationOutcome({ cleanup: 'verified', turns }).passed, false);
  turns[3].graders.shift();
  assert.equal(conversationOutcome({ cleanup: 'verified', turns }).passed, null);
});

test('unequal repetition counts do not weight case macro averages by risk', () => {
  const cases=[{caseId:'a',operator:'test',family:'a'},{caseId:'b',operator:'test',family:'b'}];
  const rows=[...Array.from({length:3},()=>({taskId:'a',passed:true,classification:'success'})),...Array.from({length:7},()=>({taskId:'b',passed:false,classification:'task-failure'}))];
  assert.equal(groupedResults(cases,rows,'operator')[0].macroPassAt1,0.5);
});
