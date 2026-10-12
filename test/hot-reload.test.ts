import assert from "node:assert/strict";
import test from "node:test";
import { Runtime, createSessionPlugin, serviceToken, services, type Plugin, type JsonValue } from "../src/index.js";
import { code, deferred, plugin, tick } from "./helpers.js";
import { definitions, journalFixture, versions } from "./session-helpers.js";

const endpoint = serviceToken<{ endpoint: string; model: string; toolPolicy: string }>("endpoint");
const initial = { endpoint: "https://one.example", model: "model-1", toolPolicy: "ask" };
function schema(input: JsonValue | undefined) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("object required");
  const value = input as Record<string, JsonValue>;
  if (typeof value.endpoint !== "string" || !/^https:\/\//.test(value.endpoint) || typeof value.model !== "string" || !["ask", "deny"].includes(String(value.toolPolicy))) throw new Error("invalid endpoint/model/tool policy");
  return { endpoint: value.endpoint, model: value.model, toolPolicy: String(value.toolPolicy) };
}
const dynamic = (setup = () => {}) => plugin("provider", { configMode: "run", validateConfig: schema, provides: [endpoint], setup(ctx) {
  setup();
  ctx.provide(endpoint, run => schema(run.configuration.values.provider));
} });

test("L1 validates schemas and changes only subsequent run snapshots without draining", async () => {
  let setups = 0;
  const runtime = await Runtime.create({ plugins: [dynamic(() => { setups++; })], config: { provider: initial } });
  const session = await runtime.openSession();
  const entered = deferred(), release = deferred();
  const old = session.run(async run => {
    const before = run.configuration;
    assert.equal(run.services.get(endpoint).model, "model-1");
    entered.resolve(); await release.promise;
    assert.equal(run.configuration, before);
    assert.equal(run.services.get(endpoint).endpoint, initial.endpoint);
  });
  await entered.promise;
  const updated = await runtime.updateConfig({ provider: { endpoint: "https://two.example", model: "model-2", toolPolicy: "deny" } });
  assert.equal(updated.reason, "L1"); assert.equal(updated.version, 2);
  await session.run(run => {
    assert.equal(run.configuration.id, updated.id);
    assert.equal(run.services.get(endpoint).toolPolicy, "deny");
    assert.equal(run.manifest.plugins[0]!.generation, 1);
    assert(Object.isFrozen(run.configuration.values.provider));
  });
  await assert.rejects(runtime.updateConfig({ provider: { endpoint: "bad", model: "oops", toolPolicy: "ask" } }), code("INVALID_CONFIG"));
  assert.equal(runtime.configurationHistory().length, 2);
  assert.equal(setups, 1);
  release.resolve(); await old; await runtime.close();
});

test("static setup configuration cannot silently accept L1 and run-config setup cannot capture values", async () => {
  const runtime = await Runtime.create({ plugins: [plugin("static")] });
  await assert.rejects(runtime.updateConfig({ static: {} }), code("STATIC_CONFIG"));
  await runtime.close();
  await assert.rejects(Runtime.create({ plugins: [plugin("dynamic", { configMode: "run", validateConfig: () => ({}), setup(ctx) { void ctx.config; } })] }), code("SETUP_FAILED"));
});

test("asynchronous configuration invalidation is rejected instead of creating an approval race", async () => {
  await assert.rejects(Runtime.create({ plugins: [plugin("async-observer", { setup(ctx) {
    ctx.onConfigChange(async () => {});
  } })] }), code("SETUP_FAILED"));
});

test("configuration revisions and generation manifests are retained in the authoritative Session log", async t => {
  const fixture = await journalFixture(t);
  const runtime = await Runtime.create({ plugins: [dynamic(), createSessionPlugin({ directory: fixture.directory })], config: { provider: initial } });
  try {
    const session = await runtime.openSession("persistent-config");
    const record = () => session.run(async run => {
      const log = run.services.get(services.session);
      await log.retain(definitions); await log.start(versions, {});
      await log.record([{ callId: run.id, data: { type: "model.requested", request: { endpoint: run.services.get(endpoint).endpoint } } }]);
      return log.reconstructRequest(run.id);
    });
    const before = await record();
    await runtime.updateConfig({ provider: { ...initial, endpoint: "https://next.example", model: "new-model" } });
    const after = await record();
    assert.equal(before.manifest!.configuration.version, 1);
    assert.equal(after.manifest!.configuration.version, 2);
    assert.deepEqual(before.manifest!.configuration.values.provider, initial);
    assert.equal((after.manifest!.configuration.values.provider as Record<string, JsonValue>).model, "new-model");
  } finally { await runtime.close(); }
});

test("L2 stages registrations before blocking, acquires after drain, and pairs schema with execute generation", async () => {
  const staged = deferred(), allowStage = deferred(), releaseOld = deferred();
  const order: string[] = [];
  const provider = (version: number, stageWait = false): Plugin => plugin("tool", { version: `${version}.0.0`, async setup(ctx) {
    const resource = ctx.resource("connection", () => { order.push(`acquire-${version}`); return version; }, () => { order.push(`retire-${version}`); });
    ctx.registerTool({ name: "version", description: "", inputSchema: { const: version }, execute: () => resource.get() });
    if (stageWait) { staged.resolve(); await allowStage.promise; }
  } });
  const runtime = await Runtime.create({ plugins: [provider(1)] });
  const session = await runtime.openSession();
  const entered = deferred();
  const old = session.run(async run => {
    entered.resolve(); await releaseOld.promise;
    assert.deepEqual(run.tools.list()[0]!.inputSchema, { const: 1 });
    assert.equal(await run.tools.invoke("version", {}), 1);
  });
  await entered.promise;
  const replacing = runtime.replacePlugin(provider(2, true));
  await staged.promise;
  assert.deepEqual(order, ["acquire-1"]);
  assert.equal(await session.run(run => run.tools.invoke("version", {})), 1, "admission remains open during staging");
  allowStage.resolve(); await tick();
  let admitted = false;
  const next = session.run(async run => {
    admitted = true;
    assert.deepEqual(run.tools.list()[0]!.inputSchema, { const: 2 });
    assert.equal(run.tools.list()[0]!.generation, 2);
    assert.equal(run.manifest.tools[0]!.generation, 2);
    return run.tools.invoke("version", {});
  });
  await tick(); assert.equal(admitted, false); assert.deepEqual(order, ["acquire-1"]);
  releaseOld.resolve(); await old;
  const result = await replacing;
  assert.equal(result.status, "switched");
  assert.deepEqual(order, ["acquire-1", "acquire-2", "retire-1"]);
  assert.equal(await next, 2);
  assert.equal(runtime.upgradeHistory().at(-1), result);
  await runtime.close();
});

test("enable/disable validate dependencies and generations are not reused", async () => {
  const base = serviceToken<object>("base");
  const runtime = await Runtime.create({ plugins: [plugin("base", { provides: [base], setup(ctx) { ctx.provide(base, () => ({})); } }), plugin("consumer", { requires: [base] })] });
  await assert.rejects(runtime.disablePlugin("base"), code("MISSING_DEPENDENCY"));
  await runtime.disablePlugin("consumer"); await runtime.disablePlugin("base");
  const session = await runtime.openSession();
  await session.run(run => assert.throws(() => run.services.get(base), code("MISSING_SERVICE")));
  await assert.rejects(runtime.enablePlugin("consumer"), code("MISSING_DEPENDENCY"));
  const enabled = await runtime.enablePlugin("base"); await runtime.enablePlugin("consumer");
  assert.equal(enabled.generation, 3);
  await session.run(run => assert.equal(run.services.list()[0]!.generation, 3));
  await runtime.close();
});

test("stop-first resource activation failure reports restart-required without claiming rollback", async () => {
  const order: string[] = [];
  const first = plugin("exclusive", { replacementBoundary: "stop-first", setup(ctx) {
    ctx.resource("exclusive", () => { order.push("start-old"); return {}; }, () => { order.push("stop-old"); });
  } });
  const runtime = await Runtime.create({ plugins: [first] });
  const session = await runtime.openSession();
  await assert.rejects(runtime.replacePlugin({ ...first, setup(ctx) {
    ctx.resource("exclusive", () => { order.push("start-new"); throw new Error("cannot acquire"); }, () => {});
  } }), code("RESTART_REQUIRED"));
  assert.deepEqual(order, ["start-old", "stop-old", "start-new"]);
  assert.equal(runtime.upgradeHistory().at(-1)!.switched, false);
  assert.equal(runtime.health().restartRequired, true);
  await assert.rejects(session.run(() => {}), code("RESTART_REQUIRED"));
  await runtime.close();
});

test("unconfirmed cleanup is retained and prevents a stop-first candidate from starting", async () => {
  let started = false;
  const runtime = await Runtime.create({ cleanupTimeoutMs: 10, plugins: [plugin("exclusive", { replacementBoundary: "stop-first", setup(ctx) {
    ctx.resource("stubborn", () => ({}), () => new Promise<void>(() => {}));
  } })] });
  const result = await runtime.replacePlugin(plugin("exclusive", { setup(ctx) { ctx.resource("new", () => { started = true; return {}; }, () => {}); } }));
  assert.equal(result.status, "restart-required"); assert.equal(result.switched, false);
  assert.equal(started, false);
  assert(runtime.health().unresolved.some(record => record.name === "stubborn" && record.generation === 1));
  await assert.rejects(runtime.close(), AggregateError);
});

test("drain timeout rolls back the unactivated candidate while old runs and resources remain valid", async () => {
  let acquired = 0;
  const runtime = await Runtime.create({ drainTimeoutMs: 10, plugins: [plugin("provider")] });
  const session = await runtime.openSession();
  const entered = deferred(), release = deferred();
  const running = session.run(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  await assert.rejects(runtime.replacePlugin(plugin("provider", { setup(ctx) {
    ctx.resource("later", () => { acquired++; return {}; }, () => {});
  } })), code("REPLACEMENT_FAILED"));
  assert.equal(acquired, 0); assert.equal(runtime.health().restartRequired, false);
  assert.equal(runtime.upgradeHistory().at(-1)!.status, "failed");
  release.resolve(); await running; await session.run(() => {}); await runtime.close();
});

test("L3-marked host code upgrades return restart-required before candidate setup", async () => {
  let setups = 0;
  const old = plugin("third-party", { upgradePolicy: "restart-required" });
  const runtime = await Runtime.create({ plugins: [old] });
  const result = await runtime.replacePlugin({ ...old, version: "2.0.0", setup() { setups++; } });
  assert.equal(result.status, "restart-required"); assert.equal(result.switched, false); assert.equal(setups, 0);
  assert.equal(runtime.health().restartRequired, false, "old implementation is still healthy");
  await runtime.disablePlugin("third-party");
  const enabled = await runtime.enablePlugin({ ...old, version: "2.0.0", setup() { setups++; } });
  assert.equal(enabled.status, "restart-required"); assert.equal(setups, 0);
  assert.equal((await runtime.enablePlugin("third-party")).status, "switched");
  await runtime.close();
});
