import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Runtime, createSandboxTestPackPlugin, createSandboxTestPlugin, sandboxTestService } from '../../dist/src/index.js';
import { EvaluationRunner } from '../../dist/src/evaluation/index.js';
import { createCodingTrialExecutor } from '../../dist/src/evaluation/coding-executor.js';
import { referenceModel, referenceWithFault } from '../gold-seeds/reference.mjs';
import { executeConversation } from '../gold-seeds/conversation.mjs';
import { calibrationScenarios } from '../gold-seeds/scenarios.mjs';
import { materialize } from './build.mjs';
import { verifyResetReports } from './reset.mjs';
import { directory,root,readJSON,writeJSON,sha,checkManifest,fingerprint } from './common.mjs';

export function verifyTrial(trial,scenario) {
  assert.equal(trial.cleanup,'verified');assert.equal(trial.passed,!scenario.negative);
  assert.ok(trial.graders.length && trial.graders.every(g=>g.status==='passed' || g.status==='failed'),'Unexpected missing/errored oracle');
  if(!scenario.negative)assert.ok(trial.graders.every(g=>g.status==='passed'));
  for(const id of scenario.override?.expectedFailedGraders??[])assert.ok(trial.graders.some(g=>g.id===id && g.status==='failed'),`Expected failed oracle ${id}`);
  for(const id of scenario.override?.expectedPassedGraders??[])assert.ok(trial.graders.some(g=>g.id===id && g.status==='passed'),`Expected surviving oracle ${id}`);
}
export async function calibrate({sandbox='native',image}={}) {
  const manifest=await checkManifest(),version=await fingerprint(),{cases,parentPack,priorPack,boundaryPack}=await materialize();
  const parent=resolve(root,'.minicah/gold-expansion-validation');await mkdir(parent,{recursive:true,mode:0o700});
  const artifacts=await mkdtemp(resolve(parent,'calibration-'));
  const report={schemaVersion:1,status:'running',purpose:'mutation-reference-calibration',modelApiCalls:0,manifestHash:manifest.hash,runtimeHash:version.hash,trials:[],evidence:[],humanReview:'pending',releaseReady:false};
  const path=resolve(artifacts,'report.json'),save=()=>writeJSON(path,report);
  const savePointer=async()=>writeJSON(resolve(directory,'calibration-latest.json'),{status:report.status,manifestHash:manifest.hash,runtimeHash:version.hash,report:path,reportHash:sha(await readFile(path))});
  await save();await savePointer();
  const evidence=async p=>{report.evidence.push({path:p,hash:sha(await readFile(p))});};
  const runner=new EvaluationRunner();let runtime;
  try {
    runtime=await Runtime.create({plugins:[createSandboxTestPackPlugin(parentPack),createSandboxTestPackPlugin(priorPack),createSandboxTestPackPlugin(boundaryPack),createSandboxTestPlugin({backend:sandbox,...(image?{image}:{})})]});
    const jobs=cases.filter(c=>c.execution.kind==='coding').flatMap(seed=>calibrationScenarios(seed).map(scenario=>({seed,scenario})));
    const session=await runtime.openSession();
    await session.run(async run=>{
      for(const id of [...new Set(jobs.map(j=>j.scenario.id))]) {
        const group=jobs.filter(j=>j.scenario.id===id),byId=new Map(group.map(j=>[j.seed.case_id,j]));console.log(`Mutation ${id}: ${group.length}`);
        const result=await runner.run({schemaVersion:1,id:`mutations-${id}`,version:'2.0.0',split:'regression',tasks:group.map(j=>j.seed.execution.tasks[0])},request=>{
          const {seed,scenario}=byId.get(request.task.id);
          return createCodingTrialExecutor({allowWrites:true,modelFactory:()=>referenceModel(request.task,referenceWithFault(seed.execution.references[0],scenario.override))})(request);
        },{outputDirectory:artifacts,repetitions:1,concurrency:1,sandboxTests:run.services.get(sandboxTestService)});
        const file=resolve(result.artifactDirectory,'report.json');await evidence(file);
        for(const trial of result.trials) {
          const {scenario}=byId.get(trial.taskId);
          for(const p of trial.journalRefs)await evidence(resolve(result.artifactDirectory,p));
          report.trials.push({caseId:trial.taskId,scenarioId:id,negative:scenario.negative,passed:trial.passed,cleanup:trial.cleanup,failed:trial.graders.filter(g=>g.status==='failed').map(g=>g.id),report:file});
        }
        await save();assert.equal(result.status,'completed');
        for(const trial of result.trials)verifyTrial(trial,byId.get(trial.taskId).scenario);
      }
    });
    for(const seed of cases.filter(c=>c.execution.kind==='conversation')) for(const scenario of calibrationScenarios(seed)) {
      console.log(`Mutation conversation ${seed.case_id}: ${scenario.id}`);
      const dir=resolve(artifacts,`${seed.case_id}-${scenario.id}`);await mkdir(dir,{mode:0o700});
      const result=await executeConversation(seed,dir,{override:scenario.override});
      const file=resolve(dir,'report.json');await writeJSON(file,result);await evidence(file);await evidence(result.journal);
      const turn=scenario.override?.stage??0;
      report.trials.push({caseId:seed.case_id,scenarioId:scenario.id,negative:scenario.negative,passed:result.passed,cleanup:result.cleanup,failed:result.turns[turn].graders.filter(g=>g.status==='failed').map(g=>g.id),compactionObserved:result.compactionObserved,report:file});await save();
      assert.equal(result.passed,!scenario.negative);
      for(const [i,t] of result.turns.entries())verifyTrial({...t,cleanup:result.cleanup},i===turn?scenario:{negative:false});
    }
    report.resetEvidence=await verifyResetReports(cases,report);
    assert.equal((await checkManifest()).hash,manifest.hash);assert.equal((await fingerprint()).hash,version.hash);report.status='passed';
  } catch(error){report.status='failed';report.error=String(error.message);throw error;}
  finally {try {await runtime?.close();await runner.close();}catch(error){report.status='failed';report.error='CLEANUP_UNCONFIRMED';throw error;}finally {await save();await savePointer();}}
  return {status:report.status,trials:report.trials.length,positives:report.trials.filter(t=>!t.negative).length,negatives:report.trials.filter(t=>t.negative).length,modelApiCalls:0,report:path};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {const {values}=parseArgs({options:{sandbox:{type:'string',default:'native'},image:{type:'string'}}});console.log(JSON.stringify(await calibrate(values)));}
