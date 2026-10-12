import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Runtime } from "../src/runtime.js";
import { services } from "../src/services.js";
import { createSandboxExecutionPlugin } from "../src/agent/sandbox-execution.js";
import { createCodingToolsPlugin } from "../src/agent/workspace.js";
import type { SandboxCommandResult, SandboxProcessRequest, SandboxService } from "../src/sandbox/types.js";
import { code, deferred, plugin, tick } from "./helpers.js";

const completed: SandboxCommandResult = { id: "container-1", exitCode: 0, reason: "exit", stdout: "ok", stderr: "", cleanup: "verified", code: null, profile: { network: "none" } };
async function fixture(t: TestContext, execute: SandboxService["execute"] = async () => completed) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "minicah-sandbox-execution-")));
  const calls: SandboxProcessRequest[] = [];
  const sandbox: SandboxService = { profile: completed.profile, run: async () => completed,
    async execute(request) { calls.push(request); return execute(request); },
    health: () => ({ active: [], unresolved: [], closed: false }),
  };
  const runtime = await Runtime.create({ plugins: [
    plugin("sandbox-test", { provides: [services.sandbox], setup(ctx) { ctx.provide(services.sandbox, () => sandbox); } }),
    createSandboxExecutionPlugin(root), createCodingToolsPlugin(root, false, "docker"),
  ] });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const session = await runtime.openSession();
  return { root, calls, session, runtime };
}

test("sandbox command execution maps validated cwd and preserves isolation evidence", async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src"));
  const signal = new AbortController().signal;
  await f.session.run(async run => {
    const tool = run.tools.list().find(tool => tool.name === "run_command")!;
    assert.equal(tool.effect, "non-idempotent-write");
    assert.match(tool.description, /filtered disposable workspace copy/);
    const result = await run.services.get(services.execution).execute({ command: "node", args: ["test.js"], cwd: join(f.root, "src"), signal });
    assert.deepEqual(result, { exitCode: 0, reason: "exit", stdout: "ok", stderr: "", sandbox: { id: "container-1", cleanup: "verified", code: null, profile: completed.profile } });
  });
  assert.deepEqual(f.calls[0], { command: "node", args: ["test.js"], cwd: "/workspace/src", workspace: "snapshot", timeoutMs: 60_000, maxOutputBytes: 24_000, signal });
  await f.runtime.updateConfig({ "sandbox-execution": { timeoutMs: 10, maxOutputBytes: 50 } });
  await f.session.run(run => run.tools.invoke("run_command", { command: "node", args: [] }));
  assert.equal(f.calls[1]!.cwd, "/workspace");
  assert.equal(f.calls[1]!.timeoutMs, 10);
  assert.equal(f.calls[1]!.maxOutputBytes, 50);
});

test("sandbox execution rejects external, protected, symlink and non-directory cwd before dispatch", async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, ".minicah"));
  await writeFile(join(f.root, "file"), "data");
  await symlink(f.root, join(f.root, "alias"));
  for (const cwd of ["relative", resolve(f.root, ".."), join(f.root, ".minicah"), join(f.root, "file")]) {
    await assert.rejects(f.session.run(run => run.services.get(services.execution).execute({ command: "node", args: [], cwd })), code("WORKSPACE_PATH"));
  }
  await assert.rejects(f.session.run(run => run.services.get(services.execution).execute({ command: "node", args: [], cwd: join(f.root, "alias") })), code("WORKSPACE_SYMLINK"));
  assert.equal(f.calls.length, 0);
});

test("unconfirmed sandbox cleanup is an uncertain failure and outstanding execution keeps the run alive", async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async () => { entered.resolve(); await release.promise; return { ...completed, cleanup: "unconfirmed", code: "CLEANUP_UNCONFIRMED" }; });
  let ended = false;
  const running = f.session.run(async run => {
    void assert.rejects(run.services.get(services.execution).execute({ command: "node", args: [], cwd: f.root }), code("CLEANUP_UNCONFIRMED"));
  }).then(() => { ended = true; });
  await entered.promise; await tick();
  assert.equal(ended, false);
  release.resolve(); await running;
  assert.equal(ended, true);
});

test("CLI Docker selection requires explicit image configuration and rejects invalid modes before starting a model", async t => {
  const root = await mkdtemp(join(tmpdir(), "minicah-sandbox-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = async (...args: string[]) => {
    const child = spawn(process.execPath, [resolve("dist/src/cli/main.js"), "--task", "test", ...args], { cwd: root, env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { exitCode, stderr };
  };
  const missing = await cli("--sandbox", "docker");
  assert.equal(missing.exitCode, 1); assert.match(missing.stderr, /SANDBOX_IMAGE_REQUIRED/);
  const invalid = await cli("--sandbox", "permissive");
  assert.equal(invalid.exitCode, 1); assert.match(invalid.stderr, /CLI_ARGUMENT/);
  const native = await cli("--sandbox", "native");
  assert.equal(native.exitCode, 1); assert.match(native.stderr, /MODEL_KEY_MISSING/);
  assert.doesNotMatch(native.stderr, /SANDBOX_IMAGE_REQUIRED/);
  const unusedImage = await cli("--sandbox-image", "unused");
  assert.equal(unusedImage.exitCode, 1); assert.match(unusedImage.stderr, /requires --sandbox docker/);
});
