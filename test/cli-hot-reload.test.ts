import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Runtime, createHotReloadPlugin, createCliPlugin, createCliCommandsPlugin, createSessionPlugin, createSessionCatalogPlugin, CliSessions, type CliIO, type JsonValue } from "../src/index.js";
import { plugin } from "./helpers.js";

test("CLI /reload runs outside the parse snapshot and /plugins does not invoke the model", { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "minicah-cli-hmr-")), path = join(root, "config.json");
  const directory = join(root, "sessions"), output: string[] = [];
  const entry = plugin("settings", { validateConfig: input => input ?? { value: "initial" } });
  const hot = createHotReloadPlugin({ path, catalog: [{ plugin: entry }], watch: false });
  const answers = ["/reload", "/plugins", "/help", "/exit"];
  const io: CliIO = { interactive: true, async question() { return answers.shift() ?? "/exit"; }, write(_, text) { output.push(text); }, onInterrupt: () => () => {}, close() {} };
  const cli = createCliPlugin({ io, hotReload: hot });
  const runtime = await Runtime.create({ plugins: [entry, hot.plugin, createCliCommandsPlugin(), createSessionPlugin({ directory }), createSessionCatalogPlugin(directory, root), cli.plugin] });
  t.after(async () => { await hot.stop(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  await hot.start(runtime);
  await writeFile(path, JSON.stringify({ version: 1, plugins: { settings: { config: { value: "changed" } } } }));
  const sessions = new CliSessions(runtime, await runtime.openSession(), root);
  assert.equal(await cli.start(sessions), 0);
  assert.equal(runtime.plugins().find(item => item.id === "settings")!.generation, 2);
  assert.match(output.join(""), /\[热更新\] applied/);
  assert.match(output.join(""), /"generation": 2/);
  assert.match(output.join(""), /\/reload/);
});

test("real CLI loads the profile at startup, exposes status and exits cleanly without a model request", async t => {
  const root = await mkdtemp(join(tmpdir(), "minicah-cli-hmr-main-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".minicah"));
  const path = join(root, ".minicah", "config.json");
  await writeFile(path, JSON.stringify({ version: 1, plugins: { "deepseek-model": { config: { maxOutputTokens: 8192 } } } }));
  const env = { PATH: process.env.PATH, DEEPSEEK_API_KEY: "test-only-no-request", DEEPSEEK_BASE_URL: "http://127.0.0.1:1" };
  const args = [fileURLToPath(new URL("../src/cli/main.js", import.meta.url)), "--workspace", root, "--no-watch", "--task", "/plugins"];
  const { stdout, stderr } = await promisify(execFile)(process.execPath, args, { cwd: root, env, timeout: 8000 });
  const status = JSON.parse(stdout) as { plugins: { id: string }[]; watching: boolean; last: { configurationVersion: number; status: string } };
  assert.equal(status.watching, false); assert.equal(status.last.status, "applied"); assert.equal(status.last.configurationVersion, 2);
  assert.ok(status.plugins.some(item => item.id === "deepseek-model"));
  assert.match(stderr, /\[热更新\] applied/); assert.ok(!stdout.includes("test-only-no-request"));
  await writeFile(path, JSON.stringify({ version: 1, plugins: { "deepseek-model": { config: { maxOutputTokens: -1 } } } } satisfies JsonValue));
  await assert.rejects(promisify(execFile)(process.execPath, args, { cwd: root, env, timeout: 8000 }), error => {
    assert.match((error as { stderr: string }).stderr, /HOT_RELOAD_START/); return true;
  });
});
