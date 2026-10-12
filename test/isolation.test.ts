import assert from "node:assert/strict";
import test from "node:test";
import {
  Runtime, ServiceScope, createIsolationKey, serviceToken, services, createSessionPlugin, createPermissionPlugin,
  type Plugin, type RunManifest, type ServiceInfo, type IsolationKey, type RunContext, type PermissionService,
} from "../src/index.js";
import { definitions, journalFixture, versions } from "./session-helpers.js";
import { code, deferred, plugin, tick } from "./helpers.js";

const model = serviceToken<{ label: string; next(): number }>("model");
const clock = serviceToken<{ now: number }>("clock");
const root = new ServiceScope();
const scoped = (name: string) => root.isolate(model, createIsolationKey(name));
function provider(label: string, options: Partial<Plugin> = {}): Plugin {
  return plugin("model-provider", { provides: [model], setup(ctx) {
    let count = 0;
    ctx.provide(model, () => ({ label, next: () => ++count }));
  }, ...options });
}

test("multiple mounts keep the same contract while provider caches, consumers and tool callbacks resolve by realm", async t => {
  const a = scoped("a"), b = scoped("b");
  let factories = 0;
  const modelPlugin = provider("unused", { requires: [clock], configMode: "run", validateConfig: value => value ?? "default", setup(ctx) {
    ctx.provide(model, run => { factories++; return { label: String(run.configuration.values[ctx.owner]), next: () => run.services.get(clock).now }; });
  } });
  const reportA = serviceToken<{ first: object; second: object; visible: readonly ServiceInfo[] }>("report-a");
  const reportB = serviceToken<{ first: object; second: object; visible: readonly ServiceInfo[] }>("report-b");
  const consumer = (report: typeof reportA) => plugin("consumer", { provides: [report], requires: [model], setup(ctx) {
    ctx.provide(report, run => ({ first: run.services.get(model), second: run.services.get(model), visible: run.services.list() }));
    ctx.registerTool({ name: ctx.owner, description: "", inputSchema: {}, execute: (_, run) => run.services.get(model).label });
  } });
  const runtime = await Runtime.create({ plugins: [
    a.mount(consumer(reportA), "consumer-a"), b.mount(consumer(reportB), "consumer-b"),
    a.mount(modelPlugin, "provider-a"), b.mount(modelPlugin, "provider-b"),
    plugin("clock", { provides: [clock], setup(ctx) { ctx.provide(clock, () => ({ now: 42 })); } }),
  ], config: { "provider-a": "A", "provider-b": "B" } });
  t.after(() => runtime.close());
  const session = await runtime.openSession();
  let old!: object;
  await session.run(async run => {
    const first = run.services.get(reportA), second = run.services.get(reportB);
    assert.equal(first.first, first.second); assert.notEqual(first.first, second.first);
    assert.equal((first.first as { label: string }).label, "A");
    assert.equal((second.first as { label: string }).label, "B");
    assert.deepEqual(first.visible.map(info => [info.id, info.isolation]), [["model", "a"], ["report-a", null]]);
    assert.throws(() => run.services.get(model), code("MISSING_SERVICE"));
    assert.equal(run.services.list().some(info => info.id === "model"), false);
    assert.equal(await run.tools.invoke("consumer-a", {}), "A");
    assert.equal(await run.tools.invoke("consumer-b", {}), "B");
    old = first.first;
  });
  assert.equal(factories, 2);
  await session.run(run => { const value = run.services.get(model); assert.notEqual(value, old); assert.equal(value.next(), 42); }, a);
  assert.equal(factories, 3);
  assert.deepEqual(runtime.inspect().filter(item => item.kind === "service" && item.name === "model").map(item => [item.owner, item.isolation]), [["provider-a", "a"], ["provider-b", "b"]]);
  await runtime.updateConfig({ "provider-a": "A2" });
  assert.equal(await session.run(run => run.services.get(model).label, a), "A2");
  assert.equal(await session.run(run => run.services.get(model).label, b), "B");
});

test("child scopes inherit selectively; explicit shared keys join scopes and remain service-specific", async t => {
  const key = createIsolationKey("shared"), innerKey = createIsolationKey("inner");
  const parent = root.isolate(model, key).isolate(clock, key);
  const child = parent.isolate(model, innerKey);
  const joined = root.isolate(model, key);
  const runtime = await Runtime.create({ plugins: [
    parent.mount(provider("outer"), "outer"), child.mount(provider("inner"), "inner"),
    parent.mount(plugin("clock", { provides: [clock], setup(ctx) { ctx.provide(clock, () => ({ now: 7 })); } })),
  ] });
  t.after(() => runtime.close());
  const session = await runtime.openSession();
  assert.equal(await session.run(run => run.services.get(model).label, joined), "outer");
  await session.run(run => { assert.equal(run.services.get(model).label, "inner"); assert.equal(run.services.get(clock).now, 7); }, child);
  await session.run(run => assert.equal(run.services.get(model).label, "outer"), parent);
  const empty = child.isolate(clock);
  await session.run(run => assert.throws(() => run.services.get(clock), code("MISSING_SERVICE")), empty);
});

test("isolation validates duplicate slots, missing local providers, versions, lifetime direction and cycles before setup", async () => {
  const a = scoped("a"), b = scoped("b");
  let setups = 0;
  const counted = (p: Plugin): Plugin => ({ ...p, setup() { setups++; } });
  const x = serviceToken<object>("x"), y = serviceToken<object>("y");
  const cases: [string, Plugin[]][] = [
    ["DUPLICATE_SERVICE", [a.mount(provider("one"), "one"), a.mount(provider("two"), "two")]],
    ["DUPLICATE_PLUGIN", [a.mount(provider("one"), "same"), b.mount(provider("two"), "same")]],
    ["MISSING_DEPENDENCY", [provider("global"), a.mount(plugin("consumer", { requires: [model] }))]],
    ["SERVICE_VERSION", [a.mount(provider("one")), a.mount(plugin("consumer", { requires: [serviceToken("model", 2)] }))]],
    ["SCOPE_DEPENDENCY", [a.mount(provider("one", { scope: "session" })), a.mount(plugin("consumer", { requires: [model] }))]],
    ["DEPENDENCY_CYCLE", [a.mount(plugin("same-definition", { provides: [x], requires: [y] }), "x"), a.mount(plugin("same-definition", { provides: [y], requires: [x] }), "y")]],
  ];
  for (const [expected, plugins] of cases) await assert.rejects(Runtime.create({ plugins: plugins.map(counted) }), code(expected));
  assert.equal(setups, 0);
  assert.throws(() => root.isolate(model, { id: "forged" } as IsolationKey), code("INVALID_ISOLATION"));
  const duplicateLabel = scoped("a");
  await assert.rejects(Runtime.create({ plugins: [a.mount(provider("a"), "one"), duplicateLabel.mount(provider("b"), "two")] }), code("ISOLATION_ID_CONFLICT"));
});

test("separate realms may use different interface versions; undeclared access remains rejected", async t => {
  const a = scoped("v1"), b = scoped("v2"), v2 = serviceToken<{ label: string }>("model", 2);
  const result = serviceToken<object>("result");
  const runtime = await Runtime.create({ plugins: [a.mount(provider("v1")), b.mount(plugin("v2", { provides: [v2], setup(ctx) { ctx.provide(v2, () => ({ label: "v2" })); } })),
    a.mount(plugin("undeclared", { provides: [result], setup(ctx) { ctx.provide(result, run => run.services.get(model)); } })),
  ] });
  t.after(() => runtime.close());
  const session = await runtime.openSession();
  await session.run(run => { assert.equal(run.services.get(v2).label, "v2"); assert.throws(() => run.services.get(model), code("SERVICE_VERSION")); }, b);
  await assert.rejects(session.run(run => run.services.get(result)), code("UNDECLARED_DEPENDENCY"));
  await assert.rejects(session.run(() => {}, scoped("v1")), code("ISOLATION_ID_CONFLICT"));
  assert.equal(await session.run(run => run.services.get(model).label, a), "v1", "invalid entry scope does not retain an active run");
});

test("Session resource ownership stays independent from service realms", async t => {
  const a = scoped("a"), b = scoped("b");
  const acquired: string[] = [], disposed: string[] = [];
  const local = provider("session", { scope: "session", setup(ctx) {
    const id = `${ctx.sessionId}/${ctx.owner}`;
    let count = 0;
    const value = ctx.resource("counter", () => { acquired.push(id); return id; }, () => { disposed.push(id); });
    ctx.provide(model, () => ({ label: value.get(), next: () => ++count }));
  } });
  const runtime = await Runtime.create({ plugins: [provider("global"), a.mount(local, "a"), b.mount(local, "b")] });
  t.after(() => runtime.close());
  const first = await runtime.openSession("first"), second = await runtime.openSession("second");
  assert.equal(await first.run(run => run.services.get(model).next(), a), 1);
  assert.equal(await first.run(run => run.services.get(model).next(), a), 2);
  assert.equal(await first.run(run => run.services.get(model).next(), b), 1);
  assert.equal(await second.run(run => run.services.get(model).next(), a), 1);
  assert.equal(await first.run(run => run.services.get(model).label), "global");
  await first.close(); assert.deepEqual(disposed.sort(), ["first/a", "first/b"]);
  assert.equal(await second.run(run => run.services.get(model).next(), a), 2);
  await runtime.close(); assert.deepEqual(acquired.sort(), disposed.sort());
});

test("one mount replacement drains runs, pins bindings and leaves sibling generations and resources intact", async t => {
  const a = scoped("a"), b = scoped("b");
  const disposed: string[] = [];
  const implementation = (label: string) => provider(label, { setup(ctx) {
    ctx.onCleanup(() => { disposed.push(`${ctx.owner}:${label}`); });
    ctx.provide(model, () => ({ label, next: () => 0 }));
  } });
  const runtime = await Runtime.create({ plugins: [a.mount(implementation("a1"), "a"), b.mount(implementation("b1"), "b")] });
  t.after(() => runtime.close());
  const session = await runtime.openSession(), entered = deferred(), release = deferred();
  let old!: RunContext;
  const running = session.run(async run => {
    old = run; assert.equal(run.services.get(model).label, "a1"); entered.resolve(); await release.promise;
    assert.equal(run.services.get(model).label, "a1"); assert.equal(run.manifest.services!.find(s => s.isolation === "a")!.generation, 1);
  }, a);
  await entered.promise;
  const replacing = runtime.replacePlugin(a.mount(implementation("a2"), "a"));
  await tick();
  let admitted = false;
  const next = session.run(run => { admitted = true; return run.services.get(model).label; }, a);
  await tick(); assert.equal(admitted, false); assert.deepEqual(disposed, []);
  release.resolve(); await running; assert.equal((await replacing).status, "switched");
  assert.equal(await next, "a2"); assert.deepEqual(disposed, ["a:a1"]);
  assert.throws(() => old.services.get(model), code("RUN_ENDED"));
  await session.run(run => {
    assert.equal(run.services.get(model).label, "b1");
    assert.equal(run.manifest.plugins.find(p => p.id === "a")!.generation, 2);
    assert.equal(run.manifest.plugins.find(p => p.id === "b")!.generation, 1);
  }, b);
  await runtime.disablePlugin("a");
  assert.equal(await session.run(run => run.services.get(model).label, b), "b1");
  const enabled = await runtime.enablePlugin("a"); assert.equal(enabled.generation, 4);
  assert.equal(await session.run(run => run.services.get(model).label, a), "a2");
});

test("failed candidate rolls back only its registrations and resolves the old provider afterwards", async t => {
  const a = scoped("a"), b = scoped("b"), target = new EventTarget();
  let notifications = 0, cleanups = 0;
  const runtime = await Runtime.create({ plugins: [a.mount(provider("old"), "a"), b.mount(provider("sibling"), "b")] });
  t.after(() => runtime.close());
  const session = await runtime.openSession();
  await assert.rejects(runtime.replacePlugin(a.mount(provider("broken", { setup(ctx) {
    ctx.provide(model, () => ({ label: "broken", next: () => 0 }));
    ctx.listen(target, "test", () => { notifications++; });
    ctx.onCleanup(() => { cleanups++; });
    ctx.resource("fails", () => { throw new Error("activation failed"); }, () => {});
  } }), "a")), code("REPLACEMENT_FAILED"));
  target.dispatchEvent(new Event("test"));
  assert.equal(notifications, 0); assert.equal(cleanups, 1); assert.equal(runtime.health().restartRequired, false);
  assert.equal(await session.run(run => run.services.get(model).label, a), "old");
  assert.equal(await session.run(run => run.services.get(model).label, b), "sibling");
});

test("service bindings persist without symbols and replay verifies provider ownership, versions and isolation", async t => {
  const fixture = await journalFixture(t), a = scoped("a"), b = scoped("b");
  const runtime = await Runtime.create({ plugins: [a.mount(provider("a"), "a"), b.mount(provider("b"), "b"), createSessionPlugin({ directory: fixture.directory })] });
  t.after(() => runtime.close());
  const session = await runtime.openSession("session");
  const manifest = await session.run(async run => {
    const log = run.services.get(services.session);
    await log.retain(definitions); await log.start(versions, {});
    await log.record([{ callId: "request", data: { type: "model.requested", request: { model: run.services.get(model).label } } },
      { callId: "request", data: { type: "model.completed", response: {}, text: "done" } }, { data: { type: "run.finished", status: "completed" } }]);
    assert.equal(run.manifest.plugins.find(p => p.id === "a")!.definitionId, "model-provider");
    return log.reconstructRequest("request").manifest!;
  }, a);
  assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);
  assert.ok(manifest.bindings!.some(binding => binding.consumer === null && binding.id === "model" && binding.isolation === "a"));
  await runtime.close();
  const restored = await Runtime.create({ plugins: [createSessionPlugin({ directory: fixture.directory })] });
  t.after(() => restored.close());
  const reopened = await restored.openSession("session");
  assert.deepEqual(await reopened.run(run => run.services.get(services.session).reconstructRequest("request").manifest), manifest);
  await restored.close();

  const { log } = await fixture.open();
  await log.forRun("retain").retain(definitions);
  const mutators = [
    (m: any) => { m.services[0].generation++; },
    (m: any) => { m.services.push(m.services[0]); },
    (m: any) => { m.services[0].isolation = "unbound"; },
    (m: any) => { m.services[0].sessionId = "another"; },
    (m: any) => { m.bindings[0].consumer = "missing"; },
    (m: any) => { m.bindings[0].version++; },
    (m: any) => { delete m.bindings; },
    (m: any) => { m.services[0] = null; },
    (m: any) => { m.bindings[0] = null; },
  ];
  for (const [index, mutate] of mutators.entries()) {
    const invalid = structuredClone(manifest); mutate(invalid);
    await assert.rejects(log.forRun(`invalid-${index}`, invalid).start(versions, {}), code("INVALID_EVENT"));
  }
  const { services: ignoredServices, bindings: ignoredBindings, ...legacy } = manifest;
  void ignoredServices; void ignoredBindings;
  const oldManifest: RunManifest = { ...legacy, plugins: legacy.plugins.map(({ definitionId: ignored, ...p }) => { void ignored; return p; }) };
  await log.forRun("legacy", oldManifest).start(versions, {});
});

test("built-in permission mounts use their own configuration and never accept another authority's approval", async t => {
  const a = root.isolate(services.permission, createIsolationKey("permission-a"));
  const b = root.isolate(services.permission, createIsolationKey("permission-b"));
  const viewA = serviceToken<PermissionService>("view-a"), viewB = serviceToken<PermissionService>("view-b");
  const view = (token: typeof viewA) => plugin("view", { provides: [token], requires: [services.permission], setup(ctx) {
    ctx.provide(token, run => run.services.get(services.permission));
  } });
  const runtime = await Runtime.create({ plugins: [a.mount(createPermissionPlugin(), "policy-a"), b.mount(createPermissionPlugin(), "policy-b"),
    a.mount(view(viewA), "view-a"), b.mount(view(viewB), "view-b"),
    plugin("tools", { setup(ctx) { ctx.registerTool({ name: "write", description: "", inputSchema: {}, execute: () => "ok" }); } }),
  ], config: { "policy-a": { workspace: "/a", policyVersion: "a", ttlMs: 60000 }, "policy-b": { workspace: "/b", policyVersion: "b", ttlMs: 60000 } } });
  t.after(() => runtime.close());
  const session = await runtime.openSession();
  await session.run(run => {
    const firstPermission = run.services.get(viewA), secondPermission = run.services.get(viewB);
    const first = firstPermission.request("call", "write", {}), second = secondPermission.request("call", "write", {});
    assert.equal(first.binding.workspace, "/a");
    assert.equal(second.binding.workspace, "/b");
    assert.throws(() => secondPermission.reply({ binding: first.binding, decision: "allow" }), code("APPROVAL_REVOKED"));
    assert.doesNotThrow(() => firstPermission.reply({ binding: first.binding, decision: "allow" }));
  });
});
