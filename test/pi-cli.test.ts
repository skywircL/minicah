import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const agent = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const evaluation = fileURLToPath(new URL("../src/evaluation/cli.js", import.meta.url));
const smokeSuite = fileURLToPath(new URL("../../examples/evaluation-smoke.json", import.meta.url));
const environment = { PATH: process.env.PATH };

test("Pi catalog and help are offline CLI operations that do not read dotenv or create sessions", async t => {
  const root = await mkdtemp(join(tmpdir(), "minicah-pi-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A directory would make loadCliEnvironment fail if a listing accidentally loaded it.
  await mkdir(join(root, ".env"));
  for (const cli of [agent, evaluation]) {
    const help = await exec(process.execPath, [cli, "--help"], { cwd: root, env: environment, timeout: 10000 });
    assert.match(help.stdout, /--pi-provider/); assert.match(help.stdout, /--reasoning/);
    const { stdout } = await exec(process.execPath, [cli, "--list-models", "--pi-provider", "openai"], { cwd: root, env: environment, timeout: 10000 });
    const models = JSON.parse(stdout) as { provider: string; id: string; contextWindow: number }[];
    assert.ok(models.some(model => model.id === "gpt-4.1"));
    assert.ok(models.every(model => model.provider === "openai" && model.contextWindow > 0));
  }
  assert.deepEqual(await readdir(root), [".env"]);
});

test("Pi CLI validates route and option combinations before model dispatch", async t => {
  const root = await mkdtemp(join(tmpdir(), "minicah-pi-args-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalid: string[][] = [
    ["--provider", "pi"],
    ["--pi-provider", "openai", "--model", "gpt-4.1"],
    ["--provider", "pi", "--pi-provider", "openai", "--model", "gpt-4.1", "--thinking"],
    ["--provider", "deepseek", "--reasoning", "high"],
  ];
  for (const args of invalid) {
    await assert.rejects(exec(process.execPath, [agent, "--task", "never dispatch", ...args], { cwd: root, env: environment, timeout: 10000 }), error => {
      assert.match((error as { stderr: string }).stderr, /CLI_ARGUMENT/); return true;
    });
  }
  await assert.rejects(exec(process.execPath, [agent, "--task", "never dispatch", "--provider", "pi", "--pi-provider", "openai", "--model", "gpt-4.1"], { cwd: root, env: environment, timeout: 10000 }), error => {
    assert.match((error as { stderr: string }).stderr, /MODEL_KEY_MISSING.*OPENAI_API_KEY/); return true;
  });
  for (const args of [["--provider", "pi"], ["--provider", "pi", "--pi-provider", "openai", "--model", "gpt-4.1", "--thinking"], ["--provider", "fixture", "--reasoning", "low"]]) {
    await assert.rejects(exec(process.execPath, [evaluation, "--suite", smokeSuite, ...args], { cwd: root, env: environment, timeout: 10000 }), error => {
      assert.match((error as { stderr: string }).stderr, /EVAL_ARGUMENT/); return true;
    });
  }
  assert.deepEqual(await readdir(root), []);
});

test("Pi CLI installs one model plugin and applies its hot reload profile without a model request", async t => {
  const root = await mkdtemp(join(tmpdir(), "minicah-pi-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".minicah"));
  await writeFile(join(root, ".env"), "OPENAI_API_KEY=pi-profile-fixture-secret\n");
  await writeFile(join(root, ".minicah", "config.json"), JSON.stringify({ version: 1, plugins: { "pi-model": { config: { maxOutputTokens: 2048 } } } }));
  const { stdout, stderr } = await exec(process.execPath, [agent, "--workspace", root, "--provider", "pi", "--pi-provider", "openai", "--model", "gpt-4.1", "--endpoint", "http://127.0.0.1:1", "--no-watch", "--task", "/plugins"], { cwd: root, env: environment, timeout: 10000 });
  const state = JSON.parse(stdout) as { plugins: { id: string }[]; last: { status: string; configurationVersion: number } };
  assert.ok(state.plugins.some(plugin => plugin.id === "pi-model"));
  assert.ok(!state.plugins.some(plugin => plugin.id === "deepseek-model"));
  assert.equal(state.last.status, "applied"); assert.equal(state.last.configurationVersion, 2);
  assert.doesNotMatch(stdout + stderr, /pi-profile-fixture-secret/);
  const id = /Session: (\S+)/.exec(stderr)?.[1]; assert.ok(id);
  // Replay remains independent of provider selection, model configuration and credentials.
  await rm(join(root, ".env")); await mkdir(join(root, ".env"));
  const replay = await exec(process.execPath, [agent, "--workspace", root, "--provider", "pi", "--replay", id], { cwd: root, env: environment, timeout: 10000 });
  assert.doesNotMatch(replay.stderr, /MODEL_KEY_MISSING|ENV_FILE_READ/);
});

test("Pi evaluation CLI executes a local Google tool loop and records the selected route without credentials", async t => {
  const root = await mkdtemp(join(tmpdir(), "minicah-pi-eval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: { path: string; body: any }[] = [], failures: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw); requests.push({ path: req.url ?? "", body });
      assert.ok(!JSON.stringify(body).includes("pi-eval-private-key"));
      const parts = requests.length === 1
        ? [{ functionCall: { id: "eval_read", name: "read_file", args: { path: "input.txt" } } }]
        : [{ text: "HELLO MINICAH" }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 24, candidatesTokenCount: 6, totalTokenCount: 30 }, modelVersion: "gemini-2.5-flash", responseId: "eval_google_fixture" })}\n\n`);
    } catch (error) { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.deepEqual(failures, []); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const suite = JSON.parse(await readFile(smokeSuite, "utf8")); suite.tasks = suite.tasks.slice(0, 1);
  const suitePath = join(root, "suite.json"); await writeFile(suitePath, JSON.stringify(suite));
  const { stdout } = await exec(process.execPath, [evaluation, "--suite", suitePath, "--provider", "pi", "--pi-provider", "google", "--model", "gemini-2.5-flash", "--endpoint", `http://127.0.0.1:${address.port}`, "--output", join(root, "reports")], { cwd: root, env: { ...environment, GEMINI_API_KEY: "pi-eval-private-key" }, timeout: 15000 });
  const result = JSON.parse(stdout) as { provider: string; status: string; artifactDirectory: string };
  assert.equal(result.provider, "pi"); assert.equal(result.status, "completed");
  assert.equal(requests.length, 2); assert.match(requests[0]!.path, /models\/gemini-2\.5-flash:streamGenerateContent/);
  assert.match(JSON.stringify(requests[1]!.body), /functionResponse/); assert.match(JSON.stringify(requests[1]!.body), /hello minicah/);
  const reportText = await readFile(join(result.artifactDirectory, "report.json"), "utf8");
  const report = JSON.parse(reportText) as { reference: { model: string; configurationHash: string }; trials: { passed: boolean; journalRefs: string[] }[] };
  assert.equal(report.reference.model, "google/gemini-2.5-flash"); assert.match(report.reference.configurationHash, /^[a-f0-9]{64}$/);
  assert.equal(report.trials[0]?.passed, true); assert.doesNotMatch(reportText, /pi-eval-private-key/);
  for (const path of report.trials[0]!.journalRefs) assert.doesNotMatch(await readFile(join(result.artifactDirectory, path), "utf8"), /pi-eval-private-key/);
});
