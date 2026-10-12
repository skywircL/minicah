import assert from "node:assert/strict";
import test from "node:test";
import { DockerSandbox, PtcRuntime, type DockerDriver, type DockerAttachment } from "../src/index.js";
import { deferred, code } from "./helpers.js";
import { echoTool, pipelineFixture } from "./pipeline-helpers.js";

const image = `node@sha256:${"a".repeat(64)}`;
const request = { program: "return input", input: { value: 1 }, bindings: ["echo"], maxOutputBytes: 4096, concurrency: 2 };
function fixtureDriver(options: { cleanupFails?: boolean; volumes?: boolean; daemonFails?: boolean; seccomp?: boolean; neverExit?: boolean; createThrows?: boolean } = {}) {
  const commands: readonly string[][] = [];
  const mutable = commands as string[][];
  const exit = deferred<number>();
  const driver: DockerDriver = {
    async command(args) {
      mutable.push([...args]);
      if (args[0] === "info") return { code: options.daemonFails ? 1 : 0, stdout: JSON.stringify({ OSType: "linux", SecurityOptions: options.seccomp === false ? [] : ["name=seccomp,profile=builtin"] }) };
      if (args[0] === "image") return { code: 0, stdout: JSON.stringify({ Volumes: options.volumes ? { "/host": {} } : null }) };
      if (args[0] === "create") { if (options.createThrows) throw new Error("timeout; daemon may still create"); return { code: 0, stdout: "container-id" }; }
      if (args[0] === "rm") { if (!options.cleanupFails) exit.resolve(137); return { code: options.cleanupFails ? 1 : 0, stdout: "" }; }
      throw new Error("Unexpected command");
    },
    attach(args, stdout) {
      mutable.push([...args]);
      return { closed: exit.promise, write(line) {
        const frame = JSON.parse(line);
        if (frame.type === "start" && !options.neverExit) queueMicrotask(() => { stdout(Buffer.from(JSON.stringify({ type: "result", status: "completed", value: frame.input }) + "\n")); exit.resolve(0); });
      }, endInput() {}, killClient() { exit.resolve(-1); } } satisfies DockerAttachment;
    },
  };
  return { driver, commands };
}
const host = () => ({ signal: new AbortController().signal, cancel() {}, async call() { throw new Error("unexpected call"); } });

test("Docker restricted profile pins image, drops privileges, disables network/mounts and bounds resources", async () => {
  const fake = fixtureDriver(), sandbox = new DockerSandbox({ image }, fake.driver);
  const result = await sandbox.run(request, host()); assert.equal(result.status, "completed"); assert.equal(result.cleanup, "verified");
  const args = fake.commands.find(args => args[0] === "create")!;
  for (const flag of ["--pull=never", "--network=none", "--ipc=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--user=65534:65534", "--memory=128m", "--memory-swap=128m", "--pids-limit=32", "--cpus=1", "--log-driver=none", "--entrypoint=/usr/bin/env", "-i"]) assert.ok(args.includes(flag), flag);
  assert.equal(args.some(arg => arg.startsWith("--mount") || arg.startsWith("--volume") || arg.startsWith("--env") || arg.includes("docker.sock")), false);
  assert.ok(fake.commands.some(args => args[0] === "rm" && args.includes("--force")));
  assert.deepEqual(sandbox.health().unresolved, []); await sandbox.close();
  assert.throws(() => new DockerSandbox({ image: "node:latest" }), code("INVALID_IMAGE"));
});
test("unavailable isolation, absent seccomp, or implicit image volumes never fall back to a host process", async t => {
  for (const options of [{ daemonFails: true }, { seccomp: false }, { volumes: true }]) await t.test(JSON.stringify(options), async () => {
    const fake = fixtureDriver(options), sandbox = new DockerSandbox({ image }, fake.driver);
    const result = await sandbox.run(request, host()); assert.equal(result.status, "failed"); assert.equal(result.cleanup, "verified");
    assert.equal(fake.commands.some(args => ["create", "start"].includes(args[0]!)), false);
  });
});
test("a Docker client exit never substitutes for daemon-confirmed removal", async () => {
  const fake = fixtureDriver({ cleanupFails: true }), sandbox = new DockerSandbox({ image, commandTimeoutMs: 20 }, fake.driver);
  const result = await sandbox.run(request, host());
  assert.equal(result.status, "unknown"); assert.equal(result.cleanup, "unconfirmed"); assert.equal(sandbox.health().unresolved.length, 1);
  await assert.rejects(sandbox.close(), code("RESTART_REQUIRED"));
  await assert.rejects(sandbox.run(request, host()), code("RESTART_REQUIRED"));
});
test("cancellation terminates the container and waits for attachment closure", async () => {
  const fake = fixtureDriver({ neverExit: true }), sandbox = new DockerSandbox({ image }, fake.driver);
  const controller = new AbortController();
  const work = sandbox.run(request, { ...host(), signal: controller.signal });
  while (!fake.commands.some(args => args[0] === "start")) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); const result = await work;
  assert.equal(result.status, "failed"); assert.equal(result.code, "CANCELLED"); assert.equal(result.cleanup, "verified");
});
test("uncertain create does not claim cleanup even if a remove request succeeds", async () => {
  const fake = fixtureDriver({ createThrows: true }), sandbox = new DockerSandbox({ image }, fake.driver);
  const result = await sandbox.run(request, host()); assert.equal(result.cleanup, "unconfirmed"); assert.equal(sandbox.health().unresolved.length, 1);
});

test("real Docker: JS loops/branches/concurrency, restricted environment, and forced deadline cleanup", { skip: !process.env.MINICAH_PTC_IMAGE }, async t => {
  const fixture = await pipelineFixture(t, [echoTool]);
  const sandbox = new DockerSandbox({ image: process.env.MINICAH_PTC_IMAGE! });
  t.after(() => sandbox.close());
  await fixture.run(async (tools, log) => {
    const runner = new PtcRuntime(sandbox, tools, log, { deadlineMs: 10_000 });
    const result = await runner.evaluate({ input: ["a", "b"], bindings: ["echo"], program: `
      const results = await Promise.all(input.map(text => tools.echo({ text })));
      const output = []; for (const result of results) if (result.status === 'completed') output.push(result.value.text);
      const fs = await import('node:fs/promises'); let rootWritable = true;
      try { await fs.writeFile('/forbidden', 'x'); } catch { rootWritable = false; }
      return { output, rootWritable, env: Object.keys(process.env).sort(), uid: process.getuid() };
    ` });
    assert.equal(result.status, "completed"); assert.deepEqual(result.output.value, { output: ["a", "b"], rootWritable: false, env: ["HOME", "PATH"], uid: 65534 });
    const deadlineRunner = new PtcRuntime(sandbox, tools, log, { deadlineMs: 2_000 });
    const stopped = await deadlineRunner.evaluate({ input: null, bindings: [], program: "while (true) {}" });
    assert.equal(stopped.status, "failed"); assert.equal(stopped.cleanup, "verified"); assert.equal(stopped.code, "CANCELLED");
  });
});
