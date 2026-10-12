import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtcPlugin, createSandboxExecutionPlugin, createSeatbeltSandboxPlugin, services } from "../src/index.js";
import { echoTool, pipelineFixture } from "./pipeline-helpers.js";

test("real macOS shared sandbox: native command and PTC, no Docker, persistent audit and no Host workspace reads", {
  skip: process.platform !== "darwin" || process.env.MINICAH_NATIVE_TEST !== "1",
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "minicah-native-shared-")));
  const fixture = await pipelineFixture(t, [echoTool], {}, false, [createSeatbeltSandboxPlugin({ workspace: root }), createSandboxExecutionPlugin(root), createPtcPlugin(undefined, { deadlineMs: 60_000 })]);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.txt"), "original"); await writeFile(join(root, ".env"), "TEST_SECRET=private");
  await mkdir(join(root, ".minicah")); await writeFile(join(root, ".minicah", "events"), "audit");
  await fixture.run(async (_tools, log, run) => {
    const [command, program] = await Promise.all([
      run.services.get(services.execution).execute({ command: "node", args: ["-e", `
        const fs = require('node:fs');
        const original = fs.readFileSync('source.txt','utf8'); fs.writeFileSync('source.txt','private-copy');
        const invisible = ['.env','.minicah/events',${JSON.stringify(join(root, "source.txt"))}].every(path => {try {fs.readFileSync(path);return false;}catch{return true;}});
        console.log(JSON.stringify({original,invisible,keyVisible:Object.hasOwn(process.env,'DEEPSEEK_API_KEY')}));
      `], cwd: root }),
      run.services.get(services.ptcRuntime).evaluate({ input: { path: join(root, "source.txt") }, bindings: ["echo"], program: `
        const fs = await import('node:fs'); let hostVisible = false;
        try { fs.readFileSync(input.path); hostVisible = true; } catch {}
        const replies = await Promise.all(['one','two'].map(text => tools.echo({text})));
        return {hostVisible, values:replies.map(reply=>reply.value.text)};
      ` }),
    ]);
    assert.equal(command.exitCode, 0, JSON.stringify(command)); assert.equal(command.sandbox?.cleanup, "verified");
    assert.deepEqual(JSON.parse(command.stdout), { original: "original", invisible: true, keyVisible: false });
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), "original");
    assert.equal(program.status, "completed", JSON.stringify(program));
    assert.deepEqual(program.output.value, { hostVisible: false, values: ["one", "two"] });
    assert.equal(program.children.length, 2); assert.ok(program.children.every(child => child.parentCallId === program.callId));
    assert.ok(program.execution?.id); assert.equal(program.cleanup, "verified");
    const final = log.events().find(event => event.callId === program.callId && event.data.type === "ptc.completed");
    assert.equal((final?.data as any).result.execution.id, program.execution!.id);
    assert.deepEqual(run.services.get(services.sandbox).health().unresolved, []);
  });
});
