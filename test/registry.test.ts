import assert from "node:assert/strict";
import test from "node:test";
import {
  Runtime, RegistryScope, NamedEntries, AnonymousEntries, ScopedLayers, registryToken,
  ServiceScope, createIsolationKey, serviceToken, createCliCommandsPlugin, cliCommandService, commandRegistry,
  createSkillRegistryPlugin, skillRegistry, skillRegistryService, createSessionPlugin, createToolPipelinePlugin,
  services, PtcRuntime, reference,
  type Plugin, type RunContext, type RunManifest, type ToolDefinition,
} from "../src/index.js";
import { code, deferred, plugin, tick } from "./helpers.js";
import { definitions, versions, journalFixture } from "./session-helpers.js";

class Layer {
  readonly named = new NamedEntries<string>();
  readonly anonymous = new AnonymousEntries<string>();
  isEmpty(): boolean { return this.named.isEmpty() && this.anonymous.isEmpty(); }
}
const tool = (name: string, value: string): ToolDefinition => ({ name, description: value, effect: "read", inputSchema: { type: "string", const: value }, execute: () => value });
const provider = (id: string, value: string, extra: Partial<Plugin> = {}) => plugin(id, { setup(ctx) { ctx.registerTool(tool("read", value)); }, ...extra });

test("ScopedLayers inherits only ancestors, shadows by name, and reclaims aggregate layers after cleanup", () => {
  let created = 0;
  const layers = new ScopedLayers(() => { created++; return new Layer(); });
  const parent = new RegistryScope("preset"), child = parent.child("agent"), sibling = parent.child("sibling");
  const cleanup: (() => void)[] = [];
  const ctx = (registryScope?: RegistryScope) => ({ registryScope, onCleanup: (fn: () => void) => { cleanup.push(fn); } });
  assert.equal(layers.peek(child), undefined); assert.deepEqual(layers.chainLayers(child), []); assert.equal(created, 1);
  layers.effect(ctx(), layer => layer.named.insert("read", "global"));
  layers.effect(ctx(parent), layer => layer.named.insert("read", "parent"));
  const remove = layers.effect(ctx(child), layer => layer.named.insert("read", "child"));
  const removeAnonymous = layers.effect(ctx(child), layer => layer.anonymous.append("guard"));
  assert.equal(layers.merge(child, layer => layer.named).get("read"), "child");
  assert.equal(layers.merge(sibling, layer => layer.named).get("read"), "parent");
  assert.equal(layers.merge(undefined, layer => layer.named).get("read"), "global");
  assert.throws(() => layers.effect(ctx(child), layer => layer.named.insert("read", "duplicate")), /Duplicate/);
  remove(); assert.ok(layers.peek(child));
  assert.equal(layers.merge(child, layer => layer.named).get("read"), "parent");
  removeAnonymous(); assert.equal(layers.peek(child), undefined);
  layers.effect(ctx(child), layer => layer.named.insert("read", "new"));
  remove(); assert.equal(layers.peek(child)!.named.get("read"), "new", "stale disposer cannot remove a later registration");
  for (const fn of cleanup.toReversed()) fn();
  assert.equal(layers.peek(parent), undefined); assert.equal(layers.peek(child), undefined); assert.ok(layers.global.isEmpty());
});

test("ScopedLayers rolls back failed registration and notification without deleting surviving contributions", () => {
  const scope = new RegistryScope(), callbacks: (() => void)[] = [];
  const ctx = { registryScope: scope, onCleanup(fn: () => void) { callbacks.push(fn); } };
  let throwing = true;
  const layers = new ScopedLayers(() => new Layer(), () => { if (throwing) throw new Error("notify"); });
  assert.throws(() => layers.effect(ctx, layer => layer.named.insert("name", "failed")), /notify/);
  assert.equal(layers.peek(scope), undefined);
  throwing = false;
  layers.effect(ctx, layer => layer.named.insert("name", "ok"));
  assert.throws(() => layers.effect(ctx, () => { throw new Error("action"); }), /action/);
  callbacks[0]!(); assert.equal(layers.peek(scope)!.named.get("name"), "ok");
  callbacks[1]!(); assert.equal(layers.peek(scope), undefined);
  const anonymous = new AnonymousEntries<string>(), a = anonymous.append("same"), b = anonymous.append("same");
  a(); a(); assert.deepEqual([...anonymous.values()], ["same"]); b(); assert.ok(anonymous.isEmpty());
});

test("tools share a pinned caller view across services and handlers, with parent inheritance and sibling isolation", async t => {
  const preset = new RegistryScope("preset"), child = preset.child("child"), sibling = preset.child("sibling");
  const catalog = serviceToken<{ names(): string[] }>("catalog");
  const runtime = await Runtime.create({ plugins: [provider("global", "global"), preset.mount(provider("preset", "preset")), child.mount(provider("child", "child")),
    sibling.mount(plugin("sibling", { setup(ctx) { ctx.registerTool(tool("secret", "secret")); } })),
    plugin("adapter", { provides: [catalog], setup(ctx) {
      ctx.provide(catalog, run => ({ names: () => run.tools.list().map(t => t.name) }));
      ctx.registerTool({ name: "delegate", description: "", inputSchema: {}, execute: (_, run) => run.tools.invoke("read", "child") });
    } }),
  ] });
  t.after(() => runtime.close());
  const session = await runtime.openSession();
  assert.equal(await session.run(run => run.tools.invoke("read", "global")), "global");
  assert.equal(await session.run(run => run.tools.invoke("read", "preset"), { registryScope: preset }), "preset");
  let saved!: RunContext;
  await session.run(async run => {
    saved = run;
    assert.equal(run.registryScope, child);
    assert.deepEqual(run.services.get(catalog).names().sort(), ["delegate", "read"]);
    assert.equal(run.tools.list().find(t => t.name === "read")!.description, "child");
    assert.equal(await run.tools.invoke("delegate", {}), "child");
    await assert.rejects(run.tools.invoke("secret", "secret"), code("MISSING_TOOL"));
    assert.deepEqual(run.manifest.registryView!.chain, ["preset", "child"]);
    assert.equal(run.manifest.tools.find(t => t.name === "read")!.registryScope, "child");
  }, { registryScope: child });
  assert.throws(() => saved.registries.get(skillRegistry), code("RUN_ENDED"));
});

test("registry scopes compose with service isolation without rebinding a handler's declared dependencies", async t => {
  const scope = new RegistryScope("agent"), token = serviceToken<string>("model");
  const realm = new ServiceScope().isolate(token, createIsolationKey("private"));
  const runtime = await Runtime.create({ plugins: [
    plugin("global-model", { provides: [token], setup(ctx) { ctx.provide(token, () => "global"); } }),
    realm.mount(plugin("local-model", { provides: [token], setup(ctx) { ctx.provide(token, () => "local"); } })),
    scope.mount(realm.mount(plugin("consumer", { requires: [token], setup(ctx) {
      ctx.registerTool({ name: "model", description: "", inputSchema: {}, execute: (_, run) => run.services.get(token) });
    } }))),
  ] });
  t.after(() => runtime.close());
  const session = await runtime.openSession();
  await session.run(async run => { assert.equal(run.services.get(token), "global"); assert.equal(await run.tools.invoke("model", {}), "local"); }, { registryScope: scope });
  await session.run(run => { assert.equal(run.services.get(token), "local"); assert.equal(run.tools.list().length, 0); }, realm);
});

test("duplicate scope identities are rejected before setup or run admission; same-layer duplicates roll back", async t => {
  let setups = 0, cleanups = 0;
  const a = new RegistryScope("a"), anotherA = new RegistryScope("a");
  assert.throws(() => a.child("a"), code("REGISTRY_SCOPE_ID_CONFLICT"));
  await assert.rejects(Runtime.create({ plugins: [a.mount(plugin("one", { setup() { setups++; } })), anotherA.mount(plugin("two"))] }), code("REGISTRY_SCOPE_ID_CONFLICT"));
  assert.equal(setups, 0);
  await assert.rejects(Runtime.create({ plugins: [a.mount(provider("one", "one")), a.mount(provider("two", "two", { setup(ctx) {
    ctx.onCleanup(() => { cleanups++; }); ctx.registerTool(tool("read", "two"));
  } }))] }), code("SETUP_FAILED"));
  assert.equal(cleanups, 1);
  const runtime = await Runtime.create({ plugins: [a.mount(provider("one", "one"))] });
  t.after(() => runtime.close());
  const session = await runtime.openSession();
  await assert.rejects(session.run(() => { throw new Error("not admitted"); }, { registryScope: anotherA }), code("REGISTRY_SCOPE_ID_CONFLICT"));
  assert.equal(await session.run(run => run.tools.invoke("read", "one"), { registryScope: a }), "one");
});

test("generic registry contributions are copied, owned, scoped and require a shared token identity", async t => {
  const token = registryToken<{ nested: { value: number } }>("custom", value => value), scope = new RegistryScope();
  const value = { nested: { value: 1 } };
  const runtime = await Runtime.create({ plugins: [scope.mount(plugin("custom", { setup(ctx) { ctx.register(token, "entry", value); } }))] });
  t.after(() => runtime.close());
  value.nested.value = 2;
  const session = await runtime.openSession();
  await session.run(run => assert.deepEqual(run.registries.get(token).list(), []));
  let saved!: ReturnType<RunContext["registries"]["get"]>;
  await session.run(run => {
    const entries = run.registries.get(token); saved = entries;
    const entry = entries.get("entry")!;
    assert.equal(entry.value.nested.value, 1); assert.equal(entry.info.owner, "custom"); assert.equal(entry.info.generation, 1);
    assert.ok(Object.isFrozen(entry.value.nested)); assert.ok(Object.isFrozen(entries.list()));
    assert.throws(() => run.registries.get(registryToken("custom", value => value)), code("REGISTRY_ID_CONFLICT"));
  }, { registryScope: scope });
  assert.throws(() => saved.list(), code("RUN_ENDED"));
  await assert.rejects(runtime.enablePlugin(plugin("bad-token", { setup(ctx) { ctx.register(registryToken("custom", value => value), "other", {}); } })), code("REPLACEMENT_FAILED"));
  await runtime.disablePlugin("custom");
  assert.equal(runtime.inspect().filter(row => row.kind === "registry").length, 0);
  await session.run(run => assert.equal(run.registries.get(token).list().length, 0), { registryScope: scope });
});

test("command help and parsing use the same scoped view, and unloading reveals the parent command", async t => {
  const scope = new RegistryScope("commands"), sibling = new RegistryScope("other");
  const runtime = await Runtime.create({ plugins: [createCliCommandsPlugin(), scope.mount(plugin("custom-commands", { setup(ctx) {
    ctx.register(commandRegistry, "review", { usage: "<file>", description: "局部审查", parse: args => ({ kind: "prompt", text: `review ${args}` }) });
    ctx.register(commandRegistry, "status", { usage: "", description: "局部状态", parse: () => ({ kind: "prompt", text: "local status" }) });
  } }))] });
  t.after(() => runtime.close());
  const session = await runtime.openSession();
  for (const registryScope of [undefined, sibling]) await session.run(run => {
    const commands = run.services.get(cliCommandService);
    assert.equal(commands.parse("/review file").kind, "error"); assert.doesNotMatch(commands.help(), /局部/);
  }, registryScope ? { registryScope } : {});
  await session.run(run => {
    const commands = run.services.get(cliCommandService);
    assert.deepEqual(commands.parse("/review file"), { kind: "prompt", text: "review file" });
    assert.match(commands.help(), /局部状态/); assert.equal(commands.list().filter(entry => entry.info.name === "status").length, 1);
  }, { registryScope: scope });
  await runtime.disablePlugin("custom-commands");
  await session.run(run => assert.deepEqual(run.services.get(cliCommandService).parse("/status"), { kind: "status" }), { registryScope: scope });
});

test("skill summaries, bodies and resources resolve one immutable nearest-layer definition", async t => {
  const preset = new RegistryScope("preset"), agent = preset.child("agent"), sibling = new RegistryScope("sibling");
  const contribution = (id: string, content: string) => plugin(id, { setup(ctx) {
    ctx.register(skillRegistry, "review", { version: "1", description: content, content, resources: { "guide.txt": `${content}/guide` } });
  } });
  const runtime = await Runtime.create({ plugins: [createSkillRegistryPlugin(), contribution("global", "global"), preset.mount(contribution("preset", "preset")), agent.mount(contribution("agent", "agent"))] });
  t.after(() => runtime.close());
  const session = await runtime.openSession();
  for (const [registryScope, expected] of [[agent, "agent"], [preset, "preset"], [sibling, "global"]] as const) await session.run(run => {
    const skills = run.services.get(skillRegistryService);
    assert.equal(skills.list()[0]!.description, expected);
    const selected = skills.get("review")!;
    assert.equal(selected.value.content, expected);
    assert.ok(Object.isFrozen(selected) && Object.isFrozen(selected.value) && Object.isFrozen(selected.value.resources));
    assert.throws(() => { (selected.value as { content: string }).content = "changed"; }, TypeError);
    assert.throws(() => { (selected.value.resources as Record<string, string>)["guide.txt"] = "changed"; }, TypeError);
    assert.equal(skills.get("review")!.value.content, expected);
    assert.equal(skills.readResource("review", "guide.txt"), `${expected}/guide`);
    assert.equal(skills.readResource("review", "toString"), undefined);
    assert.equal(skills.get("missing"), undefined);
  }, { registryScope });
  await runtime.disablePlugin("agent");
  assert.equal(await session.run(run => run.services.get(skillRegistryService).get("review")!.value.content, { registryScope: agent }), "preset");
});

test("staging, draining, replacement and rollback preserve scoped snapshots and sibling generations", async t => {
  const a = new RegistryScope("a"), b = new RegistryScope("b"), entered = deferred(), release = deferred();
  const runtime = await Runtime.create({ plugins: [a.mount(provider("a", "old")), b.mount(provider("b", "sibling"))] });
  t.after(async () => { release.resolve(); await runtime.close(); });
  const session = await runtime.openSession();
  const running = session.run(async run => {
    entered.resolve(); await release.promise;
    assert.equal(await run.tools.invoke("read", "old"), "old");
    assert.equal(run.manifest.tools[0]!.generation, 1);
  }, { registryScope: a });
  await entered.promise;
  const replacing = runtime.replacePlugin(a.mount(provider("a", "new")));
  await tick(); let admitted = false;
  const next = session.run(run => { admitted = true; return run.tools.invoke("read", "new"); }, { registryScope: a });
  await tick(); assert.equal(admitted, false);
  release.resolve(); await running; assert.equal((await replacing).status, "switched"); assert.equal(await next, "new");
  await session.run(run => { assert.equal(run.manifest.tools[0]!.generation, 1); }, { registryScope: b });
  await assert.rejects(runtime.replacePlugin(a.mount(provider("a", "broken", { setup(ctx) {
    ctx.registerTool(tool("read", "broken")); ctx.resource("fail", () => { throw new Error("activation"); }, () => {});
  } }))), code("REPLACEMENT_FAILED"));
  assert.equal(await session.run(run => run.tools.invoke("read", "new"), { registryScope: a }), "new");
  assert.equal(await session.run(run => run.tools.invoke("read", "sibling"), { registryScope: b }), "sibling");
});

test("session catalogs do not leak across sessions and runtime upgrades check all session collisions", async t => {
  const scope = new RegistryScope("local");
  const runtime = await Runtime.create({ plugins: [provider("base", "global"), scope.mount(plugin("session-tool", { scope: "session", setup(ctx) {
    ctx.registerTool({ ...tool("read", ctx.sessionId!), execute: () => ctx.sessionId });
  } }))] });
  t.after(() => runtime.close());
  const first = await runtime.openSession("one"), second = await runtime.openSession("two");
  assert.equal(await first.run(run => run.tools.invoke("read", "one"), { registryScope: scope }), "one");
  assert.equal(await second.run(run => run.tools.invoke("read", "two"), { registryScope: scope }), "two");
  assert.equal((await runtime.replacePlugin(provider("base", "next"))).status, "switched");
  await assert.rejects(runtime.enablePlugin(scope.mount(provider("collision", "bad"))), code("REPLACEMENT_FAILED"));
  await first.close();
  assert.equal(await second.run(run => run.tools.invoke("read", "two"), { registryScope: scope }), "two");
  assert.equal(await second.run(run => run.tools.invoke("read", "next")), "next");
});

test("native and PTC use scoped schemas and implementations; one Session can retain distinct same-name providers", async t => {
  const fixture = await journalFixture(t), scope = new RegistryScope("agent"), sibling = new RegistryScope("sibling");
  const runtime = await Runtime.create({ plugins: [provider("global", "global"), scope.mount(provider("agent", "agent")),
    sibling.mount(plugin("hidden", { setup(ctx) { ctx.registerTool(tool("secret", "secret")); } })),
    createSessionPlugin({ directory: fixture.directory }), createToolPipelinePlugin(),
  ] });
  t.after(() => runtime.close());
  const session = await runtime.openSession("session");
  for (const [registryScope, expected] of [[undefined, "global"], [scope, "agent"]] as const) await session.run(async run => {
    const tools = run.services.get(services.tool), log = run.services.get(services.session);
    await log.retain([definitions[0], definitions[1], ...tools.definitions()]);
    await log.start({ model: reference(definitions[0]), prompt: reference(definitions[1]), plugins: [], tools: tools.definitions().map(reference) }, {});
    assert.equal((await tools.invoke("read", "wrong")).code, "INVALID_ARGUMENTS");
    assert.equal((await tools.invoke("read", expected)).value, expected);
    let launched = 0;
    const ptc = new PtcRuntime({ id: "test-no-isolation", profile: {}, async close() {}, async run(_request, host) {
      launched++; const result = await host.call("read", expected);
      return { status: "completed", value: result.value, code: null, cleanup: "verified" };
    } }, tools, log);
    await assert.rejects(ptc.evaluate({ program: "test", input: null, bindings: ["secret"] }), code("PTC_BINDING"));
    assert.equal(launched, 0);
    const result = await ptc.evaluate({ program: "test", input: null, bindings: ["read"] });
    assert.equal(result.children[0]!.value, expected); assert.equal(result.status, "completed");
    await log.record([{ data: { type: "run.finished", status: "completed" } }]);
  }, registryScope ? { registryScope } : {});
  await runtime.close();
});

test("scoped manifest round-trips and rejects invisible, misowned, duplicate or mismatched registry entries", async t => {
  const fixture = await journalFixture(t), scope = new RegistryScope("agent");
  const runtime = await Runtime.create({ plugins: [scope.mount(provider("local", "local")), createSessionPlugin({ directory: fixture.directory })] });
  t.after(() => runtime.close());
  const session = await runtime.openSession("session");
  const manifest = await session.run(async run => {
    const log = run.services.get(services.session);
    await log.retain(definitions); await log.start(versions, {});
    await log.record([{ callId: "request", data: { type: "model.requested", request: {} } }, { callId: "request", data: { type: "model.completed", response: {}, text: "ok" } }, { data: { type: "run.finished", status: "completed" } }]);
    return log.reconstructRequest("request").manifest!;
  }, { registryScope: scope });
  await runtime.close();
  const restored = await Runtime.create({ plugins: [createSessionPlugin({ directory: fixture.directory })] });
  t.after(() => restored.close());
  const reopened = await restored.openSession("session");
  assert.deepEqual(await reopened.run(run => run.services.get(services.session).reconstructRequest("request").manifest), manifest);
  await restored.close();
  const { log } = await fixture.open(); await log.forRun("retain").retain(definitions);
  const mutate = (patch: Partial<NonNullable<RunManifest["registryView"]>["entries"][number]>): RunManifest => ({ ...manifest, registryView: { chain: manifest.registryView!.chain, entries: manifest.registryView!.entries.map(entry => ({ ...entry, ...patch })) } });
  const invalid: RunManifest[] = [mutate({ registryScope: "sibling" }), mutate({ generation: 999 }), mutate({ owner: "missing" }), mutate({ version: 0 }),
    { ...manifest, registryView: { chain: ["agent", "agent"], entries: manifest.registryView!.entries } },
    { ...manifest, registryView: { chain: ["agent"], entries: [...manifest.registryView!.entries, ...manifest.registryView!.entries] } },
    { ...manifest, registryView: { chain: [], entries: manifest.registryView!.entries } },
    { ...manifest, tools: manifest.tools.map(tool => ({ ...tool, registryScope: null })) },
  ];
  for (const [index, bad] of invalid.entries()) await assert.rejects(log.forRun(`bad-${index}`, bad).start(versions, {}), code("INVALID_EVENT"));
  // Legacy journals contain neither registryView nor registryScope metadata.
  const legacy: RunManifest = { configuration: manifest.configuration, plugins: manifest.plugins.map(({ registryScope: _scope, ...item }) => item), tools: manifest.tools.map(({ registryScope: _scope, ...item }) => item) };
  await log.forRun("legacy", legacy).start(versions, {});
});
