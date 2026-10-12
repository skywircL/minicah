import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationOutcome } from './mutation-baseline.mjs';
import { groupedResults } from './analyze-mutation-baseline.mjs';
test('mutation groups exclude unavailable trials and weight variants equally in macro averages',()=>{
  const cases=[{caseId:'one',family:'shared',operator:'boundary'},{caseId:'two',family:'shared',operator:'boundary'},{caseId:'three',family:'other',operator:'permission'}];
  const trials=[{taskId:'one',passed:true,classification:'success'},{taskId:'one',passed:true,classification:'success'},{taskId:'two',passed:false,classification:'task-failure'},{taskId:'three',passed:null,classification:'infrastructure-failure'}];
  const [boundary,permission]=groupedResults(cases,trials,'operator');
  assert.equal(boundary.macroPassAt1,0.5);assert.equal(boundary.passed,2);assert.equal(boundary.eligible,3);assert.equal(boundary.families,1);
  assert.equal(permission.eligible,0);assert.equal(permission.excluded,1);assert.equal(permission.macroPassAt1,null);
});
test('three-turn mutation failures survive other unavailable graders while provider errors remain excluded',()=>{
  const g=status=>({required:true,status,weight:1,score:status==='error'?null:status==='passed'?1:0});
  const report={cleanup:'verified',turns:[{status:'completed',graders:[g('passed')]},{status:'completed',graders:[g('passed')]},{status:'completed',graders:[g('failed'),g('error')]}]};
  assert.equal(conversationOutcome(report).passed,false);
  const failed=structuredClone(report);failed.turns[2].status='failed';
  assert.equal(conversationOutcome(failed,[{turn:2,code:'MODEL_HTTP_401'}]).passed,null);
});
