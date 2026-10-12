import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, sha } from './common.mjs';

const replace=(text,from,to)=>{assert.ok(text.includes(from),'Mutation target changed; update the experiment explicitly');return text.replace(from,to);};
const mutations=[
  {caseId:'GS-H1-02',file:'src/tool-pipeline.js',test:'test/tool-pipeline.test.js',name:'native model batches execute concurrently with bounded scheduling and atomic reservations',
    change:s=>replace(s,'return Object.freeze(await Promise.all(copies.map(call => this.invoke(call.name, call.arguments, { ...options, callId: call.callId }))));','const completed = []; await Promise.all(copies.map(call => this.invoke(call.name, call.arguments, { ...options, callId: call.callId }).then(result => { completed.push(result); }))); return Object.freeze(completed);')},
  {caseId:'GS-H2-02',file:'src/agent/workspace.js',test:'test/agent.test.js',name:'workspace tools reject stale hashes, protected paths and symlinks',
    change:s=>{let n=0;const result=s.replace(/        if \([^\n]+\)\n            fail\("WORKSPACE_PATH", "(?:Path must be relative and outside protected metadata\/credential paths|Path leaves workspace)"\);\n/g,()=>{n++;return '';});assert.equal(n,2);return result;}},
  {caseId:'GS-P2-02',file:'src/skills.js',test:'test/registry.test.js',name:'skill summaries, bodies and resources resolve one immutable nearest-layer definition',
    change:s=>replace(s,'get: name => skills.get(name),','get: name => structuredClone(skills.get(name)),')},
  {caseId:'GS-H3-01',file:'src/session/context.js',test:'test/session-context.test.js',name:'compression preserves constraints, protected information, task state, and the original journal',
    change:s=>{for(const kind of ['constraint','protected']) {const expression=`state.protected.filter(event => event.data.type === "protected.recorded" && event.data.kind === "${kind}")`;s=replace(s,expression,expression+'.map(event => ({ ...event, data: { ...event.data, content: "LOST" } }))');}return s;}},
];
export const mutationCaseIds=mutations.map(m=>m.caseId);
export async function runMutations(artifacts) {
  const cases=[],evidence=[];
  for(const mutation of mutations) {
    const directory=resolve(artifacts,`mutation-${mutation.caseId}`);
    await mkdir(directory);await cp(resolve(root,'dist'),resolve(directory,'dist'),{recursive:true});
    await symlink(resolve(root,'node_modules'),resolve(directory,'node_modules'));
    await writeFile(resolve(directory,'package.json'),'{"type":"module"}\n');
    const file=resolve(directory,'dist',mutation.file),before=await readFile(file,'utf8'),after=mutation.change(before);
    await writeFile(file,after);
    const pattern='^'+mutation.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$';
    const result=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-name-pattern',pattern,resolve(directory,'dist',mutation.test)],{encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
    const output=(result.stdout ?? '')+(result.stderr ?? ''),path=resolve(directory,'result.tap');await writeFile(path,output);
    const passed=result.status===1 && output.includes(`not ok 1 - ${mutation.name}`) && output.includes('ERR_ASSERTION');
    cases.push({caseId:mutation.caseId,passed,originalHash:sha(before),mutantHash:sha(after),test:mutation.name,report:path});
    evidence.push({path,hash:sha(output)},{path:file,hash:sha(after)});
  }
  return {cases,evidence};
}
