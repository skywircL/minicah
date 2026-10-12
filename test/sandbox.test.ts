import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  DockerProcessSandbox, Runtime, createDockerSandboxPlugin, services,
  type DockerDriver, type SandboxProcessRequest, type SandboxProcessResult,
} from "../src/index.js";
import { code, deferred, tick } from "./helpers.js";

const image = `node@sha256:${"a".repeat(64)}`;
const command = { command: "node", args: ["-e", "process.exit(0)"] };
interface Container {
  name: string;
  args: readonly string[];
  exit: ReturnType<typeof deferred<number>>;
  stdout?: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
  input: string[];
  ended: number;
  killed: number;
  attached: boolean;
}
function fixtureDriver() {
  const containers = new Map<string, Container>(), calls: string[][] = [], failRemoval = new Set<string>(), keepAttached = new Set<string>();
  let removeHook: ((container: Container) => Promise<void>) | undefined;
  const driver: DockerDriver = {
    async command(args) {
      calls.push([...args]);
      if (args[0] === "info") return { code: 0, stdout: JSON.stringify({ OSType: "linux", SecurityOptions: ["name=seccomp,profile=builtin"] }) };
      if (args[0] === "image") return { code: 0, stdout: JSON.stringify({ Volumes: null }) };
      if (args[0] === "create") {
        const name = args[args.indexOf("--name") + 1]!;
        assert.ok(!containers.has(name), "each process gets a distinct container");
        containers.set(name, { name, args: [...args], exit: deferred<number>(), input: [], ended: 0, killed: 0, attached: false });
        return { code: 0, stdout: name };
      }
      if (args[0] === "rm") {
        const container = containers.get(args.at(-1)!)!;
        assert.ok(container, "remove identifies its own container");
        await removeHook?.(container);
        if (failRemoval.has(container.name)) return { code: 1, stdout: "" };
        if (!keepAttached.has(container.name)) container.exit.resolve(137);
        return { code: 0, stdout: container.name };
      }
      throw new Error(`Unexpected Docker operation: ${args[0]}`);
    },
    attach(args, stdout, stderr) {
      calls.push([...args]);
      const container = containers.get(args.at(-1)!)!;
      assert.ok(container); container.attached = true; container.stdout = stdout; container.stderr = stderr;
      return { closed: container.exit.promise,
        write(data) { container.input.push(data); }, endInput() { container.ended++; },
        killClient() { container.killed++; container.exit.resolve(-1); },
      };
    },
  };
  return { driver, calls, containers, failRemoval, keepAttached,
    setRemoveHook(hook: (container: Container) => Promise<void>) { removeHook = hook; },
    async started(count = 1): Promise<Container[]> {
      const end = Date.now() + 2_000;
      while ([...containers.values()].filter(item => item.attached).length < count) {
        if (Date.now() >= end) assert.fail(`Expected ${count} attached containers`);
        await tick();
      }
      return [...containers.values()].filter(item => item.attached);
    },
  };
}

test("general sandbox atomically bounds concurrent fresh containers and releases capacity after cleanup", async t => {
  const fake = fixtureDriver(), sandbox = new DockerProcessSandbox({ image, concurrency: 2, timeoutMs: 1_000 }, fake.driver);
  t.after(() => sandbox.close());
  const first = sandbox.execute(command), second = sandbox.execute(command);
  assert.equal(sandbox.health().active.length, 2);
  await assert.rejects(sandbox.execute(command), code("SANDBOX_BUSY"));
  const [a, b] = await fake.started(2);
  assert.notEqual(a!.exit, b!.exit);
  assert.equal(a!.ended, 1); assert.equal(b!.ended, 1);
  a!.stdout!(Buffer.from("first")); b!.stdout!(Buffer.from("second"));
  a!.exit.resolve(0);
  assert.equal((await first).stdout, "first");
  assert.equal(sandbox.health().active.length, 1);
  const third = sandbox.execute(command), [, , c] = await fake.started(3);
  c!.exit.resolve(3); b!.exit.resolve(0);
  assert.equal((await second).stdout, "second"); assert.equal((await third).exitCode, 3);
  assert.deepEqual(sandbox.health().active, []);
  assert.equal(fake.calls.filter(args => args[0] === "rm").length, 3);
});

test("general sandbox enforces its deadline ceiling and immediately stops Host admission", async t => {
  const fake = fixtureDriver(), sandbox = new DockerProcessSandbox({ image, timeoutMs: 15 }, fake.driver);
  t.after(() => sandbox.close());
  let stopped: SandboxProcessResult["reason"] | undefined;
  fake.setRemoveHook(async () => { assert.equal(stopped, "timeout", "consumer is stopped before daemon cleanup"); });
  const result = await sandbox.run({ ...command, timeoutMs: 50_000 }, { stopped: reason => { stopped = reason; } });
  assert.equal(result.reason, "timeout"); assert.equal(result.code, "DEADLINE_EXCEEDED"); assert.equal(result.cleanup, "verified");
});

test("general sandbox shares a byte cap across stdout and stderr and ignores output after stopping", async t => {
  const fake = fixtureDriver(), sandbox = new DockerProcessSandbox({ image, maxOutputBytes: 8 }, fake.driver);
  t.after(() => sandbox.close());
  const work = sandbox.execute({ ...command, maxOutputBytes: 10_000 }), [container] = await fake.started();
  container!.stdout!(Buffer.from("abcdef")); container!.stderr!(Buffer.from("ghij")); container!.stdout!(Buffer.from("ignored"));
  const result = await work;
  assert.equal(result.stdout, "abcdef"); assert.equal(result.stderr, "gh");
  assert.equal(result.reason, "output-limit"); assert.equal(result.code, "OUTPUT_LIMIT"); assert.equal(result.cleanup, "verified");
});

test("general sandbox caps interactive input before sending excess bytes", async t => {
  const fake = fixtureDriver(), sandbox = new DockerProcessSandbox({ image, maxInputBytes: 64 }, fake.driver);
  t.after(() => sandbox.close());
  const result = await sandbox.run({ command: "cat", args: [], maxInputBytes: 1_000 }, { started(control) {
    control.write("a".repeat(64)); control.write("b"); control.write("ignored");
  } });
  const [container] = [...fake.containers.values()];
  assert.deepEqual(container!.input, ["a".repeat(64)]);
  assert.equal(result.reason, "input-limit"); assert.equal(result.code, "INPUT_LIMIT"); assert.equal(result.cleanup, "verified");
});

test("consumer IO failures still terminate and verify container cleanup", async t => {
  for (const failing of ["started", "stdout", "stderr"] as const) await t.test(failing, async () => {
    const fake = fixtureDriver(), sandbox = new DockerProcessSandbox({ image }, fake.driver);
    const work = sandbox.run(command, { [failing]() { throw new Error("consumer failed"); } });
    if (failing !== "started") { const [container] = await fake.started(); container![failing]!(Buffer.from("x")); }
    const result = await work;
    assert.equal(result.reason, "io-failed"); assert.equal(result.code, "SANDBOX_IO_FAILED"); assert.equal(result.cleanup, "verified");
    await sandbox.close();
  });
});

test("close cancels every active container, waits for cleanup, and permanently closes admission", async () => {
  const fake = fixtureDriver(), sandbox = new DockerProcessSandbox({ image }, fake.driver);
  const first = sandbox.execute(command), second = sandbox.execute(command);
  await fake.started(2);
  const release = deferred(), entered = deferred(); let completed = false;
  fake.setRemoveHook(async () => { entered.resolve(); await release.promise; });
  const closing = sandbox.close().then(() => { completed = true; });
  await entered.promise; await tick();
  assert.equal(completed, false); assert.equal(sandbox.health().active.length, 2); assert.equal(sandbox.health().closed, true);
  await assert.rejects(sandbox.execute(command), code("SANDBOX_CLOSED"));
  release.resolve(); await closing;
  for (const result of await Promise.all([first, second])) { assert.equal(result.reason, "cancelled"); assert.equal(result.cleanup, "verified"); }
  assert.deepEqual(sandbox.health().active, []);
  await sandbox.close();
});

test("unconfirmed removal poisons the shared backend and cancels its other active containers", async () => {
  const fake = fixtureDriver(), sandbox = new DockerProcessSandbox({ image, commandTimeoutMs: 10 }, fake.driver);
  const first = sandbox.execute(command), second = sandbox.execute(command), [a, b] = await fake.started(2);
  fake.failRemoval.add(a!.name); a!.exit.resolve(0);
  const failed = await first, cancelled = await second;
  assert.equal(failed.cleanup, "unconfirmed"); assert.equal(failed.code, "CLEANUP_UNCONFIRMED");
  assert.equal(cancelled.id, b!.name); assert.equal(cancelled.reason, "cancelled"); assert.equal(cancelled.cleanup, "verified");
  assert.deepEqual(sandbox.health().unresolved, [a!.name]); assert.deepEqual(sandbox.health().active, []);
  await assert.rejects(sandbox.execute(command), code("RESTART_REQUIRED"));
  await assert.rejects(sandbox.close(), code("RESTART_REQUIRED"));
});

test("a successful remove without attachment closure does not count as verified cleanup", async () => {
  const fake = fixtureDriver(), sandbox = new DockerProcessSandbox({ image, commandTimeoutMs: 10 }, fake.driver), controller = new AbortController();
  const work = sandbox.execute({ ...command, signal: controller.signal }), [container] = await fake.started();
  fake.keepAttached.add(container!.name); controller.abort();
  const result = await work;
  assert.equal(result.cleanup, "unconfirmed"); assert.equal(result.code, "CLEANUP_UNCONFIRMED"); assert.equal(container!.killed, 1);
  await assert.rejects(sandbox.close(), code("RESTART_REQUIRED"));
});

async function workspace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "minicah-general-sandbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.txt"), "safe source"); await writeFile(join(root, ".env"), "secret");
  await mkdir(join(root, ".minicah")); await writeFile(join(root, ".minicah", "events"), "private logs");
  return root;
}
const snapshotPath = (container: Container): string => {
  const mount = container.args[container.args.indexOf("--mount") + 1]!;
  const path = /^type=bind,source=(.*),target=\/input,readonly,bind-recursive=disabled$/.exec(mount)?.[1];
  assert.ok(path, "only the filtered snapshot is mounted read-only"); return path;
};

test("workspace mode mounts only a filtered disposable snapshot with fixed isolation flags", async t => {
  const root = await workspace(t), fake = fixtureDriver(), sandbox = new DockerProcessSandbox({ image, workspace: root }, fake.driver);
  t.after(() => sandbox.close());
  const work = sandbox.execute({ ...command, workspace: "snapshot", cwd: "/workspace" }), [container] = await fake.started();
  const input = snapshotPath(container!);
  assert.notEqual(input, root); assert.deepEqual(await readdir(input), ["source.txt"]);
  assert.equal(await readFile(join(input, "source.txt"), "utf8"), "safe source");
  for (const flag of ["--pull=never", "--network=none", "--ipc=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--user=65534:65534", "--memory=128m", "--memory-swap=128m", "--pids-limit=32", "--cpus=1", "--log-driver=none", "--no-healthcheck", "--entrypoint=/usr/bin/env", "-i"]) assert.ok(container!.args.includes(flag), flag);
  assert.ok(container!.args.includes("--tmpfs=/workspace:rw,nosuid,nodev,size=128m,mode=0700,uid=65534,gid=65534"));
  assert.equal(container!.args.some(arg => arg === root || arg.includes("docker.sock") || arg.startsWith("--env") || arg.startsWith("--volume")), false);
  container!.exit.resolve(0); const result = await work;
  assert.equal(result.cleanup, "verified"); await assert.rejects(access(dirname(input)));
  assert.equal(await readFile(join(root, "source.txt"), "utf8"), "safe source");
  assert.deepEqual((result.profile as any).workspace, { mode: "filtered-snapshot", root, hostWrites: false, credentials: "excluded", maxBytes: 64 * 1024 * 1024 });
  const isolated = sandbox.execute({ ...command, workspace: "none" }), [, next] = await fake.started(2);
  assert.equal(next!.args.includes("--mount"), false); next!.exit.resolve(0);
  assert.deepEqual(((await isolated).profile as any).hostMounts, []);
});

test("uncertain cleanup retains its input mount as a managed unresolved resource", async t => {
  const root = await workspace(t), fake = fixtureDriver(), sandbox = new DockerProcessSandbox({ image, workspace: root }, fake.driver);
  const work = sandbox.execute({ ...command, workspace: "snapshot" }), [container] = await fake.started(), input = snapshotPath(container!);
  t.after(() => rm(dirname(input), { recursive: true, force: true }));
  fake.failRemoval.add(container!.name); container!.exit.resolve(0);
  assert.equal((await work).cleanup, "unconfirmed"); await access(input);
  assert.deepEqual(sandbox.health().details, [{ id: container!.name, pid: null, retainedPaths: [dirname(input)] }]);
  await assert.rejects(sandbox.close(), code("RESTART_REQUIRED"));
});

test("invalid arguments and cwd boundaries are rejected before contacting Docker", async t => {
  const root = await workspace(t), fake = fixtureDriver(), sandbox = new DockerProcessSandbox({ image, workspace: root }, fake.driver);
  const bad: [Partial<SandboxProcessRequest>, string][] = [
    [{ command: "" }, "INVALID_COMMAND"], [{ command: "node\0" }, "INVALID_COMMAND"], [{ args: ["\0"] }, "INVALID_COMMAND"],
    [{ cwd: "relative" }, "INVALID_CWD"], [{ cwd: "/etc" }, "INVALID_CWD"],
    [{ workspace: "snapshot", cwd: "/workspace/../etc" }, "INVALID_CWD"], [{ workspace: "snapshot", cwd: "/workspace-other" }, "INVALID_CWD"],
    [{ workspace: "snapshot", cwd: "/workspace//child" }, "INVALID_CWD"], [{ maxInputBytes: 1 }, "INPUT_LIMIT"],
    [{ maxOutputBytes: 0 }, "INVALID_LIMIT"],
  ];
  for (const [patch, expected] of bad) await assert.rejects(sandbox.execute({ ...command, ...patch }), code(expected));
  const noWorkspace = new DockerProcessSandbox({ image }, fake.driver);
  await assert.rejects(noWorkspace.execute({ ...command, workspace: "snapshot" }), code("INVALID_WORKSPACE"));
  assert.equal(fake.calls.length, 0); await sandbox.close(); await noWorkspace.close();
});

test("sandbox plugin tracks unawaited process work and requires a new generation for security configuration", async () => {
  const fake = fixtureDriver(), runtime = await Runtime.create({ plugins: [createDockerSandboxPlugin({ image }, fake.driver)] });
  const session = await runtime.openSession(); let completed = false;
  const running = session.run(run => { void run.services.get(services.sandbox).execute(command); }).then(() => { completed = true; });
  const [container] = await fake.started(); await tick();
  assert.equal(completed, false, "run waits for the managed process even when its caller forgets await");
  await assert.rejects(runtime.updateConfig({ "docker-sandbox": { concurrency: 8 } }), code("STATIC_CONFIG"));
  container!.exit.resolve(0); await running; assert.equal(completed, true); await runtime.close();
});
