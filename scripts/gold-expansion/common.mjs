import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, goldDirectory, directory as priorDirectory, readJSON, writeJSON, sha, parentState as goldState, checkManifest as checkPrior, fingerprint as priorFingerprint } from '../gold-mutations/common.mjs';
export { root, goldDirectory, priorDirectory, readJSON, writeJSON, sha };
export const directory=resolve(root,'evals/private/gold-mutations-v2');
export async function sourceHashes() {
  const paths=['docs/evaluation-expansion-150.md',...(await readdir(resolve(directory,'source'))).map(n=>`evals/private/gold-mutations-v2/source/${n}`),...(await readdir(resolve(root,'scripts/gold-expansion'))).filter(n=>n.endsWith('.mjs')).map(n=>`scripts/gold-expansion/${n}`)];
  const result={};for(const p of paths.sort())result[p]=sha(await readFile(resolve(root,p)));return result;
}
export async function parentState() {
  const {lock,index}=await goldState(), prior=await checkPrior(), runtime=await priorFingerprint();
  const frozen=await readJSON(resolve(directory,'source/frozen-lock.json'));
  assert.equal(prior.hash,frozen.manifestHash);assert.equal(runtime.hash,frozen.runtimeHash);
  assert.equal(sha(await readFile(resolve(root,frozen.baseline))),frozen.baselineHash);
  return {lock,index,frozen};
}
export async function fingerprint() {
  const parent=await priorFingerprint(),scripts={};
  for(const n of (await readdir(resolve(root,'scripts/gold-expansion'))).sort())if(n.endsWith('.mjs'))scripts[n]=sha(await readFile(resolve(root,'scripts/gold-expansion',n)));
  return {hash:sha(JSON.stringify({parent:parent.hash,scripts})),parent:parent.hash,scripts};
}
export async function checkManifest() {
  await parentState();const bytes=await readFile(resolve(directory,'manifest.json')),manifest=JSON.parse(bytes);
  for(const [p,h] of Object.entries(manifest.files))assert.equal(sha(await readFile(resolve(directory,p))),h,`Changed expansion artifact: ${p}`);
  for(const [p,h] of Object.entries(manifest.sources))assert.equal(sha(await readFile(resolve(root,p))),h,`Changed expansion source: ${p}`);
  return {hash:sha(bytes),manifest};
}
