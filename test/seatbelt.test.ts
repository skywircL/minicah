import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SeatbeltProcessSandbox, seatbeltProfile, type SeatbeltDriver } from "../src/sandbox/seatbelt.js";
import { code, deferred, tick } from "./helpers.js";

function fixture(options: { neverClose?: boolean; hold?: boolean; output?: string } = {}) {
  const exited = deferred<{ exitCode: number | null; failed: boolean }>();
  const calls: Parameters<SeatbeltDriver["spawn"]>[0][] = [];
  let prepared = 0, killed = 0, ended = 0;
  const driver: SeatbeltDriver = { platform: "darwin",
    async prepare(nodeExecutable) { prepared++; return { nodeExecutable, readFiles: [nodeExecutable], readDirectories: ["/usr/lib"] }; },
    spawn(spec, io) {
      calls.push(spec);
      queueMicrotask(() => { if (options.output) io.stdout(Buffer.from(options.output)); });
      return { pid: 123456789, closed: exited.promise, write() {},
        endInput() { ended++; if (!options.hold && !options.neverClose) exited.resolve({ exitCode: 0, failed: false }); },
        terminate() { killed++; if (!options.neverClose) exited.resolve({ exitCode: null, failed: false }); },
      };
    },
  };
  return { driver, calls, exited, prepared: () => prepared, killed: () => killed, ended: () => ended };
}

test("Seatbelt configuration staging performs no runtime acquisition and denies process/environment inspection explicitly", async () => {
  const f = fixture(), sandbox = new SeatbeltProcessSandbox({}, f.driver);
  assert.equal(f.prepared(), 0);
  assert.equal(sandbox.configuration.nodeExecutable, process.execPath);
  const profile = seatbeltProfile({ nodeExecutable: "/trusted/node", readFiles: ["/trusted/node"], readDirectories: ["/usr/lib"] }, ["/private/temp"]);
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /\(deny process-fork\)/);
  assert.match(profile, /\(deny process-info\*\)/);
  assert.doesNotMatch(profile, /\(allow (?:network|system-socket|mach-lookup|process-info|process-fork)/);
  assert.doesNotMatch(profile, /\(allow sysctl-read\)/);
  assert.doesNotMatch(profile, /kern\.proc/);
  await sandbox.close();
});

test("Seatbelt validates before spawn, freezes argv and shares bounded runtime preparation", async () => {
  const f = fixture(), prepare = deferred<void>();
  const driver = { ...f.driver, async prepare(node: string) { await prepare.promise; return f.driver.prepare(node, []); } };
  const sandbox = new SeatbeltProcessSandbox({ concurrency: 1 }, driver);
  await assert.rejects(sandbox.execute({ command: "node", args: [], cwd: "/outside" }), code("INVALID_CWD"));
  const args = ["original"], pending = sandbox.execute({ command: "node", args });
  args[0] = "mutated";
  await assert.rejects(sandbox.execute({ command: "node", args: [] }), code("SANDBOX_BUSY"));
  prepare.resolve();
  const result = await pending;
  assert.equal(result.cleanup, "verified"); assert.deepEqual(f.calls[0]!.args, ["original"]);
  assert.equal(f.ended(), 1); assert.equal(f.prepared(), 1);
  assert.deepEqual(Object.keys(f.calls[0]!.env).sort(), ["HOME", "OPENSSL_CONF", "PATH", "TMPDIR"]);
  assert.equal(f.calls[0]!.env.OPENSSL_CONF, "/dev/null");
  const unsupported = await sandbox.execute({ command: "/some/custom/program", args: [] });
  assert.equal(unsupported.code, "INVALID_COMMAND"); assert.equal(f.calls.length, 1);
  await sandbox.close();
  await assert.rejects(sandbox.execute({ command: "node", args: [] }), code("SANDBOX_CLOSED"));
});

test("Seatbelt output, input and deadline limits stop dispatch and await process exit", async () => {
  for (const scenario of ["output", "input", "deadline"] as const) {
    const f = fixture({ hold: true, ...(scenario === "output" ? { output: "x".repeat(100) } : {}) });
    const sandbox = new SeatbeltProcessSandbox({ maxOutputBytes: 80, maxInputBytes: 400, timeoutMs: 1000 }, f.driver);
    let stopped = 0, output = "";
    const result = await sandbox.run({ command: "node", args: [], maxOutputBytes: 8, maxInputBytes: 40, timeoutMs: scenario === "deadline" ? 30 : 1000 }, {
      started(process) { if (scenario === "input") process.write("a".repeat(100)); },
      stdout(data) { output += data.toString(); }, stopped() { stopped++; },
    });
    assert.equal(result.reason, scenario === "deadline" ? "timeout" : `${scenario}-limit`);
    assert.equal(result.cleanup, "verified"); assert.equal(stopped, 1); assert.ok(f.killed() >= 1);
    assert.equal((result.profile as Record<string, unknown>).maxOutputBytes, 8);
    assert.equal((result.profile as Record<string, unknown>).maxInputBytes, 40);
    assert.equal((result.profile as Record<string, unknown>).timeoutMs, scenario === "deadline" ? 30 : 1000);
    assert.ok(output.length <= 8);
    await sandbox.close();
  }
});

test("Seatbelt close cancels live work and unconfirmed cleanup retains inspectable resources", async () => {
  const f = fixture({ neverClose: true }), sandbox = new SeatbeltProcessSandbox({ cleanupMs: 20 }, f.driver);
  const started = deferred();
  const pending = sandbox.run({ command: "node", args: [] }, { started() { started.resolve(); } });
  await started.promise;
  const closing = assert.rejects(sandbox.close(), code("RESTART_REQUIRED"));
  const result = await pending; await closing;
  assert.equal(result.cleanup, "unconfirmed"); assert.equal(result.code, "CLEANUP_UNCONFIRMED");
  const detail = sandbox.health().details[0]!;
  assert.equal(detail.pid, 123456789); assert.equal(detail.id, result.id); assert.equal(detail.retainedPaths.length, 1);
  await access(detail.retainedPaths[0]!);
  await assert.rejects(sandbox.execute({ command: "node", args: [] }), code("RESTART_REQUIRED"));
  // The fake transport deliberately never terminates. Remove only its known fixture directory.
  await rm(detail.retainedPaths[0]!, { recursive: true, force: true });
});

test("cancellation during shared Seatbelt preparation prevents all untrusted dispatch", async () => {
  const f = fixture(), prepare = deferred();
  const driver = { ...f.driver, async prepare(node: string) { await prepare.promise; return f.driver.prepare(node, []); } };
  const sandbox = new SeatbeltProcessSandbox({}, driver), controller = new AbortController();
  const pending = sandbox.execute({ command: "node", args: [], signal: controller.signal });
  controller.abort();
  assert.equal((await pending).reason, "cancelled"); assert.equal(f.calls.length, 0);
  let closed = false;
  const closing = sandbox.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  prepare.resolve(); await closing;
  assert.equal(closed, true); assert.equal(f.calls.length, 0);
});

test("non-macOS or unavailable Seatbelt fails closed", async () => {
  const f = fixture();
  await assert.rejects(new SeatbeltProcessSandbox({}, { ...f.driver, platform: "linux" }).execute({ command: "node", args: [] }), code("ISOLATION_UNAVAILABLE"));
  const sandbox = new SeatbeltProcessSandbox({}, { ...f.driver, async prepare() { throw new Error("missing"); } });
  const result = await sandbox.execute({ command: "node", args: [] });
  assert.equal(result.reason, "spawn-failed"); assert.equal(result.code, "ISOLATION_UNAVAILABLE");
  assert.equal(f.calls.length, 0); await sandbox.close();
});

test("real Seatbelt filters files, blocks sockets/spawn, and erases per-command writes", { skip: process.platform !== "darwin" || process.env.MINICAH_NATIVE_TEST !== "1" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "minicah-native-fixture-"));
  const sandbox = new SeatbeltProcessSandbox({ workspace: root });
  t.after(async () => { await sandbox.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "source.txt"), "fixture"); await writeFile(join(root, ".env.example"), "fixture-only-not-real");
  const script = `
    const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net'),os=require('node:os');
    const denied={};
    for(const file of ['.env.example',${JSON.stringify(join(root, "source.txt"))}])try{fs.readFileSync(file);denied[file]=false}catch(e){denied[file]=true}
    fs.writeFileSync('source.txt','ephemeral');
    const socket=net.connect({host:'127.0.0.1',port:1});
    socket.on('error',error=>{console.log(JSON.stringify({denied,spawn:cp.spawnSync('/bin/echo',['child']).error?.code,network:error.code,os:os.type(),text:fs.readFileSync('source.txt','utf8'),env:Object.keys(process.env).sort()}))});
  `;
  const result = await sandbox.execute({ command: "node", args: ["-e", script], workspace: "snapshot" });
  assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.cleanup, "verified");
  const value = JSON.parse(result.stdout);
  assert.ok(Object.values(value.denied).every(Boolean)); assert.equal(value.spawn, "EPERM");
  assert.equal(value.network, "EPERM"); assert.equal(value.os, "Darwin"); assert.equal(value.text, "ephemeral");
  assert.deepEqual(value.env, ["HOME", "OPENSSL_CONF", "PATH", "TMPDIR"]);
  assert.equal(await readFile(join(root, "source.txt"), "utf8"), "fixture");
  const timeout = await sandbox.execute({ command: "node", args: ["-e", "while(true){}"], timeoutMs: 50 });
  assert.equal(timeout.reason, "timeout"); assert.equal(timeout.cleanup, "verified");
  assert.deepEqual(sandbox.health().unresolved, []);
});
