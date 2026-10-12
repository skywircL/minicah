import { AsyncLocalStorage } from "node:async_hooks";
import { fail } from "./errors.js";
import { validateToken } from "./plan.js";
import { registrations, type RegistrationBatch } from "./resources.js";
import { pluginInstanceId, serviceBinding, type ServiceScope } from "./isolation.js";
import { scopeChain, type RegistryScope } from "./scopes.js";
import { RegistryCatalog, validateRegistry, type RegistryEntry, type RegistrySnapshot, type RegistryToken } from "./registry.js";
import { toolRegistry } from "./tool-registry.js";
import type { ConfigurationVersion, Plugin, RunContext, ServiceToken, ToolDefinition, ToolExecution, ToolInfo } from "./types.js";

/** A private map backs immutable facades: Object.freeze(Map) alone is not enough. */
export function createSnapshot(id: string, sessionId: string, batches: readonly RegistrationBatch[], configuration: ConfigurationVersion, entryScope?: ServiceScope, registryScope?: RegistryScope) {
  const { services, entries } = registrations(batches);
  const catalog = new RegistryCatalog();
  // This catalog is private to the run; batch disposal cannot mutate its maps.
  for (const entry of entries) catalog.add({ registryScope: entry.plugin.registryScope, onCleanup() {} }, entry);
  const registryViews = catalog.view(registryScope);
  const tools = registryViews.get(toolRegistry) ?? new Map();
  const instances = new Map<symbol, unknown>();
  const resolving = new Set<symbol>();
  const contexts = new Map<string, RunContext>();
  const pending = new Set<Promise<unknown>>();
  const operation = new AsyncLocalStorage<{ active: boolean }>();
  let active = true;
  let accepting = true;
  const assertActive = () => { if (!active) fail("RUN_ENDED", `Run ${id} has ended`); };
  const track = <T>(callback: () => Promise<T>): Promise<T> => {
    assertActive();
    if (!accepting && !operation.getStore()?.active) fail("RUN_ENDED", `Run ${id} is finishing`);
    const scope = { active: true };
    const work = operation.run(scope, () => {
      try { return Promise.resolve(callback()); } catch (error) { return Promise.reject(error); }
    });
    pending.add(work);
    const done = () => { scope.active = false; pending.delete(work); };
    void work.then(done, done);
    return work;
  };
  const serviceList = Object.freeze([...services.values()].map(registration => registration.info));
  const toolList: readonly ToolInfo[] = Object.freeze([...tools.values()].map(({ info, value }) => {
    const tool = value as ToolDefinition;
    return Object.freeze({ owner: info.owner, generation: info.generation, scope: info.scope, sessionId: info.sessionId, registryScope: info.registryScope,
      name: info.name, description: tool.description, inputSchema: tool.inputSchema, ...(tool.effect ? { effect: tool.effect } : {}) });
  }));
  const allowed = (plugin: Plugin, token: ServiceToken) =>
    [...plugin.provides, ...plugin.requires].some(item => item.id === token.id && item.version === token.version);
  const scopeFor = (plugin?: Plugin) => plugin ? plugin.serviceScope : entryScope;
  const visible = (plugin?: Plugin) => [...services].filter(([key, { info }]) =>
    serviceBinding(scopeFor(plugin), info.id).key === key && (!plugin || allowed(plugin, info))).map(([, registration]) => registration.info);
  const manifest = Object.freeze({ configuration,
    tools: Object.freeze(toolList.map(tool => Object.freeze({ ...tool, sessionId: tool.sessionId ?? null }))),
    plugins: Object.freeze(batches.map(batch => Object.freeze({
      id: batch.ownership.owner, definitionId: batch.plugin.id, version: batch.plugin.version, generation: batch.ownership.generation, scope: batch.ownership.scope, registryScope: batch.plugin.registryScope?.id ?? null,
    }))),
    services: Object.freeze(serviceList.map(info => Object.freeze({ ...info, sessionId: info.sessionId ?? null }))),
    bindings: Object.freeze([undefined, ...batches.map(batch => batch.plugin)].flatMap(plugin => visible(plugin).map(info => Object.freeze({
      consumer: plugin ? pluginInstanceId(plugin) : null, id: info.id, version: info.version, isolation: info.isolation,
    })))),
    registryView: Object.freeze({
      chain: Object.freeze(scopeChain(registryScope).map(scope => scope.id)),
      entries: Object.freeze([...registryViews.values()].flatMap(view => [...view.values()].map(({ info }) => Object.freeze({ ...info, sessionId: info.sessionId ?? null })))),
    }),
  });

  const get = <T>(token: ServiceToken<T>, plugin?: Plugin): T => {
    assertActive();
    validateToken(token);
    if (plugin && !allowed(plugin, token)) fail("UNDECLARED_DEPENDENCY", `${plugin.id} did not declare ${token.id}@${token.version}`);
    const key = serviceBinding(scopeFor(plugin), token.id).key;
    const registration = services.get(key);
    if (!registration) fail("MISSING_SERVICE", `Unknown service: ${token.id}`);
    if (registration.info.version !== token.version) fail("SERVICE_VERSION", `Incompatible service: ${token.id}@${token.version}`);
    if (instances.has(key)) return instances.get(key) as T;
    if (resolving.has(key)) fail("SERVICE_CYCLE", `Service factory cycle at ${token.id}`);
    resolving.add(key);
    try {
      const value = registration.factory(forPlugin(registration.plugin));
      if (value === null || value === undefined || (typeof value === "object" && "then" in value)) {
        fail("INVALID_SERVICE", `Factory ${token.id} must synchronously return a service`);
      }
      instances.set(key, value);
      return value as T;
    } finally { resolving.delete(key); }
  };

  const toolSnapshot = Object.freeze({
    list: () => { assertActive(); return toolList; },
    invoke: async (name: string, input: unknown, beforeExecute?: () => void, execution?: ToolExecution): Promise<unknown> => {
      assertActive();
      const registration = tools.get(name);
      if (!registration) fail("MISSING_TOOL", `Unknown tool: ${name}`);
      return track(() => Promise.resolve().then(() => {
        beforeExecute?.();
        return (registration.value as ToolDefinition).execute(input, forPlugin(registration.plugin), execution);
      }));
    },
  });

  const registrySnapshots = new Map<RegistryToken, RegistrySnapshot<unknown>>();
  const registries = Object.freeze({ get: <T>(token: RegistryToken<T>): RegistrySnapshot<T> => {
    assertActive(); validateRegistry(token);
    if (entries.some(entry => entry.token.id === token.id && entry.token !== token)) fail("REGISTRY_ID_CONFLICT", `Use the registered token for ${token.id}`);
    let snapshot = registrySnapshots.get(token);
    if (!snapshot) {
      const items = new Map<string, RegistryEntry<unknown>>([...registryViews.get(token) ?? []].map(([name, { info, value }]) => [name, Object.freeze({ info, value })]));
      const list = Object.freeze([...items.values()]);
      snapshot = Object.freeze({ list: () => { assertActive(); return list; }, get: (name: string) => { assertActive(); return items.get(name); } });
      registrySnapshots.set(token, snapshot);
    }
    return snapshot as RegistrySnapshot<T>;
  } });

  const makeContext = (plugin?: Plugin): RunContext => Object.freeze({
    id, sessionId, tools: toolSnapshot, registries, registryScope, configuration, manifest, track,
    services: Object.freeze({
      get: <T>(token: ServiceToken<T>) => get(token, plugin),
      list: () => {
        assertActive();
        return Object.freeze(visible(plugin));
      },
    }),
  });
  const forPlugin = (plugin: Plugin): RunContext => {
    const instanceId = pluginInstanceId(plugin);
    let context = contexts.get(instanceId);
    if (!context) { context = makeContext(plugin); contexts.set(instanceId, context); }
    return context;
  };
  const context = makeContext();
  return {
    context,
    async finish() {
      // Track tool calls even if the run callback forgot to await one.
      accepting = false;
      while (pending.size) await Promise.allSettled([...pending]);
      active = false;
      operation.disable();
      instances.clear();
    },
  };
}
