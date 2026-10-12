import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import type { Plugin, ServiceToken } from "./types.js";

declare const identity: unique symbol;
/** Object identity selects a realm; id is its serializable audit identity. */
export interface IsolationKey { readonly id: string; readonly [identity]: true }
const keys = new WeakMap<IsolationKey, Map<string, symbol>>();
const scopes = new WeakMap<ServiceScope, ReadonlyMap<string, IsolationKey>>();
const defaults = new Map<string, symbol>();

export function createIsolationKey(id: string = randomUUID()): IsolationKey {
  if (typeof id !== "string" || !id.trim()) fail("INVALID_ISOLATION", "Isolation id must be nonempty");
  const key = Object.freeze({ id }) as IsolationKey;
  keys.set(key, new Map());
  return key;
}

/** Immutable service bindings, independent of Runtime / Session resource lifetimes. */
export class ServiceScope {
  constructor() { scopes.set(this, new Map()); Object.freeze(this); }

  isolate(token: ServiceToken, key: IsolationKey = createIsolationKey()): ServiceScope {
    if (!token || typeof token.id !== "string" || !token.id.trim() || !Number.isSafeInteger(token.version) || token.version < 1) fail("INVALID_DESCRIPTOR", "Invalid service token");
    if (!keys.has(key)) fail("INVALID_ISOLATION", "Use createIsolationKey() to create an isolation identity");
    const bindings = new Map(scopeBindings(this));
    bindings.set(token.id, key);
    const child = new ServiceScope();
    scopes.set(child, bindings);
    return child;
  }

  mount(plugin: Plugin, instanceId = plugin.instanceId ?? plugin.id): Plugin {
    scopeBindings(this);
    return Object.freeze({ ...plugin, instanceId, serviceScope: this });
  }
}

export function scopeBindings(scope?: ServiceScope): ReadonlyMap<string, IsolationKey> {
  if (scope === undefined) return new Map();
  const bindings = scopes.get(scope);
  if (!bindings) fail("INVALID_ISOLATION", "Expected a ServiceScope created by this runtime library");
  return bindings;
}

/** A different key with the same audit id must never silently join a realm. */
export function validateScopes(values: readonly (ServiceScope | undefined)[]): void {
  const identities = new Map<string, IsolationKey>();
  for (const scope of values) for (const key of scopeBindings(scope).values()) {
    const prior = identities.get(key.id);
    if (prior && prior !== key) fail("ISOLATION_ID_CONFLICT", `Different isolation keys use the same audit id: ${key.id}`);
    identities.set(key.id, key);
  }
}

/** Internal resolved slot: unique per service name and realm, never by label text alone. */
export function serviceBinding(scope: ServiceScope | undefined, name: string): { key: symbol; isolation: string | null } {
  const realm = scopeBindings(scope).get(name);
  const table = realm ? keys.get(realm)! : defaults;
  let key = table.get(name);
  if (!key) { key = Symbol(name); table.set(name, key); }
  return { key, isolation: realm?.id ?? null };
}

export function pluginInstanceId(plugin: Plugin): string { return plugin.instanceId ?? plugin.id; }
