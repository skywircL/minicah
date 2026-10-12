import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFingerprint, sha } from '../ground-truth/version.mjs';
export { sha };
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const directory = resolve(root, 'evals/private/gold-seeds-v2');
export const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
export const writeJSON = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
export async function fingerprint() {
  const runtime = await runtimeFingerprint(), scripts = {};
  for (const file of (await readdir(resolve(root, 'scripts/gold-seeds'))).sort()) {
    if (/\.mjs$/.test(file)) scripts[file] = sha(await readFile(resolve(root, 'scripts/gold-seeds', file)));
  }
  return { hash: sha(JSON.stringify({ runtime: runtime.hash, scripts })), runtime, scripts };
}
export async function checkManifest() {
  const path = resolve(directory, 'manifest.json'), bytes = await readFile(path), manifest = JSON.parse(bytes);
  for (const [file, hash] of Object.entries(manifest.files)) assert.equal(sha(await readFile(resolve(directory, file))), hash, `Stale gold file: ${file}`);
  for (const [file, hash] of Object.entries(manifest.sources)) assert.equal(sha(await readFile(resolve(root, file))), hash, `Stale gold source: ${file}`);
  return { manifest, hash: sha(bytes) };
}
export async function bindSources(paths) {
  const sources = {};
  for (const path of [...new Set(paths)].sort()) sources[relative(root, resolve(root, path))] = sha(await readFile(resolve(root, path)));
  return sources;
}
export const allCapabilities = ['A1','A2','A3','A4','A5','A6','H1','H2','H3','H4','H5','H6','P1','P2','P3','P4'];
