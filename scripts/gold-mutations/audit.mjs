import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../../dist/src/json.js';
import { acceptedReviews } from '../gold-seeds/audit.mjs';
import { calibrationScenarios } from '../gold-seeds/scenarios.mjs';
import { materialize } from './build.mjs';
import { verifyTrial } from './calibrate.mjs';
import { directory,readJSON,writeJSON,sha,checkManifest,fingerprint } from './common.mjs';

export function validateCases(cases,canonical,index) {
  assert.equal(cases.length,canonical.length);assert.equal(index.cases.length,cases.length);
  assert.equal(new Set(cases.map(c=>c.case_id)).size,cases.length);
  for(const c of cases) {
    const expected=canonical.find(x=>x.case_id===c.case_id),row=index.cases.find(r=>r.id===c.case_id);assert.ok(expected && row);
    assert.deepEqual(c,expected,'Derived artifact must match the declared operator and authored rule');
    assert.equal(row.contentHash,contentHash(c));assert.equal(row.parentContentHash,c.parentContentHash);
    assert.equal(row.parentId,c.seed_id);assert.equal(row.family,c.family_id);assert.equal(row.upstreamFamily,c.upstreamFamily);
    assert.equal(c.split,'gold_dev');assert.equal(row.split,c.split);assert.equal(row.operator,c.mutation_type);assert.equal(row.bucket,c.bucket);
    assert.notEqual(c.case_id,c.seed_id);assert.equal(c.family_id,c.seed_id);
  }
  assert.equal(index.newIndependentSeeds,0);assert.equal(index.hiddenCases,0);
  assert.equal(index.parentFamilies,new Set(cases.map(c=>c.family_id)).size);
}
export async function audit() {
  const manifest=await checkManifest(),runtime=await fingerprint(),index=await readJSON(resolve(directory,'index.json'));
  const {cases:canonical}=await materialize();
  const cases=await Promise.all(index.cases.map(r=>readJSON(resolve(directory,r.file))));validateCases(cases,canonical,index);
  const lineage=await readJSON(resolve(directory,'lineage.json'));assert.deepEqual(lineage.cases,index.cases);
  const pointer=await readJSON(resolve(directory,'calibration-latest.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  let calibrated=false,report;
  if(pointer?.status==='passed' && pointer.manifestHash===manifest.hash && pointer.runtimeHash===runtime.hash) {
    const bytes=await readFile(pointer.report);assert.equal(sha(bytes),pointer.reportHash);report=JSON.parse(bytes);
    assert.equal(report.status,'passed');assert.equal(report.manifestHash,manifest.hash);assert.equal(report.runtimeHash,runtime.hash);assert.equal(report.modelApiCalls,0);
    const evidence=new Map();for(const e of report.evidence){assert.equal(sha(await readFile(e.path)),e.hash);evidence.set(e.path,e.hash);}
    assert.equal(report.trials.length,cases.reduce((n,c)=>n+calibrationScenarios(c).length,0));
    for(const c of cases) for(const scenario of calibrationScenarios(c)) {
      const rows=report.trials.filter(t=>t.caseId===c.case_id && t.scenarioId===scenario.id);assert.equal(rows.length,1);
      const row=rows[0];assert.equal(row.negative,scenario.negative);assert.equal(row.passed,!scenario.negative);assert.equal(row.cleanup,'verified');assert.ok(evidence.has(row.report));
      const source=await readJSON(row.report);assert.equal(source.status,'completed');
      if(c.execution.kind==='coding') {
        const trials=source.trials.filter(t=>t.taskId===c.case_id);assert.equal(trials.length,1);verifyTrial(trials[0],scenario);
        assert.ok(trials[0].journalRefs.length);for(const p of trials[0].journalRefs)assert.ok(evidence.has(resolve(dirname(row.report),p)));
      } else {
        assert.equal(source.turns.length,c.execution.tasks.length);assert.equal(source.passed,!scenario.negative);assert.ok(evidence.has(source.journal));
        assert.equal(new Set(source.turns.map(t=>t.runId)).size,source.turns.length);
        for(const [i,t] of source.turns.entries())verifyTrial({...t,cleanup:source.cleanup},i===(scenario.override?.stage??0)?scenario:{negative:false});
        if(c.execution.compaction)assert.equal(source.compactionObserved,true);
      }
    }
    calibrated=true;
  }
  const ledger=await readJSON(resolve(directory,'human-reviews.json')),accepted=acceptedReviews({seeds:index.cases},ledger);
  const result={schemaVersion:1,status:'structurally-valid',version:index.version,parentVersion:index.parentVersion,manifestHash:manifest.hash,runtimeHash:runtime.hash,derivedCases:cases.length,parentFamilies:index.parentFamilies,newIndependentSeeds:0,hiddenCases:0,operators:Object.fromEntries(['boundary','permission','adversarial','dialogue'].map(k=>[k,cases.filter(c=>c.mutation_type===k).length])),calibrationCurrent:calibrated,referenceTrials:calibrated?report.trials.length:0,referencePasses:calibrated?report.trials.filter(t=>!t.negative).length:0,negativeRejections:calibrated?report.trials.filter(t=>t.negative).length:0,modelApiCalls:0,modelScore:null,candidatePackageReady:calibrated,acceptedMutations:calibrated?accepted:[],humanReview:accepted.length===cases.length?'accepted':'pending',releaseReady:false};
  await writeJSON(resolve(directory,'audit-report.json'),result);return result;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){const r=await audit();console.log(JSON.stringify(r));process.exitCode=r.candidatePackageReady?0:1;}
