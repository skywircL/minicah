import assert from "node:assert/strict";
import test from "node:test";
import { Runtime, definePlugin, serviceToken, type Plugin, type PluginContext } from "../src/index.js";
import { code, plugin } from "./helpers.js";

const a = serviceToken<{ value: string }>("a");
const b = serviceToken<{ value: string }>("b");

test("preflight rejects invalid graphs before any setup", async t => {
  const cases: [string, Plugin[]][] = [
    ["DUPLICATE_PLUGIN", [plugin("x"), plugin("x")]],
    ["DUPLICATE_SERVICE", [plugin("x", { provides: [a] }), plugin("y", { provides: [a] })]],
    ["MISSING_DEPENDENCY", [plugin("x", { requires: [a] })]],
    ["DEPENDENCY_CYCLE", [plugin("x", { provides: [a], requires: [b] }), plugin("y", { provides: [b], requires: [a] })]],
    ["DEPENDENCY_CYCLE", [plugin("x", { provides: [a], requires: [a] })]],
    ["SERVICE_VERSION", [plugin("x", { provides: [a] }), plugin("y", { requires: [serviceToken("a", 2)] })]],
    ["API_VERSION", [plugin("x", { apiVersion: 2 })]],
    ["SCOPE_DEPENDENCY", [plugin("x", { scope: "session", provides: [a] }), plugin("y", { requires: [a] })]],
    ["INVALID_DESCRIPTOR", [plugin("x", { version: "latest" })]],
  ];
  for (const [expected, plugins] of cases) await t.test(expected, async () => {
    let setups = 0;
    await assert.rejects(Runtime.create({ plugins: plugins.map(item => ({ ...item, setup() { setups++; } })) }), code(expected));
    assert.equal(setups, 0);
  });
});

test("configuration of every scope is validated before loading", async () => {
  let setups = 0;
  const configured = definePlugin({
    ...plugin("configured", { scope: "session" }),
    validateConfig(input) {
      if (typeof input !== "number" || input < 1) throw new Error("positive number required");
      return input;
    },
    setup(ctx) { assert.equal(typeof ctx.config, "number"); setups++; },
  });
  await assert.rejects(Runtime.create({ plugins: [plugin("first", { setup() { setups++; } }), configured] }), code("INVALID_CONFIG"));
  assert.equal(setups, 0);
  await assert.rejects(Runtime.create({ plugins: [], config: { typo: true } }), code("INVALID_CONFIG"));
  const runtime = await Runtime.create({ plugins: [configured], config: { configured: 2 } });
  await runtime.openSession();
  assert.equal(setups, 1);
  await runtime.close();
});

test("setup follows dependencies and shutdown reverses topology and ownership", async () => {
  const log: string[] = [];
  const provider = plugin("provider", { provides: [a], setup(ctx) {
    log.push("provider+"); ctx.provide(a, () => ({ value: "a" }));
    ctx.onCleanup(() => { log.push("provider-"); });
    ctx.manage("resource", () => { log.push("resource-"); });
  } });
  const consumer = plugin("consumer", { provides: [b], requires: [a], setup(ctx) {
    log.push("consumer+"); ctx.provide(b, run => run.services.get(a));
    ctx.onCleanup(() => { log.push("consumer-"); });
  } });
  const sessionPlugin = plugin("session", { scope: "session", requires: [b], setup(ctx) {
    log.push(`${ctx.sessionId}+`); ctx.onCleanup(() => { log.push(`${ctx.sessionId}-`); });
  } });
  const runtime = await Runtime.create({ plugins: [sessionPlugin, consumer, provider] });
  await runtime.openSession("s1");
  await runtime.openSession("s2");
  await runtime.close();
  assert.deepEqual(log, ["provider+", "consumer+", "s1+", "s2+", "s2-", "s1-", "consumer-", "resource-", "provider-"]);
  assert.deepEqual(runtime.inspect(), []);
  await runtime.close();
});

test("failed runtime initialization revokes all managed registrations", async () => {
  const events = new EventTarget();
  const log: string[] = [];
  let leaked: PluginContext | undefined;
  const provider = plugin("provider", { provides: [a], setup(ctx) {
    ctx.provide(a, () => ({ value: "a" }));
    ctx.onCleanup(() => { log.push("provider-"); });
  } });
  const broken = plugin("broken", { requires: [a], setup(ctx) {
    leaked = ctx;
    ctx.listen(events, "ping", () => { log.push("ping"); });
    ctx.registerTool({ name: "temporary", description: "", inputSchema: {}, execute: () => null });
    ctx.onCleanup(() => { log.push("broken-"); });
    ctx.manage({}, () => { log.push("resource-"); });
    throw new Error("setup failed");
  } });
  await assert.rejects(Runtime.create({ plugins: [broken, provider] }), code("SETUP_FAILED"));
  events.dispatchEvent(new Event("ping"));
  assert.deepEqual(log, ["resource-", "broken-", "provider-"]);
  assert.throws(() => leaked!.onCleanup(() => {}), code("REGISTRATION_CLOSED"));
});

test("a failed session can be retried without affecting runtime or other sessions", async () => {
  let shouldFail = false;
  let cleaned = 0;
  const runtime = await Runtime.create({ plugins: [plugin("sessions", { scope: "session", setup(ctx) {
    ctx.onCleanup(() => { cleaned++; });
    ctx.registerTool({ name: "tool", description: "", inputSchema: {}, execute: () => ctx.sessionId });
    if (shouldFail) throw new Error("session setup failed");
  } })] });
  const s1 = await runtime.openSession("s1");
  shouldFail = true;
  await assert.rejects(runtime.openSession("s2"), code("SETUP_FAILED"));
  assert.equal(cleaned, 1);
  assert.equal(await s1.run(run => run.tools.invoke("tool", {})), "s1");
  shouldFail = false;
  const s2 = await runtime.openSession("s2");
  assert.equal(await s2.run(run => run.tools.invoke("tool", {})), "s2");
  await s1.close();
  assert.equal(await s2.run(run => run.tools.invoke("tool", {})), "s2");
  await runtime.close();
  assert.equal(cleaned, 3);
});

test("cleanup failures are aggregated while all other resources still close", async () => {
  const log: string[] = [];
  const runtime = await Runtime.create({ plugins: [plugin("cleanup", { setup(ctx) {
    ctx.onCleanup(() => { log.push("first"); });
    ctx.onCleanup(() => { log.push("second"); throw new Error("cleanup failed"); });
    ctx.onCleanup(() => { log.push("third"); });
  } })] });
  await assert.rejects(runtime.close(), AggregateError);
  assert.deepEqual(log, ["third", "second", "first"]);
  assert.deepEqual(runtime.inspect(), []);
  await assert.rejects(runtime.close(), AggregateError);
  assert.equal(log.length, 3);
});

test("service declarations and tool uniqueness are enforced during setup", async t => {
  await t.test("missing provision", async () => {
    await assert.rejects(Runtime.create({ plugins: [plugin("missing", { provides: [a] })] }), code("SETUP_FAILED"));
  });
  await t.test("undeclared service", async () => {
    await assert.rejects(Runtime.create({ plugins: [plugin("extra", { setup(ctx) { ctx.provide(a, () => ({ value: "a" })); } })] }), code("SETUP_FAILED"));
  });
  const toolPlugin = (id: string, scope: "runtime" | "session") => plugin(id, { scope, setup(ctx) {
    ctx.registerTool({ name: "same", description: "", inputSchema: {}, execute: () => id });
  } });
  await t.test("duplicate runtime tools", async () => {
    await assert.rejects(Runtime.create({ plugins: [toolPlugin("one", "runtime"), toolPlugin("two", "runtime")] }), code("SETUP_FAILED"));
  });
  await t.test("session tool cannot shadow runtime", async () => {
    const runtime = await Runtime.create({ plugins: [toolPlugin("one", "runtime"), toolPlugin("two", "session")] });
    await assert.rejects(runtime.openSession(), code("SETUP_FAILED"));
    assert.equal(runtime.inspect().filter(item => item.kind === "tool").length, 1);
    await runtime.close();
  });
});

test("listeners retain separate ownership even when callbacks are identical", async () => {
  const target = new EventTarget();
  let count = 0;
  const listener = () => { count++; };
  const runtime = await Runtime.create({ plugins: [plugin("listener", { scope: "session", setup(ctx) {
    ctx.listen(target, "ping", listener);
  } })] });
  const first = await runtime.openSession("first");
  await runtime.openSession("second");
  target.dispatchEvent(new Event("ping"));
  assert.equal(count, 2);
  await first.close();
  target.dispatchEvent(new Event("ping"));
  assert.equal(count, 3);
  await runtime.close();
  target.dispatchEvent(new Event("ping"));
  assert.equal(count, 3);
});

test("plugin ids do not read inherited config properties", async () => {
  const runtime = await Runtime.create({ plugins: [plugin("constructor", { setup(ctx) {
    assert.equal(ctx.config, undefined);
  } })] });
  await runtime.close();
});
