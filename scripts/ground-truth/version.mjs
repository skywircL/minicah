import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// Bind source AND executed output, including the runtime version. Reports cannot
// remain current after a rebuild, source edit, or a Node/platform change.
export async function runtimeFingerprint() {
  const files = {};
  async function walk(path) {
    for (const item of (await readdir(resolve(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = `${path}/${item.name}`;
      if (item.isDirectory()) await walk(p);
      else if (item.isFile() && /\.(ts|js|mjs|json)$/.test(item.name)) files[p] = sha(await readFile(resolve(root, p)));
    }
  }
  for (const p of ['src', 'test', 'dist/src', 'dist/test', 'scripts/ground-truth']) await walk(p);
  for (const p of ['package.json', 'package-lock.json', 'tsconfig.json']) files[p] = sha(await readFile(resolve(root, p)));
  const snapshot = { node: process.version, platform: process.platform, arch: process.arch, files };
  return { hash: sha(JSON.stringify(snapshot)), ...snapshot };
}

export async function reportPointer(path, metadata) {
  return { ...metadata, report: path, reportHash: sha(await readFile(path)) };
}

// A status in a mutable pointer is not sufficient: verify the retained evidence.
export async function verifiedReport(pointer, runtimeHash) {
  if (!pointer || pointer.status !== 'passed' || pointer.runtimeHash !== runtimeHash) return null;
  try {
    const bytes = await readFile(pointer.report);
    if (sha(bytes) !== pointer.reportHash) return null;
    const report = JSON.parse(bytes);
    return report.status === 'passed' && report.runtimeHash === runtimeHash ? report : null;
  } catch { return null; }
}
