import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Runtime, createHotReloadPlugin, hotReloadService, serviceToken, HarnessError, createCliCommandsPlugin, cliCommandService,
  type HotReloadOptions, type JsonValue, type Plugin, type ReloadReport,
} from "../src/index.js";
import { code, deferred, plugin, tick } from "./helpers.js";

const valueService = serviceToken<string>("watch-value");
function valuePlugin(id = "value", mode: "run" | "static" = "run", order: string[] = []): Plugin {
  return plugin(id, { provides: [valueService], configMode: mode, validateConfig(input) {
    const value = (input as { value?: unknown } | undefined)?.value ?? "original";
    if (typeof value !== "string") throw new HarnessError("INVALID_CONFIG", "value must be a string");
    return { value };
  }, setup(ctx) {
    if (mode === "run") ctx.provide(valueService, run => (run.configuration.values[id] as { value: string }).value);
    else {
      const value = (ctx.config as { value: string }).value;
      const resource = ctx.resource("value", () => { order.push(`start:${value}`); if (value === "fail") throw new Error("activation failed"); return value; }, value => { order.push(`stop:${value}`); });
      ctx.provide(valueService, () => resource.get());
    }
  } });
}
async function until(check: () => boolean, message = "expected watcher update"): Promise<void> {
  const end = Date.now() + 6000;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(check(), message);
}
async function fixture(t: TestContext, entry = valuePlugin(), options: Partial<HotReloadOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "minicah-hmr-")), path = join(root, "missing", "nested", "config.json");
  const hot = createHotReloadPlugin({ path, catalog: [{ plugin: entry }], debounceMs: 30, stabilityMs: 80, pollIntervalMs: 20,
    usePolling: process.env.MINICAH_TEST_POLLING === "1", ...options });
  const reports: ReloadReport[] = [];
  hot.subscribe(report => reports.push(report));
  const runtime = await Runtime.create({ plugins: [entry, createCliCommandsPlugin(), hot.plugin] });
  t.after(async () => { await hot.stop(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await hot.start(runtime)).status, "unchanged");
  const session = await runtime.openSession();
  const save = async (value: unknown) => { await mkdir(join(root, "missing", "nested"), { recursive: true }); await writeFile(path, JSON.stringify(value)); };
  return { root, path, hot, runtime, session, reports, save, read: () => session.run(run => run.services.get(valueService)) };
}
const profile = (value: JsonValue) => ({ version: 1, plugins: { value: { config: { value } } } });

test("watcher detects missing parents, editor rename-save, invalid JSON, corrections and deletion", async t => {
  const f = await fixture(t);
  assert.equal(f.hot.status().watching, true);
  await f.save(profile("first"));
  await until(() => (f.runtime.configuration().values.value as { value: string }).value === "first");
  assert.equal(await f.read(), "first");
  const originalVersion = f.runtime.configuration().version;
  await writeFile(f.path + ".new", JSON.stringify(profile("second")));
  await rename(f.path + ".new", f.path);
  await until(() => (f.runtime.configuration().values.value as { value: string }).value === "second");
  assert.equal(f.runtime.configuration().version, originalVersion + 1);
  await writeFile(f.path, '{"version":');
  await until(() => f.reports.at(-1)?.code === "PROFILE_PARSE");
  assert.equal(await f.read(), "second");
  await f.save(profile("third"));
  await until(() => (f.runtime.configuration().values.value as { value: string }).value === "third");
  await rm(f.path);
  await until(() => (f.runtime.configuration().values.value as { value: string }).value === "original");
  assert.equal(await f.read(), "original");
  await f.hot.stop();
  const version = f.runtime.configuration().version;
  await f.save(profile("after-stop"));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(f.runtime.configuration().version, version);
  await assert.rejects(f.hot.reload(), code("HMR_CLOSED"));
});

test("manual L1 updates preserve running snapshots and reject the whole invalid candidate", async t => {
  const f = await fixture(t, valuePlugin(), { watch: false });
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const running = f.session.run(async run => { entered.resolve(); await release.promise; return run.services.get(valueService); });
  await entered.promise;
  await f.save(profile("next"));
  assert.equal((await f.hot.reload()).status, "applied");
  assert.equal(await f.read(), "next");
  release.resolve(); assert.equal(await running, "original");
  const version = f.runtime.configuration().version;
  assert.equal((await f.hot.reload()).status, "unchanged");
  assert.equal(f.runtime.configuration().version, version);
  await f.save({ version: 1, plugins: { value: { config: { value: "must-not-apply" } }, unknown: { enabled: true } } });
  assert.equal((await f.hot.reload()).code, "PROFILE_PLUGIN");
  assert.equal(await f.read(), "next");
  await f.save(profile(42));
  assert.equal((await f.hot.reload()).status, "failed");
  assert.equal(await f.read(), "next");
  await f.save({ version: 1, plugins: {} });
  assert.equal((await f.hot.reload()).status, "applied");
  assert.equal(await f.read(), "original");
  await f.session.run(run => {
    assert.equal(run.services.get(hotReloadService).status().watching, false);
    assert.equal(run.services.get(cliCommandService).parse("/reload").kind, "reload");
    assert.equal(run.services.get(cliCommandService).parse("/plugins extra").kind, "error");
  });
});

test("static profile edits wait for active runs, keep generations pinned, and roll back failed acquisition", async t => {
  const order: string[] = [], f = await fixture(t, valuePlugin("value", "static", order), { watch: false });
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const running = f.session.run(async run => { entered.resolve(); await release.promise; assert.equal(run.services.get(valueService), "original"); });
  await entered.promise; await f.save(profile("new"));
  let completed = false;
  const reload = f.hot.reload().then(report => { completed = true; return report; });
  await until(() => f.runtime.inspect().length > 0); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(completed, false); assert.deepEqual(order, ["start:original"]);
  release.resolve(); await running;
  assert.equal((await reload).status, "applied");
  assert.deepEqual(order, ["start:original", "start:new", "stop:original"]);
  assert.equal(f.runtime.plugins().find(item => item.id === "value")?.generation, 2);
  await f.save(profile("fail"));
  assert.equal((await f.hot.reload()).status, "failed");
  assert.equal(await f.read(), "new");
  assert.equal(f.runtime.health().restartRequired, false);
  await f.save(profile("recovered"));
  assert.equal((await f.hot.reload()).status, "applied");
  assert.equal(await f.read(), "recovered");
});

test("a complete profile toggles dependent plugins together and validates before any setup", async t => {
  const provider = valuePlugin(), consumer = plugin("consumer", { requires: [valueService] });
  const f = await fixture(t, provider, { watch: false, catalog: [{ plugin: provider }, { plugin: consumer }] });
  await f.save({ version: 1, plugins: { consumer: { enabled: true } } });
  assert.equal((await f.hot.reload()).status, "applied");
  await f.save({ version: 1, plugins: { value: { enabled: false }, consumer: { enabled: false } } });
  assert.equal((await f.hot.reload()).status, "applied");
  assert.ok(!f.runtime.plugins().some(item => item.id === "value" || item.id === "consumer"));
  await f.save({ version: 1, plugins: { value: { enabled: false }, consumer: { enabled: true } } });
  assert.equal((await f.hot.reload()).code, "MISSING_DEPENDENCY");
  assert.ok(!f.runtime.plugins().some(item => item.id === "consumer"));
  await f.save({ version: 1, plugins: { value: { enabled: true }, consumer: { enabled: true } } });
  assert.equal((await f.hot.reload()).status, "applied");
  assert.equal(await f.read(), "original");
});

test("events arriving while an update drains are reconciled again, not lost", async t => {
  const f = await fixture(t, valuePlugin("value", "static"));
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const running = f.session.run(async () => { entered.resolve(); await release.promise; });
  await entered.promise; await f.save(profile("intermediate"));
  // Allow the first refresh to enter the drain, then change the file again.
  await new Promise(resolve => setTimeout(resolve, 300));
  await f.save(profile("latest"));
  await new Promise(resolve => setTimeout(resolve, 300));
  release.resolve(); await running;
  await until(() => (f.runtime.configuration().values.value as { value: string }).value === "latest");
  assert.equal(await f.read(), "latest");
});

test("code changes request restart without loading code; config-only recovery does not clear that request", async t => {
  const root = await mkdtemp(join(tmpdir(), "minicah-hmr-code-")), path = join(root, "plugin.mjs");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path, 'throw new Error("must never import")');
  const f = await fixture(t, valuePlugin(), { codePaths: [path] });
  await writeFile(path, 'throw new Error("still must never import")');
  await until(() => f.hot.status().restartRequired);
  assert.deepEqual(f.hot.status().restartPaths, [path]);
  await f.save(profile("updated"));
  await until(() => (f.runtime.configuration().values.value as { value: string }).value === "updated");
  assert.equal(f.hot.status().restartRequired, true);
  assert.equal(f.runtime.health().restartRequired, false);
  assert.equal(await f.read(), "updated");
});

test("profile limits, schema, symlinks and protected entries fail without exposing config contents", async t => {
  const entry = valuePlugin(), f = await fixture(t, entry, { watch: false, catalog: [{ plugin: entry, toggle: false }] });
  await f.save({ version: 1, plugins: { value: { enabled: false } } });
  assert.equal((await f.hot.reload()).code, "PROFILE_PROTECTED");
  await f.save({ version: 2, plugins: {} });
  assert.equal((await f.hot.reload()).code, "PROFILE_SCHEMA");
  await writeFile(f.path, "private-secret".repeat(30000));
  assert.equal((await f.hot.reload()).code, "PROFILE_SIZE");
  await rm(f.path); await writeFile(f.path + ".secret", "private-secret"); await symlink(f.path + ".secret", f.path);
  assert.equal((await f.hot.reload()).code, "PROFILE_READ");
  assert.ok(!JSON.stringify(f.hot.history()).includes("private-secret"));
  assert.equal(await f.read(), "original");
});

test("runtime disposal cancels a queued reload without lifecycle deadlock or late mutation", async t => {
  const entered = deferred(), release = deferred();
  const blocker = plugin("blocker", { setup(ctx) { ctx.onCleanup(async () => { entered.resolve(); await release.promise; }); } });
  const f = await fixture(t, valuePlugin(), { watch: false });
  await f.runtime.enablePlugin(blocker);
  const closing = f.runtime.close();
  await entered.promise;
  await f.save(profile("too-late"));
  const pending = f.hot.reload();
  await tick(); release.resolve();
  await closing;
  await pending.catch(() => {});
  assert.equal(f.hot.status().closed, true);
  assert.equal((f.runtime.configuration().values.value as { value: string }).value, "original");
});

test("batch replacement changes provider and consumer interfaces at one boundary", async t => {
  const v1 = serviceToken<string>("dependency", 1), v2 = serviceToken<string>("dependency", 2);
  const provider = (token: typeof v1, value: string) => plugin("provider", { provides: [token], setup(ctx) { ctx.provide(token, () => value); } });
  const consumer = (token: typeof v1) => plugin("consumer", { requires: [token], setup(ctx) { ctx.registerTool({ name: "read", description: "", inputSchema: { type: "object" }, execute: (_, run) => run.services.get(token) }); } });
  const runtime = await Runtime.create({ plugins: [provider(v1, "old"), consumer(v1)] }); t.after(() => runtime.close());
  const session = await runtime.openSession();
  const update = await runtime.applyUpdate({ changes: [{ kind: "replace", plugin: provider(v2, "new") }, { kind: "replace", plugin: consumer(v2) }] });
  assert.equal(update.status, "applied"); assert.equal(update.upgrades.length, 2);
  assert.equal(new Set(update.upgrades.map(item => item.operationId)).size, 1);
  assert.equal(await session.run(run => run.tools.invoke("read", {})), "new");
  const version = runtime.configuration().version;
  await assert.rejects(runtime.applyUpdate({ changes: [{ kind: "disable", id: "provider" }], config: {} }), code("MISSING_DEPENDENCY"));
  assert.equal(runtime.configuration().version, version);
  assert.equal(await session.run(run => run.tools.invoke("read", {})), "new");
});

test("mixed L1 and L2 edits do not publish config when a static candidate fails", async t => {
  const runtime = await Runtime.create({ plugins: [valuePlugin("value", "static"), plugin("dynamic", {
    configMode: "run", validateConfig: input => input ?? { n: 1 },
  })] });
  t.after(() => runtime.close());
  const session = await runtime.openSession(), before = runtime.configuration();
  await assert.rejects(runtime.applyUpdate({ config: { value: { value: "fail" }, dynamic: { n: 2 } } }), code("REPLACEMENT_FAILED"));
  assert.equal(runtime.configuration(), before);
  assert.equal(await session.run(run => run.services.get(valueService)), "original");
  const result = await runtime.applyUpdate({ config: { value: { value: "ok" }, dynamic: { n: 2 } } });
  assert.equal(result.status, "applied");
  assert.deepEqual(runtime.configuration().values.dynamic, { n: 2 });
  assert.equal(await session.run(run => run.services.get(valueService)), "ok");
});

test("disposing the HMR plugin cancels updates queued behind its disposal and supports fresh re-enable", async t => {
  const f = await fixture(t, valuePlugin(), { watch: false });
  const entered = deferred(), release = deferred();
  const enabling = f.runtime.enablePlugin(plugin("slow", { async setup() { entered.resolve(); await release.promise; } }));
  await entered.promise;
  const disabling = f.runtime.disablePlugin("hot-reload");
  await f.save(profile("must-not-apply"));
  const reload = f.hot.reload().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 30));
  release.resolve();
  await enabling; await disabling; await reload;
  assert.equal(f.hot.status().closed, true);
  assert.equal(await f.read(), "original");
  await f.runtime.enablePlugin("hot-reload");
  assert.equal((await f.hot.start(f.runtime)).status, "applied");
  assert.equal(await f.read(), "must-not-apply");
});
