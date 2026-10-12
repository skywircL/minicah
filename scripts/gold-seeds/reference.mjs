import assert from 'node:assert/strict';
import { definition } from '../../dist/src/index.js';

export function referenceWithFault(reference, override) {
  if(!override) return structuredClone(reference);
  const copy=structuredClone(reference);
  if(override.files!==undefined) copy.files=override.files;
  if(override.extraFiles) copy.files={...copy.files,...override.extraFiles};
  if(override.mode) copy.mode=override.mode;
  if(override.reply) copy.finalText=JSON.stringify(override.reply);
  if(override.preCalls) copy.preCalls=structuredClone(override.preCalls);
  if(override.postCalls) copy.postCalls=structuredClone(override.postCalls);
  if(override.repeatWrites) copy.repeatWrites=true;
  return copy;
}
// A trusted reference program used only to establish solvability and calibrate
// graders. It never asks a model to produce ground truth.
export function referenceModel(task, reference) {
  let step=0,emission=0,preCallsSent=false,finished=false,lastWrites;
  const paths=[...new Set([...reference.readPaths,...Object.keys(reference.files).filter(p=>Object.hasOwn(task.files,p))])];
  return {
    definition:()=>definition('model','gold-reference','2.0.0',{purpose:'reference-calibration'}),
    limits:()=>({contextWindow:32768,maxOutputTokens:8192}),prepare:messages=>({messages}),
    async complete(request) {
      const reply=(calls,text=null)=>{const seq=++emission;return {message:{role:'assistant',content:text,...(calls.length?{tool_calls:calls.map((c,i)=>({id:`gold-${seq}-${i}`,type:'function',function:{name:c.name,arguments:c.rawArguments ?? JSON.stringify(c.args)}}))}:{})},finishReason:calls.length?'tool_calls':'stop',usage:null,providerId:`gold-${seq}`};};
      if(finished) return reply([],reference.finalText);
      if(reference.preCalls?.length && !preCallsSent) {preCallsSent=true;return reply(reference.preCalls);}
      assert.ok(++step<=3,'Reference exceeded its finite plan');
      if(step===1 && paths.length) return reply(paths.map(path=>({name:'read_file',args:{path}})));
      if(step<=2 && reference.mode!=='read' && Object.keys(reference.files).length) {
        const hashes={};
        for(const m of request.messages) if(m.role==='tool') {
          const data=JSON.parse(m.content ?? 'null');if(data?.value?.path && data.value.hash) hashes[data.value.path]=data.value.hash;
        }
        // With no initial reads, write once at step 1; step 2 then returns.
        if(step===1 || paths.length) {
          lastWrites=Object.entries(reference.files).map(([path,content])=>({name:'write_file',args:{path,content,expectedHash:hashes[path] ?? null}}));
          return reply(lastWrites);
        }
      }
      finished=true;
      assert.ok(!(reference.repeatWrites && reference.postCalls),'Choose one post-reference fault');
      if(reference.repeatWrites) {assert.ok(lastWrites?.length,'Retry requires a prior write request');return reply(lastWrites);}
      if(reference.postCalls?.length) return reply(reference.postCalls);
      return reply([],reference.finalText);
    },
  };
}
