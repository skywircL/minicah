import { fail, HarnessError } from "./errors.js";
import { NamedEntries, ScopedLayers } from "./scopes.js";
import type { RegistryScope, RegistrationScopeContext, ScopeLayer } from "./scopes.js";
import type { Ownership, Plugin } from "./types.js";

export interface RegistryToken<T = unknown> {
  readonly id: string;
  readonly version: number;
  readonly __type?: T;
}
const validators = new WeakMap<RegistryToken, (value: unknown) => unknown>();

/** Share this token across contributors. validate is pure; data is copied after validation. */
export function registryToken<T>(id: string, validate: (value: T) => T, version = 1): RegistryToken<T> {
  if (typeof id !== "string" || !id.trim() || !Number.isSafeInteger(version) || version < 1 || typeof validate !== "function") fail("INVALID_REGISTRY", "Registry needs an id, interface version and validator");
  const token = Object.freeze({ id, version });
  validators.set(token, validate as (value: unknown) => unknown);
  return token;
}

/** Copy plain definition data; callbacks keep their identity, just like service factories. */
function copyDefinition(value: unknown, seen = new Set<object>()): unknown {
  if (value === undefined || value === null || ["string", "boolean", "function"].includes(typeof value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail("INVALID_REGISTRATION", "Registry definitions must be acyclic plain data and callbacks");
  seen.add(value);
  const result = Array.isArray(value) ? value.map(item => copyDefinition(item, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyDefinition(item, seen)]));
  seen.delete(value);
  return Object.freeze(result);
}
export function validateRegistry(token: RegistryToken): void {
  if (!validators.has(token)) fail("INVALID_REGISTRY", "Use a shared registryToken() identity");
}
export function prepareEntry<T>(token: RegistryToken<T>, value: T): T {
  validateRegistry(token);
  return copyDefinition(validators.get(token)!(value)) as T;
}

export interface RegistryInfo extends Ownership {
  readonly registry: string;
  readonly version: number;
  readonly name: string;
  readonly registryScope: string | null;
}
export interface RegistryEntry<T> { readonly info: RegistryInfo; readonly value: T }
export interface RegistrySnapshot<T> {
  list(): readonly RegistryEntry<T>[];
  get(name: string): RegistryEntry<T> | undefined;
}
export interface RegistrySnapshots { get<T>(token: RegistryToken<T>): RegistrySnapshot<T> }

export interface RegistryRegistration extends RegistryEntry<unknown> {
  readonly token: RegistryToken;
  readonly plugin: Plugin;
}
export class RegistryLayer implements ScopeLayer {
  readonly tables = new Map<RegistryToken, NamedEntries<RegistryRegistration>>();
  table(token: RegistryToken): NamedEntries<RegistryRegistration> {
    let entries = this.tables.get(token);
    if (!entries) {
      entries = new NamedEntries(name => new HarnessError(token.id === "tools" ? "DUPLICATE_TOOL" : "DUPLICATE_REGISTRATION", `Duplicate ${token.id} entry in one scope: ${name}`));
      this.tables.set(token, entries);
    }
    return entries;
  }
  isEmpty(): boolean { return [...this.tables.values()].every(entries => entries.isEmpty()); }
}

/** Each setup transaction owns its catalog; a run combines only committed catalogs. */
export class RegistryCatalog {
  readonly layers = new ScopedLayers(() => new RegistryLayer());
  add(ctx: RegistrationScopeContext, registration: RegistryRegistration): void {
    this.layers.effect(ctx, layer => layer.table(registration.token).insert(registration.info.name, registration));
  }
  entries(): readonly RegistryRegistration[] {
    return this.layers.allLayers().flatMap(layer => [...layer.tables.values()].flatMap(table => [...table.values()]));
  }
  view(scope?: RegistryScope): Map<RegistryToken, Map<string, RegistryRegistration>> {
    const tokens = new Set(this.entries().map(entry => entry.token));
    return new Map([...tokens].map(token => [token, this.layers.merge(scope, layer => layer.tables.get(token) ?? new NamedEntries<RegistryRegistration>())]));
  }
}
