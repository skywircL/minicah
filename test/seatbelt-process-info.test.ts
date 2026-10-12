import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { seatbeltProcessDriver, seatbeltProfile } from "../src/sandbox/seatbelt.js";
import { deadline } from "../src/deadline.js";

const execute = promisify(execFile);
const enabled = process.platform === "darwin" && process.env.MINICAH_NATIVE_TEST === "1";

test("real Seatbelt: process information cannot expose another process's fixture secret", { skip: !enabled }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "minicah-native-process-policy-")));
  let terminateFixture: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await terminateFixture?.(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const environment = { PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory, OPENSSL_CONF: "/dev/null" };
  assert.equal(Object.hasOwn(environment, "SANDBOX_TEST_SECRET"), false);
  const executable = join(directory, "process-probe");
  // Source remains in test/fixtures; tsc only emits the test's JavaScript to dist/test.
  const source = fileURLToPath(new URL("../../test/fixtures/seatbelt-process-info.c", import.meta.url));
  await execute("/usr/bin/clang", [source, "-o", executable], {
    cwd: directory, env: environment, timeout: 15_000, maxBuffer: 64 * 1024,
  });
  const prepared = await seatbeltProcessDriver().prepare(process.execPath, []);
  const profile = seatbeltProfile({ ...prepared, readFiles: [...prepared.readFiles, executable] }, [directory]);
  assert.ok(profile.includes("(deny process-info*)"), "deny default alone does not cover all process-info access on macOS");

  // This fixture is the ONLY process whose arguments/environment the C probe queries.
  // A locally compiled fixture reliably retains fake env data in KERN_PROCARGS2.
  // On this host /bin/sleep's platform-binary baseline omits that environment.
  const fixture = spawn(executable, ["fixture"], {
    env: { PATH: "/usr/bin:/bin", SANDBOX_TEST_SECRET: "fake-minicah-fixture-only" }, stdio: "ignore",
  });
  const fixtureClosed = new Promise<void>(resolve => { fixture.once("close", () => resolve()); });
  terminateFixture = async () => {
    fixture.kill("SIGKILL");
    await deadline(fixtureClosed, 2500, "FIXTURE_CLEANUP_UNCONFIRMED", "Test fixture did not close");
  };
  await new Promise<void>((resolve, reject) => { fixture.once("spawn", resolve); fixture.once("error", reject); });
  assert.ok(fixture.pid && fixture.pid > 1);
  const target = String(fixture.pid);
  const probe = async (mode: string, sandboxed = true): Promise<Record<string, unknown>> => {
    const args = [mode, ...(mode === "fork" || mode === "spawn" ? [] : [target])];
    const result = await execute(sandboxed ? "/usr/bin/sandbox-exec" : executable,
      sandboxed ? ["-p", profile, executable, ...args] : args,
      { cwd: directory, env: environment, timeout: 4000, maxBuffer: 4096 });
    // The probe emits booleans and errno only, never raw arguments/environment.
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };

  await t.test("baseline confirms the target is the managed fake-secret fixture", async () => {
    const baseline = await probe("procargs", false);
    assert.equal(baseline.readSucceeded, true);
    assert.equal(baseline.fixtureExecutableMatches, true);
    assert.equal(baseline.fixtureSecretReadable, true);
  });
  await t.test("explicit process-info denial blocks KERN_PROCARGS2", async () => {
    const isolated = await probe("procargs");
    assert.equal(isolated.readSucceeded, false);
    assert.equal(isolated.fixtureSecretReadable, false);
    assert.equal(isolated.errno, 1); // EPERM
  });
  for (const mode of ["fork", "spawn"]) await t.test(`${mode} cannot create a child process`, async () => {
    assert.deepEqual(await probe(mode), { denied: true, errno: 1 });
  });
  for (const mode of ["exec", "setexec"]) await t.test(`${mode} keeps the PID and inherits process-info denial`, async () => {
    const isolated = await probe(mode);
    assert.equal(isolated.samePidAfterExec, true);
    assert.equal(isolated.readSucceeded, false);
    assert.equal(isolated.fixtureSecretReadable, false);
    assert.equal(isolated.errno, 1);
  });
  await t.test("Node workers remain usable without process creation or process-info permission", async () => {
    const program = `const {Worker}=require("node:worker_threads");const w=new Worker('require("node:worker_threads").parentPort.postMessage(42)',{eval:true});w.on("message",value=>console.log(JSON.stringify({worker:value===42})));`;
    const result = await execute("/usr/bin/sandbox-exec", ["-p", profile, prepared.nodeExecutable, "-e", program], {
      cwd: directory, env: environment, timeout: 4000, maxBuffer: 4096,
    });
    assert.deepEqual(JSON.parse(result.stdout), { worker: true });
  });
});
