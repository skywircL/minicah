import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Runtime, createSandboxTestPackPlugin, createSandboxTestPlugin, sandboxTestService } from '../../dist/src/index.js';
import { EvaluationRunner } from '../../dist/src/evaluation/index.js';
import { createCodingTrialExecutor } from '../../dist/src/evaluation/coding-executor.js';
import { validateSeeds } from './schema.mjs';
import { referenceModel, referenceWithFault } from './reference.mjs';
import { executeConversation } from './conversation.mjs';
import { calibrationScenarios } from './scenarios.mjs';
import { runMutations } from './mutations.mjs';
import { runEngineering } from './engineering.mjs';
import { root, directory, readJSON, writeJSON, sha, fingerprint, checkManifest } from './common.mjs';

export async function calibrate({sandbox='native',image}={}) {
  const manifest=await checkManifest(),version=await fingerprint();
  const index=await readJSON(resolve(directory,'index.json'));
  const seeds=validateSeeds(await Promise.all(index.seeds.map(r=>readJSON(resolve(directory,r.file)))));
  const parent=resolve(root,'.minicah/gold-seed-validation');await mkdir(parent,{recursive:true,mode:0o700});
  const artifacts=await mkdtemp(resolve(parent,'calibration-'));
  const report={schemaVersion:1,status:'running',purpose:'gold-reference-calibration',modelApiCalls:0,manifestHash:manifest.hash,runtimeHash:version.hash,artifactDirectory:artifacts,agentTrials:[],engineering:[],evidence:[],humanReview:'pending',acceptedGold:0,releaseReady:false};
  const reportPath=resolve(artifacts,'report.json');
  await writeJSON(resolve(artifacts,'runtime.json'),version);
  const save=()=>writeJSON(reportPath,report);
  const runner=new EvaluationRunner();let runtime;
  try {
    const singles=seeds.filter(s=>s.execution.kind==='coding');
    const jobs=singles.flatMap(seed=>calibrationScenarios(seed).map(scenario=>({seed,scenario})));
    runtime=await Runtime.create({plugins:[createSandboxTestPackPlugin(await readJSON(resolve(directory,'agent.tests.json'))),createSandboxTestPlugin({backend:sandbox,...(image?{image}:{})})]});
    const check=(trial,scenario)=>{
      assert.equal(trial.passed,!scenario.negative,'Reference/counterexample mismatch');
      for(const id of scenario.override?.expectedFailedGraders ?? []) assert.ok(trial.graders.some(g=>g.id===id && g.status==='failed'),`Expected failing oracle: ${id}`);
      for(const id of scenario.override?.expectedPassedGraders ?? []) assert.ok(trial.graders.some(g=>g.id===id && g.status==='passed'),`Expected surviving oracle: ${id}`);
      for(const id of scenario.override?.expectedErroredGraders ?? []) assert.ok(trial.graders.some(g=>g.id===id && g.status==='error'),`Expected unavailable oracle: ${id}`);
    };
    const session=await runtime.openSession();
    await session.run(async run=>{
      for(const scenarioId of [...new Set(jobs.map(j=>j.scenario.id))]) {
        const group=jobs.filter(j=>j.scenario.id===scenarioId),byTask=new Map(group.map(j=>[j.seed.case_id,j]));
        console.log(`Gold single-turn ${scenarioId}: ${group.length}`);
        const suite={schemaVersion:1,id:`gold-${scenarioId}`,version:'2.3.2',split:'regression',tasks:group.map(j=>j.seed.execution.tasks[0])};
        const result=await runner.run(suite,request=>{
          const {seed,scenario}=byTask.get(request.task.id),ref=referenceWithFault(seed.execution.references[0],scenario.override);
          return createCodingTrialExecutor({allowWrites:true,modelFactory:()=>referenceModel(request.task,ref)})(request);
        },{outputDirectory:artifacts,repetitions:1,concurrency:1,sandboxTests:run.services.get(sandboxTestService)});
        const file=resolve(result.artifactDirectory,'report.json');report.evidence.push({path:file,hash:sha(await readFile(file))});
        for(const trial of result.trials) {
          const {scenario}=byTask.get(trial.taskId);
          report.agentTrials.push({caseId:trial.taskId,scenarioId,negative:scenario.negative,expectedPass:!scenario.negative,actualPass:trial.passed,classification:trial.classification,cleanup:trial.cleanup,erroredGraders:trial.graders.filter(g=>g.status==='error').map(g=>g.id),failedGraders:trial.graders.filter(g=>g.status==='failed').map(g=>g.id),passedGraders:trial.graders.filter(g=>g.status==='passed').map(g=>g.id),report:file});
        }
        await save();assert.equal(result.status,'completed');
        for(const trial of result.trials) check(trial,byTask.get(trial.taskId).scenario);
      }
    });
    for(const seed of seeds.filter(s=>s.execution.kind==='conversation')) for(const scenario of calibrationScenarios(seed)) {
      console.log(`Gold conversation ${seed.case_id}: ${scenario.id}`);
      const dir=resolve(artifacts,`${seed.case_id}-${scenario.id}`);await mkdir(dir,{mode:0o700});
      const result=await executeConversation(seed,dir,{negative:scenario.negative,override:scenario.override}),file=resolve(dir,'report.json');await writeJSON(file,result);
      report.evidence.push({path:file,hash:sha(await readFile(file))},{path:result.journal,hash:sha(await readFile(result.journal))});
      const graders=result.turns[scenario.override?.stage ?? 0].graders;
      report.agentTrials.push({caseId:seed.case_id,scenarioId:scenario.id,negative:scenario.negative,expectedPass:!scenario.negative,actualPass:result.passed,cleanup:result.cleanup,compactionObserved:result.compactionObserved,erroredGraders:graders.filter(g=>g.status==='error').map(g=>g.id),failedGraders:graders.filter(g=>g.status==='failed').map(g=>g.id),passedGraders:graders.filter(g=>g.status==='passed').map(g=>g.id),report:file});
      await save();check({passed:result.passed,graders},scenario);
    }
    console.log(`Gold deterministic contracts: ${seeds.filter(s=>s.execution.kind==='node-test').length} seeds`);
    const engineering=await runEngineering(seeds.filter(s=>s.execution.kind==='node-test'),artifacts);
    report.engineering=engineering.cases;report.evidence.push(...engineering.evidence);
    assert.ok(report.engineering.every(c=>c.passed),'Engineering contract failed');
    const mutations=await runMutations(artifacts);
    report.mutations=mutations.cases;report.evidence.push(...mutations.evidence);
    await save();assert.ok(report.mutations.every(c=>c.passed),'A declared faulty implementation survived its oracle');
    assert.equal((await fingerprint()).hash,version.hash,'Runtime changed during calibration');
    assert.equal((await checkManifest()).hash,manifest.hash,'Dataset changed during calibration');
    report.status='passed';
  } catch(error) {report.status='failed';report.error=String(error.message);throw error;}
  finally {try{await runtime?.close();await runner.close();}catch(error){report.status='failed';report.error='CLEANUP_UNCONFIRMED';throw error;}finally{await save();}}
  await writeJSON(resolve(directory,'calibration-latest.json'),{status:report.status,manifestHash:manifest.hash,runtimeHash:version.hash,report:reportPath,reportHash:sha(await readFile(reportPath))});
  return report;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {values}=parseArgs({options:{sandbox:{type:'string',default:'native'},image:{type:'string'}}});
  const report=await calibrate(values);console.log(JSON.stringify({status:report.status,agentTrials:report.agentTrials.length,engineeringSeeds:report.engineering.length,artifacts:report.artifactDirectory}));
}
