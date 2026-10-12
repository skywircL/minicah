import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerProcessSandbox, SandboxPtcBackend } from "../src/index.js";

const image = process.env.MINICAH_SANDBOX_IMAGE;
test("real shared sandbox: filtered writable snapshot, network/Host isolation, PTC without workspace, cancellation", { skip: !image }, async () => {
  const root = await mkdtemp(join(tmpdir(), "minicah-sandbox-real-"));
  const sandbox = new DockerProcessSandbox({ image: image!, workspace: root, timeoutMs: 20_000, memoryMiB: 256 });
  try {
    await writeFile(join(root, "source.txt"), "original");
    await writeFile(join(root, ".env"), "TEST_SECRET=never-mount-this");
    await mkdir(join(root, ".minicah")); await writeFile(join(root, ".minicah", "log"), "private-audit");
    const command = sandbox.execute({ command: "/usr/local/bin/node", args: ["-e", `
      const fs = require('node:fs'), net = require('node:net');
      fs.writeFileSync('source.txt', 'disposable-change'); fs.writeFileSync('output.txt','built');
      const forbidden = ['/.dockerenv-this-does-not-exist', '/input/.env', '/workspace/.env', '/workspace/.minicah/log', ${JSON.stringify(join(root, "source.txt"))}];
      const inaccessible = forbidden.every(path => { try { fs.readFileSync(path); return false; } catch { return true; } });
      let readonly = false; try { fs.writeFileSync('/root-write','no'); } catch { readonly = true; }
      const socket = net.connect({host:'192.0.2.1',port:9});
      const finish = connected => { socket.destroy(); console.log(JSON.stringify({inaccessible,readonly,connected,env:Object.keys(process.env).sort(),uid:process.getuid(),cwd:process.cwd(),source:fs.readFileSync('source.txt','utf8')})); };
      socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(1000, () => finish(false));
    `], workspace: "snapshot", cwd: "/workspace" });
    const ptc = new SandboxPtcBackend(sandbox).run({ program: `const fs = await import('node:fs'); return { value: input, workspaceVisible: fs.existsSync('/workspace/source.txt') || fs.existsSync('/input/source.txt') };`, input: "ptc", bindings: [], concurrency: 1, maxOutputBytes: 4096 }, { signal: new AbortController().signal, cancel() {}, async call() { throw new Error("No bindings"); } });
    const [result, program] = await Promise.all([command, ptc]);
    assert.equal(result.cleanup, "verified"); assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.stdout), { inaccessible: true, readonly: true, connected: false, env: ["HOME", "PATH"], uid: 65534, cwd: "/workspace", source: "disposable-change" });
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), "original");
    await assert.rejects(readFile(join(root, "output.txt")), { code: "ENOENT" });
    assert.equal(program.status, "completed", JSON.stringify(program)); assert.deepEqual(program.value, { value: "ptc", workspaceVisible: false });
    const stopped = await sandbox.execute({ command: "/usr/local/bin/node", args: ["-e", `require('node:child_process').spawn('/usr/local/bin/node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); setInterval(()=>{},1000);`], timeoutMs: 2000 });
    assert.equal(stopped.reason, "timeout"); assert.equal(stopped.cleanup, "verified");
    assert.deepEqual(sandbox.health().active, []); assert.deepEqual(sandbox.health().unresolved, []);
  } finally { await sandbox.close(); await rm(root, { recursive: true, force: true }); }
});
