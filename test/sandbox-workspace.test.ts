import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceSnapshot } from "../src/sandbox/workspace.js";
import { HarnessError } from "../src/errors.js";

const limits = { maxBytes: 8 * 1024 * 1024, maxFiles: 200 };
const code = (expected: string) => (error: unknown): boolean => error instanceof HarnessError && error.code === expected;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "minicah-snapshot-test-")), root = join(directory, "workspace"), temporary = join(directory, "temporary");
  await mkdir(root); await mkdir(temporary);
  // Isolate staging directories so failure cleanup can be asserted exactly.
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  t.after(async () => {
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, root, temporary };
}

test("sandbox workspace copies binary/source files with readable modes and excludes credentials at every depth", async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src"), { mode: 0o700 });
  await writeFile(join(f.root, "src", "main.ts"), "export const safe = true;", { mode: 0o600 });
  await writeFile(join(f.root, "executable"), Buffer.from([0, 1, 2, 255]), { mode: 0o700 });
  const protectedNames = [".git", ".minicah", ".env", ".env.example", ".ssh", ".aws", ".npmrc", ".netrc", "id_rsa", "ID_ED25519"];
  for (const name of protectedNames) {
    await mkdir(join(f.root, name)); await writeFile(join(f.root, name, "secret"), "must not be copied");
    await writeFile(join(f.root, "src", name), "must not be copied");
  }
  const snapshot = await createWorkspaceSnapshot(f.root, limits);
  t.after(() => snapshot.dispose());
  assert.equal((await lstat(snapshot.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(snapshot.input)).mode & 0o777, 0o755);
  assert.equal((await lstat(join(snapshot.input, "src"))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(snapshot.input, "src", "main.ts"))).mode & 0o777, 0o444);
  assert.equal((await lstat(join(snapshot.input, "executable"))).mode & 0o777, 0o544);
  assert.equal(await readFile(join(snapshot.input, "src", "main.ts"), "utf8"), "export const safe = true;");
  assert.deepEqual(await readFile(join(snapshot.input, "executable")), Buffer.from([0, 1, 2, 255]));
  assert.deepEqual((await readdir(snapshot.input)).sort(), ["executable", "src"]);
  assert.deepEqual(await readdir(join(snapshot.input, "src")), ["main.ts"]);
  await snapshot.dispose(); await snapshot.dispose();
  await assert.rejects(access(snapshot.directory));
});

test("sandbox workspace keeps npm internal relative symlinks while skipping external, protected, chained and hardlinked targets", async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, "node_modules", ".bin"), { recursive: true });
  await mkdir(join(f.root, "node_modules", "typescript", "bin"), { recursive: true });
  await writeFile(join(f.root, "node_modules", "typescript", "bin", "tsc"), "#!/usr/bin/env node", { mode: 0o755 });
  await symlink("../typescript/bin/tsc", join(f.root, "node_modules", ".bin", "tsc"));
  await writeFile(join(f.directory, "outside"), "private");
  await writeFile(join(f.root, ".env"), "private");
  await symlink("../outside", join(f.root, "external"));
  await symlink(join(f.directory, "outside"), join(f.root, "absolute"));
  await symlink(".env", join(f.root, "secret"));
  await symlink("secret", join(f.root, "chain"));
  await symlink("missing", join(f.root, "dangling"));
  await link(join(f.directory, "outside"), join(f.root, "hardlink"));
  await symlink("hardlink", join(f.root, "hardlink-alias"));
  await symlink("node_modules", join(f.root, "modules"));
  await symlink("modules/../node_modules", join(f.root, "normalized-alias"));
  await symlink(".env/../node_modules", join(f.root, "normalized-secret"));
  const snapshot = await createWorkspaceSnapshot(f.root, limits);
  t.after(() => snapshot.dispose());
  assert.deepEqual((await readdir(snapshot.input)).sort(), ["modules", "node_modules"]);
  assert.equal(await readlink(join(snapshot.input, "node_modules", ".bin", "tsc")), "../typescript/bin/tsc");
  assert.equal(await readFile(join(snapshot.input, "node_modules", ".bin", "tsc"), "utf8"), "#!/usr/bin/env node");
  assert.equal(await readlink(join(snapshot.input, "modules")), "node_modules");
});

test("sandbox workspace enforces byte and entry limits and removes all incomplete staging data", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "file"), "12345");
  await assert.rejects(createWorkspaceSnapshot(f.root, { maxBytes: 4, maxFiles: 10 }), code("SANDBOX_WORKSPACE_LIMIT"));
  assert.deepEqual(await readdir(f.temporary), []);
  await mkdir(join(f.root, "empty"));
  await assert.rejects(createWorkspaceSnapshot(f.root, { maxBytes: 5, maxFiles: 1 }), code("SANDBOX_WORKSPACE_LIMIT"));
  assert.deepEqual(await readdir(f.temporary), []);
  const snapshot = await createWorkspaceSnapshot(f.root, { maxBytes: 5, maxFiles: 2 });
  assert.equal(await readFile(join(snapshot.input, "file"), "utf8"), "12345");
  await snapshot.dispose();
  assert.deepEqual(await readdir(f.temporary), []);
});

test("sandbox workspace cancellation interrupts copying and cleans its temporary directory", async t => {
  const f = await fixture(t), controller = new AbortController();
  await writeFile(join(f.root, "large"), Buffer.alloc(8 * 1024 * 1024));
  const pending = createWorkspaceSnapshot(f.root, { ...limits, signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, code("CANCELLED"));
  assert.deepEqual(await readdir(f.temporary), []);
  await assert.rejects(createWorkspaceSnapshot(f.root, { ...limits, signal: controller.signal }), code("CANCELLED"));
  assert.deepEqual(await readdir(f.temporary), []);
});

test("sandbox workspace rejects invalid limits and never recursively includes staging inside its input", async t => {
  const f = await fixture(t);
  for (const maxBytes of [-1, Infinity, 0.5]) await assert.rejects(createWorkspaceSnapshot(f.root, { maxBytes, maxFiles: 1 }), code("SANDBOX_WORKSPACE_LIMIT"));
  await assert.rejects(createWorkspaceSnapshot(f.directory, limits), code("SANDBOX_WORKSPACE_PATH"));
  assert.deepEqual(await readdir(f.temporary), []);
});

test("sandbox workspace makes private source directories readable without changing the originals", async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, "private"), { mode: 0o700 }); await chmod(join(f.root, "private"), 0o700);
  await writeFile(join(f.root, "private", "file"), "visible source", { mode: 0o600 });
  const snapshot = await createWorkspaceSnapshot(f.root, limits);
  t.after(() => snapshot.dispose());
  assert.equal((await lstat(join(f.root, "private"))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(f.root, "private", "file"))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(snapshot.input, "private"))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(snapshot.input, "private", "file"))).mode & 0o777, 0o444);
});
