import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, sha } from './common.mjs';
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
async function execute(file,names) {
  const child=spawn(process.execPath,['--test','--test-reporter=tap','--test-name-pattern',`^(?:${names.map(escape).join('|')})$`,resolve(root,file.replace(/^test\//,'dist/test/').replace(/\.ts$/,'.js'))],{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MINICAH_NATIVE_TEST:'0',MINICAH_SANDBOX_IMAGE:'',MINICAH_PTC_IMAGE:''}});
  let output='',stopped=null;
  const stop=reason=>{stopped??=reason;try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}};
  const timer=setTimeout(()=>stop('timeout'),60000);
  for(const stream of [child.stdout,child.stderr]) stream.on('data',bytes=>{output+=bytes.toString();if(Buffer.byteLength(output)>2*1024*1024){output=output.slice(0,2*1024*1024);stop('output-limit');}});
  try {const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});return {code,output,stopped};}
  finally {clearTimeout(timer);}
}
export async function runEngineering(seeds,artifacts) {
  const results=new Map(),evidence=[];
  const checks=seeds.flatMap(s=>s.execution.checks);
  for(const file of [...new Set(checks.map(c=>c.file))]) {
    const names=[...new Set(checks.filter(c=>c.file===file).map(c=>c.name))];
    const run=await execute(file,names),path=resolve(artifacts,file.split('/').pop()+'.tap');
    await writeFile(path,run.output,{mode:0o600});evidence.push({path,hash:sha(run.output)});
    for(const name of names) results.set(`${file}/${name}`,run.code===0 && !run.stopped && new RegExp(`^ok \\d+ - ${escape(name)}$`,'m').test(run.output));
  }
  return {cases:seeds.map(s=>({caseId:s.case_id,track:s.track,passed:s.execution.checks.every(c=>results.get(`${c.file}/${c.name}`)),checks:s.execution.checks,negativeEvidence:'named fixture assertions/rejection controls; no implementation mutation testing'})),evidence};
}
