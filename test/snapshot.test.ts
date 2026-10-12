import assert from "node:assert/strict";
import test from "node:test";
import { Runtime, serviceToken, type RunContext } from "../src/index.js";
import { code, deferred, plugin, tick } from "./helpers.js";

const counter = serviceToken<{ next(): number }>("counter");

test("service factories are cached per run and session state stays isolated", async () => {
  let factories = 0;
  const runtime = await Runtime.create({ plugins: [plugin("counter", { scope: "session", provides: [counter], setup(ctx) {
    let count = 0;
    ctx.provide(counter, () => { factories++; return { next: () => ++count }; });
  } })] });
  const s1 = await runtime.openSession("s1");
  const s2 = await runtime.openSession("s2");
  let previous: unknown;
  await s1.run(run => {
    previous = run.services.get(counter);
    assert.equal(previous, run.services.get(counter));
    assert.equal(run.services.get(counter).next(), 1);
  });
  await s1.run(run => {
    assert.notEqual(previous, run.services.get(counter));
    assert.equal(run.services.get(counter).next(), 2);
  });
  assert.equal(await s2.run(run => run.services.get(counter).next()), 1);
  assert.equal(factories, 3);
  await runtime.close();
});

test("snapshot metadata, input schemas, and config are copied and frozen", async () => {
  const schema = { nested: { type: "string" } };
  const config = { value: { answer: 42 } };
  const runtime = await Runtime.create({ plugins: [plugin("value", { setup(ctx) {
    assert(Object.isFrozen(ctx.config));
    ctx.registerTool({ name: "value", description: "value", inputSchema: schema, execute: () => ctx.config });
    ctx.onCleanup(() => {});
    ctx.manage({}, () => {});
    ctx.listen(new EventTarget(), "change", () => {});
  } })], config });
  config.value.answer = 0;
  schema.nested.type = "number";
  const session = await runtime.openSession();
  let saved!: RunContext;
  await session.run(async run => {
    saved = run;
    assert(Object.isFrozen(run));
    assert(Object.isFrozen(run.tools));
    assert(Object.isFrozen(run.tools.list()));
    assert(Object.isFrozen(run.tools.list()[0]));
    assert.deepEqual(run.tools.list()[0]!.inputSchema, { nested: { type: "string" } });
    assert.deepEqual(await run.tools.invoke("value", {}), { answer: 42 });
  });
  assert.throws(() => saved.services.list(), code("RUN_ENDED"));
  await assert.rejects(saved.tools.invoke("value", {}), code("RUN_ENDED"));
  for (const record of runtime.inspect()) {
    assert.equal(record.owner, "value");
    assert.equal(record.generation, 1);
    assert.equal(record.scope, "runtime");
    assert.equal(record.sessionId, undefined);
  }
  await runtime.close();
});

test("plugin factories and tool handlers may resolve only declared services", async () => {
  const hidden = serviceToken<{ secret: number }>("hidden");
  const consumer = serviceToken<object>("consumer");
  const runtime = await Runtime.create({ plugins: [
    plugin("hidden", { provides: [hidden], setup(ctx) { ctx.provide(hidden, () => ({ secret: 42 })); } }),
    plugin("consumer", { provides: [consumer], setup(ctx) {
      ctx.provide(consumer, run => run.services.get(hidden));
      ctx.registerTool({ name: "hidden", description: "", inputSchema: {}, execute: (_, run) => run.services.get(hidden) });
    } }),
  ] });
  const session = await runtime.openSession();
  await session.run(async run => {
    assert.throws(() => run.services.get(consumer), code("UNDECLARED_DEPENDENCY"));
    await assert.rejects(run.tools.invoke("hidden", {}), code("UNDECLARED_DEPENDENCY"));
    assert.equal(run.services.get(hidden).secret, 42);
    assert.throws(() => run.services.get(serviceToken("hidden", 2)), code("SERVICE_VERSION"));
  });
  await runtime.close();
});

test("same-plugin factory cycles fail without trapping the runtime", async () => {
  const a = serviceToken<object>("a"), b = serviceToken<object>("b");
  const runtime = await Runtime.create({ plugins: [plugin("cycle", { provides: [a, b], setup(ctx) {
    ctx.provide(a, run => run.services.get(b));
    ctx.provide(b, run => run.services.get(a));
  } })] });
  const session = await runtime.openSession();
  await assert.rejects(session.run(run => run.services.get(a)), code("SERVICE_CYCLE"));
  await runtime.close();
});

test("run failure releases lifecycle barrier and nested lifecycle operations are rejected", async () => {
  const runtime = await Runtime.create({ plugins: [] });
  const session = await runtime.openSession();
  await assert.rejects(session.run(async () => {
    assert.throws(() => runtime.close(), code("REENTRANT_LIFECYCLE"));
    assert.throws(() => session.close(), code("REENTRANT_LIFECYCLE"));
    assert.throws(() => runtime.openSession(), code("REENTRANT_LIFECYCLE"));
    await assert.rejects(session.run(() => {}), code("REENTRANT_LIFECYCLE"));
    throw new Error("run failed");
  }), /run failed/);
  await runtime.close();
});

test("shutdown and replacement wait for in-flight tools even if the callback returns early", async () => {
  const started = deferred(), release = deferred();
  let disposed = false;
  const runtime = await Runtime.create({ plugins: [plugin("tool", { setup(ctx) {
    ctx.onCleanup(() => { disposed = true; });
    ctx.registerTool({ name: "slow", description: "", inputSchema: {}, async execute() {
      started.resolve(); await release.promise; assert.equal(disposed, false); return "done";
    } });
  } })] });
  const session = await runtime.openSession();
  const running = session.run(run => { void run.tools.invoke("slow", {}); });
  await started.promise;
  const closing = runtime.close();
  await tick();
  assert.equal(disposed, false);
  release.resolve();
  await running;
  await closing;
  assert.equal(disposed, true);
  await assert.rejects(session.run(() => {}), code("RUNTIME_CLOSED"));
});
