import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, directory as goldDirectory, readJSON, writeJSON, sha, checkManifest as checkGold, fingerprint as goldFingerprint } from '../gold-seeds/common.mjs';
export { root, goldDirectory, readJSON, writeJSON, sha };
export const directory=resolve(root,'evals/private/gold-mutations-v1');
export async function sourceHashes() {
  const paths=['docs/evaluation-mutations.md','evals/private/gold-mutations-v1/source/parent-lock.json','evals/private/gold-mutations-v1/source/specifications.json',...(await readdir(resolve(root,'scripts/gold-mutations'))).filter(n=>n.endsWith('.mjs')).map(n=>`scripts/gold-mutations/${n}`)];
  const hashes={};for(const p of paths.sort())hashes[p]=sha(await readFile(resolve(root,p)));return hashes;
}
export async function parentState() {
  const lock=await readJSON(resolve(directory,'source/parent-lock.json'));
  const gold=await checkGold(),runtime=await goldFingerprint();
  assert.equal(gold.hash,lock.manifestHash,'Frozen parent corpus changed');
  assert.equal(runtime.hash,lock.runtimeHash,'Frozen parent runtime changed');
  const index=await readJSON(resolve(goldDirectory,'index.json'));
  assert.equal(index.version,lock.version);
  assert.equal(sha(await readFile(resolve(root,lock.baseline))),lock.baselineHash);
  return {lock,index};
}
export async function fingerprint() {
  const parent=await goldFingerprint(),scripts={};
  for(const n of (await readdir(resolve(root,'scripts/gold-mutations'))).sort()) if(n.endsWith('.mjs')) scripts[n]=sha(await readFile(resolve(root,'scripts/gold-mutations',n)));
  return {hash:sha(JSON.stringify({parent:parent.hash,scripts})),parent:parent.hash,scripts};
}
export async function checkManifest() {
  const bytes=await readFile(resolve(directory,'manifest.json')),manifest=JSON.parse(bytes);
  await parentState();
  for(const [p,h] of Object.entries(manifest.files)) assert.equal(sha(await readFile(resolve(directory,p))),h,`Changed mutation artifact: ${p}`);
  for(const [p,h] of Object.entries(manifest.sources)) assert.equal(sha(await readFile(resolve(root,p))),h,`Changed mutation source: ${p}`);
  return {hash:sha(bytes),manifest};
}
