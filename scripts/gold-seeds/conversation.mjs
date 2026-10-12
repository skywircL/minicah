import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Runtime, API_VERSION, services, createSessionPlugin, createContextPlugin, createCodingToolsPlugin, createPermissionPlugin, createToolPipelinePlugin, createCompactionPlugin, createAgentLoopPlugin, createObservabilityPlugin, sessionLogPath } from '../../dist/src/index.js';
import { gradeTask, projectToolTrace } from '../../dist/src/evaluation/index.js';
import { referenceModel, referenceWithFault } from './reference.mjs';

/** Reference scenario driver: one Runtime/Session, staged user turns, optional
 * committed surface replacement. No future turns or graders enter model input.
 * An injected model factory receives only the current public task and tool view. */
export async function executeConversation(seed, artifactDirectory, { negative=false, override: scenarioOverride, modelFactory, agentOptions, signal: externalSignal }={}) {
  let workspace=resolve(artifactDirectory,'workspace');const logs=resolve(artifactDirectory,'sessions');
  await mkdir(workspace,{recursive:true,mode:0o700});await mkdir(logs,{recursive:true,mode:0o700});
  workspace=await realpath(workspace);
  for(const [p,text] of Object.entries(seed.initial_state.files)) {const file=resolve(workspace,p);await mkdir(dirname(file),{recursive:true});await writeFile(file,text,{mode:0o600});}
  let current, model;
  const allowed=p=>current.executionPolicy.allowedTools.includes(p.tool.name);
  const plugin={id:'gold-model',version:'2.0.0',apiVersion:API_VERSION,scope:'runtime',provides:[services.model,services.execution],requires:[],setup(ctx){
    ctx.provide(services.model,()=>({definition:()=>model.definition(),limits:()=>model.limits(),prepare:(messages,tools,output)=>model.prepare(messages,tools.filter(t=>t.name!=='run_command' && current.executionPolicy.allowedTools.includes(t.name)),output),complete:(...args)=>model.complete(...args)}));
    ctx.provide(services.execution,()=>({execute:async()=>{throw new Error('Gold scenarios do not expose command execution');}}));
  }};
  const runtime=await Runtime.create({plugins:[createSessionPlugin({directory:logs,durability:'fsync'}),createContextPlugin(),createObservabilityPlugin(),plugin,createCodingToolsPlugin(workspace,false),createPermissionPlugin(),createToolPipelinePlugin({policy:{authorize:p=>({decision:allowed(p)?'allow':'deny',reason:'gold-scoped-tools'}),assertCurrent:p=>{assert.ok(allowed(p));}},approve:async approval=>({binding:approval.binding,decision:current.executionPolicy.writeApproval==='allow'?'allow':'deny'})},true),createCompactionPlugin(),createAgentLoopPlugin()],config:{permissions:{workspace,policyVersion:'gold-v2',ttlMs:120000}}});
  const report={caseId:seed.case_id,track:'agent-task',driver:'same-session-reference',status:'running',cleanup:'unconfirmed',turns:[],compactionObserved:false,modelApiCalls:modelFactory?null:0,
    journal:resolve(sessionLogPath(logs,'gold-scenario')),pendingCalls:[]};
  const stableCode=error=>/^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '')?error.code:'CONVERSATION_INFRASTRUCTURE';
  let uncertain=false, failed=false;
  try {
    const session=await runtime.openSession('gold-scenario');
    for(const [i,t] of seed.execution.tasks.entries()) {
      if(externalSignal?.aborted) break;
      current=t;
      const publicTask={id:t.id,prompt:t.prompt,files:t.files};
      const selected=scenarioOverride ?? (negative ? seed.negative_cases[0].override : undefined);
      const override=selected && (selected.stage ?? 0)===i ? selected : undefined;
      model=modelFactory ? modelFactory(publicTask) : referenceModel(publicTask,referenceWithFault(seed.execution.references[i],override));
      const deadline=AbortSignal.timeout(seed.trial_protocol.timeoutMs),signal=externalSignal?AbortSignal.any([deadline,externalSignal]):deadline;
      await session.run(async run=>{
        const log=run.services.get(services.session);
        try {
          const result=await run.services.get(services.agentLoop).run(t.prompt,signal,agentOptions?.({...publicTask,history:seed.execution.tasks.slice(0,i).map(task=>task.prompt)}));
          const trace=projectToolTrace(log.events(),run.id);
          // Persist the terminal observation before grading or cleanup can fail.
          const turn={turn:i+1,runId:run.id,status:result.status,trace,graders:[],passed:false};
          if(result.status==='failed' && result.text==='COMPLETION_PROTECTED_CHANGED') {
            turn.confirmedFailure='COMPLETION_PROTECTED_CHANGED';report.confirmedFailure=turn.confirmedFailure;
          }
          report.turns.push(turn);
          const pending=log.state().calls.filter(call=>call.status==='uncertain' || call.terminalSeq===null);
          if(pending.length || result.status==='needs-reconciliation') uncertain=true;
          // Unknown execution must not be followed by reads or sandbox grading.
          if(result.status==='completed' && !uncertain) {
            turn.graders=await gradeTask(t,workspace,result.text,{toolTrace:trace,runId:run.id,signal});
            if(turn.graders.some(grader=>grader.cleanup==='unconfirmed')) uncertain=true;
            turn.passed=!uncertain && turn.graders.every(grader=>grader.status==='passed');
          }
        } finally {
          report.pendingCalls=log.state().calls.filter(call=>call.status==='uncertain' || call.terminalSeq===null).map(call=>({callId:call.callId,runId:call.runId,status:call.status}));
          if(report.pendingCalls.length) uncertain=true;
        }
      });
      // A truthful denied reply has completed status and may accept a NEW user
      // turn. Failed or uncertain runs cannot start another turn or compaction.
      if(uncertain || report.turns.at(-1)?.status!=='completed') break;
      if(seed.execution.compaction?.afterStage===i) {
        await session.run(async run=>{
          const log=run.services.get(services.session),before=log.events(),started=before.find(e=>e.data.type==='run.started');
          await log.start(started.data.versions,{});
          const nodes=run.services.get(services.context).build().surface.nodes;
          assert.ok(nodes.length);
          await log.record([{data:{type:'surface.replaced',id:'gold-compaction',version:'1',text:seed.execution.compaction.text,surfaceOp:{op:'replace',startSeq:nodes[0],endSeq:nodes.at(-1)},sourceEventSeqs:nodes}}]);
          await log.record([{data:{type:'run.finished',status:'completed'}}]);
          assert.deepEqual(log.events().slice(0,before.length),before,'Compaction must preserve the original journal');
          assert.ok(run.services.get(services.context).build().surface.nodes.length<nodes.length);
          report.compactionObserved=log.events().some(e=>e.data.type==='surface.replaced' && e.data.id==='gold-compaction');
        });
      }
    }
    if(seed.execution.compaction && report.turns.length===seed.execution.tasks.length && report.turns.every(turn=>turn.status==='completed')) assert.ok(report.compactionObserved,'Requested compaction was not performed');
  } catch(error) { failed=true;report.failureKind='infrastructure';report.errorCode=stableCode(error); }
  finally {
    try { await runtime.close(); } catch(error) { uncertain=true;report.cleanupErrorCode=stableCode(error); }
    const health=runtime.health();
    report.cleanup=!uncertain && !health.restartRequired && health.unresolved.length===0?'verified':'unconfirmed';
  }
  report.status=report.cleanup!=='verified'?'unknown':externalSignal?.aborted || report.turns.some(turn=>turn.status==='cancelled')?'cancelled':failed || report.turns.some(turn=>turn.status!=='completed')?'failed':'completed';
  report.passed=report.confirmedFailure?false:report.cleanup!=='verified'?null:!failed && report.turns.length===seed.execution.tasks.length && report.turns.every(turn=>turn.passed);
  if(report.cleanup!=='verified') report.retainedWorkspace=workspace;
  report.finalFiles={};report.finalFileErrors=[];
  if(report.cleanup==='verified') for(const p of Object.keys(seed.initial_state.files)) {
    try { report.finalFiles[p]=await readFile(resolve(workspace,p),'utf8'); } catch(error) { report.finalFileErrors.push({path:p,code:stableCode(error)}); }
  }
  return report;
}
