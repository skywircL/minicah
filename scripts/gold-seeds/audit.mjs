import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../../dist/src/json.js';
import { validateSeeds } from './schema.mjs';
import { calibrationScenarios } from './scenarios.mjs';
import { mutationCaseIds } from './mutations.mjs';
import { directory, readJSON, writeJSON, sha, fingerprint, checkManifest, allCapabilities } from './common.mjs';

export function acceptedReviews(index,ledger) {
  assert.ok(Array.isArray(ledger.decisions),'Malformed human-review ledger');
  const accepted=[];
  for(const seed of index.seeds) {
    const current=ledger.decisions.filter(d=>d.caseId===seed.id && d.contentHash===seed.contentHash);
    const reviewers=new Map();
    for(const d of current) {
      assert.ok(typeof d.reviewer==='string' && d.reviewer.trim() && typeof d.reason==='string' && d.reason.trim(),'Review needs an identified reviewer and reason');
      assert.ok(['accept','revise','exclude'].includes(d.decision));
      assert.ok(Number.isFinite(Date.parse(d.reviewedAt)),'Review needs a timestamp');
      assert.equal(d.reviewerKind,'human','AI author review cannot occupy a human slot');
      reviewers.set(d.reviewer.trim().toLowerCase(),d);
    }
    const latest=[...reviewers.values()];
    if(latest.length>=2 && latest.every(d=>d.decision==='accept' && ['relevance','unambiguous','referenceCorrect','assertionsSourced','negativeMeaningful'].every(k=>d.checks?.[k]===true))) accepted.push(seed.id);
  }
  return accepted;
}
export async function audit() {
  const manifest=await checkManifest(),runtime=await fingerprint(),index=await readJSON(resolve(directory,'index.json'));
  const seeds=validateSeeds(await Promise.all(index.seeds.map(row=>readJSON(resolve(directory,row.file)))));
  for(const row of index.seeds) assert.equal(contentHash(seeds.find(s=>s.case_id===row.id)),row.contentHash,'Stale seed index');
  for(const domain of allCapabilities) assert.ok(seeds.some(s=>s.capability_id===domain),`Unrepresented domain ${domain}`);
  const pointer=await readJSON(resolve(directory,'calibration-latest.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  let calibrated=false,report;
  if(pointer?.manifestHash===manifest.hash && pointer.runtimeHash===runtime.hash && pointer.status==='passed') {
    const bytes=await readFile(pointer.report).catch(()=>null);
    if(bytes && sha(bytes)===pointer.reportHash) {
      report=JSON.parse(bytes);
      calibrated=report.status==='passed' && report.manifestHash===manifest.hash && report.runtimeHash===runtime.hash;
      for(const e of report.evidence) {
        const data=await readFile(e.path).catch(()=>null);if(!data || sha(data)!==e.hash) calibrated=false;
      }
      const agents=seeds.filter(s=>s.track==='agent-task'),engineering=seeds.filter(s=>s.track!=='agent-task');
      calibrated &&= report.agentTrials.length===agents.reduce((n,s)=>n+calibrationScenarios(s).length,0) && report.engineering.length===engineering.length;
      for(const s of agents) for(const scenario of calibrationScenarios(s)) {
        const rows=report.agentTrials.filter(t=>t.caseId===s.case_id && t.scenarioId===scenario.id);
        calibrated &&= rows.length===1 && rows[0].negative===scenario.negative && rows[0].expectedPass===!scenario.negative && rows[0].actualPass===!scenario.negative && rows[0].cleanup==='verified';
        calibrated &&= (scenario.override?.expectedFailedGraders ?? []).every(id=>rows[0]?.failedGraders?.includes(id));
        calibrated &&= (scenario.override?.expectedPassedGraders ?? []).every(id=>rows[0]?.passedGraders?.includes(id));
        calibrated &&= (scenario.override?.expectedErroredGraders ?? []).every(id=>rows[0]?.erroredGraders?.includes(id));
        if(s.execution.compaction) calibrated &&= rows[0]?.compactionObserved===true;
      }
      for(const s of engineering) calibrated &&= report.engineering.filter(c=>c.caseId===s.case_id && c.passed).length===1;
      calibrated &&= report.mutations?.length===mutationCaseIds.length && mutationCaseIds.every(id=>report.mutations.filter(m=>m.caseId===id && m.passed && m.originalHash!==m.mutantHash).length===1);
    }
  }
  const reviews=await readJSON(resolve(directory,'human-reviews.json')),accepted=acceptedReviews(index,reviews);
  const result={schemaVersion:1,status:'structurally-valid',manifestHash:manifest.hash,runtimeHash:runtime.hash,seedCandidates:seeds.length,
    tracks:Object.fromEntries(['agent-task','harness-contract','platform-contract'].map(t=>[t,seeds.filter(s=>s.track===t).length])),domainsRepresented:allCapabilities.length,
    calibrationCurrent:!!calibrated,engineeringReady:!!calibrated,acceptedGold:calibrated?accepted:[],humanReview:accepted.length===seeds.length?'accepted':'pending',
    candidatePackageReady:!!calibrated,releaseReady:false,
    limitations:['Reference programs are AI-authored, not independently human-performed.','No real-model reliability score was produced.','Domain representation does not imply every leaf is covered.','A3 execution and A5 automatic summary semantics retain declared coverage limits.','Deployment-platform isolation and product release thresholds require separate evidence.']};
  await writeJSON(resolve(directory,'audit-report.json'),result);return result;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {const r=await audit();console.log(JSON.stringify(r));process.exitCode=r.candidatePackageReady?0:1;}
