import { fail, HarnessError } from "./errors.js";
import { pluginInstanceId, serviceBinding, scopeBindings, validateScopes } from "./isolation.js";
import { scopeChain, validateRegistryScopes } from "./scopes.js";
import { API_VERSION, type JsonValue, type Plugin, type RuntimeOptions, type ServiceToken } from "./types.js";

export interface Plan {
  readonly plugins: readonly Plugin[];
  readonly configs: ReadonlyMap<string, JsonValue | undefined>;
}

/** Copy and freeze JSON so caller mutation cannot change a validated plan. */
export function freezeJson<T extends JsonValue | undefined>(value: T): T {
  const seen = new Set<object>();
  const copy = (item: unknown): unknown => {
    if (item === undefined || item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || !item || seen.has(item)) fail("INVALID_CONFIG", "Expected finite, acyclic JSON data");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      fail("INVALID_CONFIG", "Config and schemas must contain only JSON data");
    }
    seen.add(item);
    const result = Array.isArray(item)
      ? item.map(copy)
      : Object.fromEntries(Object.entries(item).map(([key, val]) => [key, copy(val)]));
    seen.delete(item);
    return Object.freeze(result);
  };
  return copy(value) as T;
}

export function validateToken(token: ServiceToken): void {
  if (!token || typeof token.id !== "string" || !token.id.trim() || !Number.isSafeInteger(token.version) || token.version < 1) {
    fail("INVALID_DESCRIPTOR", "Service contracts need a nonempty id and positive integer version");
  }
}

export function copyPlugin(input: Plugin): Plugin {
  if (!input || typeof input.id !== "string" || !input.id.trim() ||
      (input.instanceId !== undefined && (typeof input.instanceId !== "string" || !input.instanceId.trim())) ||
      typeof input.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input.version) ||
      !["runtime", "session"].includes(input.scope) || typeof input.setup !== "function" ||
      !Array.isArray(input.provides) || !Array.isArray(input.requires) ||
      (input.configMode !== undefined && !["static", "run"].includes(input.configMode)) ||
      (input.replacementBoundary !== undefined && !["drained", "stop-first"].includes(input.replacementBoundary)) ||
      (input.upgradePolicy !== undefined && !["in-process", "restart-required"].includes(input.upgradePolicy)) ||
      (input.validateConfig !== undefined && typeof input.validateConfig !== "function")) {
    fail("INVALID_DESCRIPTOR", "Invalid plugin descriptor (version must be stable x.y.z)");
  }
  if (input.configMode === "run" && !input.validateConfig) fail("INVALID_CONFIG", `Run-config plugin ${input.id} must provide a schema validator`);
  if (input.apiVersion !== API_VERSION) fail("API_VERSION", `Plugin ${input.id} needs unsupported API ${input.apiVersion}`);
  scopeBindings(input.serviceScope);
  scopeChain(input.registryScope);
  const tokens = (values: readonly ServiceToken[]) => Object.freeze(values.map(token => {
    validateToken(token);
    return Object.freeze({ id: token.id, version: token.version });
  }));
  return Object.freeze({ ...input, provides: tokens(input.provides), requires: tokens(input.requires) });
}

export function buildPlan(options: RuntimeOptions): Plan {
  const ids = new Set<string>();
  const providers = new Map<symbol, { plugin: Plugin; token: ServiceToken }>();
  const plugins = options.plugins.map((input): Plugin => {
    const plugin = copyPlugin(input);
    const id = pluginInstanceId(plugin);
    if (ids.has(id)) fail("DUPLICATE_PLUGIN", `Duplicate plugin instance: ${id}`);
    ids.add(id);
    for (const token of plugin.provides) {
      const { key, isolation } = serviceBinding(plugin.serviceScope, token.id);
      if (providers.has(key)) fail("DUPLICATE_SERVICE", `Duplicate service: ${token.id} in ${isolation ?? "root"}`);
      providers.set(key, { plugin, token });
    }
    return plugin;
  });
  validateScopes(plugins.map(plugin => plugin.serviceScope));
  validateRegistryScopes(plugins.map(plugin => plugin.registryScope));

  const dependencies = new Map<string, Set<string>>();
  for (const plugin of plugins) {
    const edges = new Set<string>();
    const required = new Set<string>();
    for (const token of plugin.requires) {
      if (required.has(token.id)) fail("INVALID_DESCRIPTOR", `Duplicate requirement: ${plugin.id}/${token.id}`);
      required.add(token.id);
      const provider = providers.get(serviceBinding(plugin.serviceScope, token.id).key);
      if (!provider) fail("MISSING_DEPENDENCY", `${plugin.id} requires ${token.id}`);
      if (provider.token.version !== token.version) fail("SERVICE_VERSION", `${plugin.id} requires ${token.id}@${token.version}, provided @${provider.token.version}`);
      if (plugin.scope === "runtime" && provider.plugin.scope === "session") {
        fail("SCOPE_DEPENDENCY", `Runtime plugin ${plugin.id} cannot depend on session plugin ${provider.plugin.id}`);
      }
      if (pluginInstanceId(provider.plugin) === pluginInstanceId(plugin)) fail("DEPENDENCY_CYCLE", `${pluginInstanceId(plugin)} requires its own service ${token.id}`);
      edges.add(pluginInstanceId(provider.plugin));
    }
    dependencies.set(pluginInstanceId(plugin), edges);
  }
  const sorted: Plugin[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plugins.map(plugin => [pluginInstanceId(plugin), plugin]));
  const visit = (id: string, path: string[]) => {
    if (visiting.has(id)) fail("DEPENDENCY_CYCLE", `Dependency cycle: ${[...path, id].join(" -> ")}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id)!) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
    sorted.push(byId.get(id)!);
  };
  for (const plugin of plugins) visit(pluginInstanceId(plugin), []);

  const configs = new Map<string, JsonValue | undefined>();
  for (const id of Object.keys(options.config ?? {})) {
    if (!ids.has(id)) fail("INVALID_CONFIG", `Config for unknown plugin: ${id}`);
  }
  for (const plugin of sorted) {
    const id = pluginInstanceId(plugin);
    try {
      const raw = freezeJson(Object.hasOwn(options.config ?? {}, id) ? options.config![id] : undefined);
      configs.set(id, freezeJson(plugin.validateConfig ? plugin.validateConfig(raw) : raw));
    } catch (cause) {
      throw new HarnessError("INVALID_CONFIG", `Invalid config for ${id}`, { cause });
    }
  }
  return { plugins: Object.freeze(sorted), configs };
}
