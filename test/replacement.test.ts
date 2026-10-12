import assert from "node:assert/strict";
import test from "node:test";
import { Runtime, serviceToken, type Plugin, type PluginContext } from "../src/index.js";
import { code, deferred, plugin, tick } from "./helpers.js";

const value = serviceToken<{ read(): string }>("value");
const consumer = serviceToken<{ read(): string }>("consumer");
const provider = (label: string, overrides: Partial<Plugin> = {}) => plugin("provider", {
  provides: [value], setup(ctx) { ctx.provide(value, () => ({ read: () => label })); }, ...overrides,
});

test("replacement waits for all runs, blocks admission, and refreshes consumers", async () => {
  let setups = 0, oldDisposals = 0, consumerSetups = 0;
  const runtime = await Runtime.create({ plugins: [
    provider("old", { setup(ctx) {
      ctx.provide(value, () => ({ read: () => "old" }));
      ctx.onCleanup(() => { oldDisposals++; });
    } }),
    plugin("consumer", { scope: "session", provides: [consumer], requires: [value], setup(ctx) {
      consumerSetups++;
      ctx.provide(consumer, run => {
        const provider = run.services.get(value);
        return { read: () => provider.read() };
      });
    } }),
  ] });
  const s1 = await runtime.openSession("s1"), s2 = await runtime.openSession("s2");
  const started1 = deferred(), started2 = deferred(), end1 = deferred(), end2 = deferred();
  const run1 = s1.run(async run => {
    const service = run.services.get(consumer);
    const generation = run.services.list().find(item => item.id === value.id)!.generation;
    assert.equal(service.read(), "old");
    started1.resolve(); await end1.promise;
    assert.equal(service.read(), "old");
    assert.equal(generation, 1);
  });
  const run2 = s2.run(async run => {
    started2.resolve(); await end2.promise;
    assert.equal(run.services.get(value).read(), "old");
  });
  await Promise.all([started1.promise, started2.promise]);
  const replacing = runtime.replacePlugin(provider("new", { setup(ctx) {
    setups++; ctx.provide(value, () => ({ read: () => "new" }));
  } }));
  await tick();
  let admitted = false;
  const nextRun = s1.run(run => { admitted = true; return run.services.get(consumer).read(); });
  await tick();
  assert.equal(setups, 1); assert.equal(admitted, false); assert.equal(oldDisposals, 0);
  end1.resolve(); await run1; await tick();
  assert.equal(setups, 1);
  end2.resolve(); await run2;
  const replaced = await replacing;
  assert.equal(replaced.generation, 2);
  assert.equal(replaced.status, "switched");
  assert.deepEqual(replaced.cleanupErrors, []);
  assert.equal(await nextRun, "new");
  assert.equal(oldDisposals, 1);
  assert.equal(consumerSetups, 2, "session setup does not rerun or lose state");
  await runtime.close();
});

test("failed replacement preserves old services/tools/listeners and generations are not reused", async () => {
  const events = new EventTarget();
  const log: string[] = [];
  const runtime = await Runtime.create({ plugins: [provider("old", { setup(ctx) {
    ctx.provide(value, () => ({ read: () => "old" }));
    ctx.registerTool({ name: "old", description: "", inputSchema: {}, execute: () => "old" });
    ctx.listen(events, "ping", () => { log.push("old"); });
  } })] });
  const session = await runtime.openSession();
  await assert.rejects(runtime.replacePlugin(provider("broken", { setup(ctx) {
    ctx.provide(value, () => ({ read: () => "broken" }));
    ctx.registerTool({ name: "broken", description: "", inputSchema: {}, execute: () => null });
    ctx.listen(events, "ping", () => { log.push("broken"); });
    ctx.onCleanup(() => { log.push("rollback"); });
    throw new Error("boom");
  } })), code("REPLACEMENT_FAILED"));
  events.dispatchEvent(new Event("ping"));
  assert.deepEqual(log, ["rollback", "old"]);
  await session.run(async run => {
    assert.equal(run.services.get(value).read(), "old");
    assert.equal(run.services.list()[0]!.generation, 1);
    assert.deepEqual(run.tools.list().map(tool => tool.name), ["old"]);
    assert.equal(await run.tools.invoke("old", {}), "old");
  });
  const result = await runtime.replacePlugin(provider("new"));
  assert.equal(result.generation, 3);
  events.dispatchEvent(new Event("ping"));
  assert.deepEqual(log, ["rollback", "old"]);
  await runtime.close();
});

test("session replacement commits all existing sessions atomically or rolls them all back", async () => {
  const cleanup: string[] = [];
  const runtime = await Runtime.create({ plugins: [provider("old", { scope: "session" })] });
  const first = await runtime.openSession("first"), second = await runtime.openSession("second");
  await assert.rejects(runtime.replacePlugin(provider("broken", { scope: "session", setup(ctx) {
    ctx.provide(value, () => ({ read: () => "broken" }));
    ctx.onCleanup(() => { cleanup.push(ctx.sessionId!); });
    if (ctx.sessionId === "second") throw new Error("second failed");
  } })), code("REPLACEMENT_FAILED"));
  assert.deepEqual(cleanup, ["second", "first"]);
  for (const session of [first, second]) {
    assert.equal(await session.run(run => run.services.get(value).read()), "old");
  }
  await runtime.replacePlugin(provider("new", { scope: "session" }));
  const third = await runtime.openSession("third");
  for (const session of [first, second, third]) {
    await session.run(run => {
      assert.equal(run.services.get(value).read(), "new");
      assert.equal(run.services.list()[0]!.generation, 3);
      assert.equal(run.services.list()[0]!.sessionId, session.id);
    });
  }
  await runtime.close();
});

test("incompatible replacement is rejected before setup and does not poison lifecycle queue", async () => {
  let setups = 0;
  const runtime = await Runtime.create({ plugins: [provider("old"), plugin("consumer", { requires: [value] })] });
  const session = await runtime.openSession();
  await assert.rejects(runtime.replacePlugin(provider("bad", { provides: [serviceToken("value", 2)], setup() { setups++; } })), code("SERVICE_VERSION"));
  assert.equal(setups, 0);
  assert.equal(await session.run(run => run.services.get(value).read()), "old");
  await assert.rejects(runtime.replacePlugin(provider("bad", { scope: "session" })), code("SCOPE_CHANGE"));
  await runtime.replacePlugin(provider("new"));
  assert.equal(await session.run(run => run.services.get(value).read()), "new");
  await runtime.close();
});

test("runtime replacement checks tool collisions against existing session registries", async () => {
  const runtime = await Runtime.create({ plugins: [provider("old"), plugin("session", { scope: "session", setup(ctx) {
    ctx.registerTool({ name: "session-tool", description: "", inputSchema: {}, execute: () => "session" });
  } })] });
  const session = await runtime.openSession();
  await assert.rejects(runtime.replacePlugin(provider("new", { setup(ctx) {
    ctx.provide(value, () => ({ read: () => "new" }));
    ctx.registerTool({ name: "session-tool", description: "", inputSchema: {}, execute: () => "runtime" });
  } })), code("REPLACEMENT_FAILED"));
  assert.equal(await session.run(run => run.tools.invoke("session-tool", {})), "session");
  assert.equal(await session.run(run => run.services.get(value).read()), "old");
  await runtime.close();
});

test("retirement cleanup errors are reported after the new generation is committed", async () => {
  const runtime = await Runtime.create({ plugins: [provider("old", { setup(ctx) {
    ctx.provide(value, () => ({ read: () => "old" }));
    ctx.onCleanup(() => { throw new Error("old cleanup failed"); });
  } })] });
  const session = await runtime.openSession();
  const result = await runtime.replacePlugin(provider("new"));
  assert.equal(result.generation, 2);
  assert.equal(result.cleanupErrors.length, 1);
  assert.equal(result.status, "restart-required");
  assert.equal(result.switched, true);
  assert(runtime.health().unresolved.length > 0);
  await assert.rejects(session.run(run => run.services.get(value).read()), code("RESTART_REQUIRED"));
  assert(runtime.inspect().every(item => item.generation === 2));
  await assert.rejects(runtime.close(), AggregateError);
});

test("queued replacements serialize and shutdown waits for their cleanup", async () => {
  const cleaned: string[] = [];
  const tracked = (label: string) => provider(label, { setup(ctx) {
    ctx.provide(value, () => ({ read: () => label }));
    ctx.onCleanup(() => { cleaned.push(label); });
  } });
  const runtime = await Runtime.create({ plugins: [tracked("one")] });
  const p2 = runtime.replacePlugin(tracked("two"));
  const p3 = runtime.replacePlugin(tracked("three"));
  const closing = runtime.close();
  assert.equal((await p2).generation, 2);
  assert.equal((await p3).generation, 3);
  await closing;
  assert.deepEqual(cleaned, ["one", "two", "three"]);
});

test("queued replacement captures descriptor and configuration at submission", async () => {
  const runtime = await Runtime.create({ plugins: [provider("old")] });
  const session = await runtime.openSession();
  const started = deferred(), release = deferred();
  const running = session.run(async () => { started.resolve(); await release.promise; });
  await started.promise;
  const config = { text: "captured" };
  const replacement = { ...provider("new"), setup(ctx: PluginContext) {
    ctx.provide(value, () => ({ read: () => (ctx.config as { text: string }).text }));
  } };
  const replacing = runtime.replacePlugin(replacement, config);
  config.text = "mutated";
  replacement.setup = () => { throw new Error("mutated setup"); };
  release.resolve();
  await running;
  await replacing;
  assert.equal(await session.run(run => run.services.get(value).read()), "captured");
  await runtime.close();
});

test("listener activation failure rolls back partially attached candidate listeners", async () => {
  class BrokenTarget extends EventTarget {
    override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
      super.addEventListener(...args);
      throw new Error("activation failed after attach");
    }
  }
  const target = new BrokenTarget();
  let fired = 0, disposed = 0;
  const runtime = await Runtime.create({ plugins: [provider("old")] });
  const session = await runtime.openSession();
  await assert.rejects(runtime.replacePlugin(provider("new", { setup(ctx) {
    ctx.provide(value, () => ({ read: () => "new" }));
    ctx.listen(target, "ping", () => { fired++; });
    ctx.onCleanup(() => { disposed++; });
  } })), code("REPLACEMENT_FAILED"));
  target.dispatchEvent(new Event("ping"));
  assert.equal(fired, 0);
  assert.equal(disposed, 1);
  assert.equal(await session.run(run => run.services.get(value).read()), "old");
  await runtime.close();
});
