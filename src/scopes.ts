import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import type { Plugin } from "./types.js";

const parents = new WeakMap<RegistryScope, RegistryScope | undefined>();

/** Contribution visibility, independent of service bindings and resource lifetimes. */
export class RegistryScope {
  readonly id: string;
  constructor(id: string = randomUUID(), parent?: RegistryScope) {
    if (typeof id !== "string" || !id.trim()) fail("INVALID_REGISTRY_SCOPE", "Scope id must be nonempty");
    if (parent !== undefined) scopeChain(parent);
    this.id = id;
    parents.set(this, parent);
    validateRegistryScopes([this]);
    Object.freeze(this);
  }
  child(id?: string): RegistryScope { return new RegistryScope(id, this); }
  mount(plugin: Plugin, instanceId = plugin.instanceId ?? plugin.id): Plugin {
    scopeChain(this);
    return Object.freeze({ ...plugin, instanceId, registryScope: this });
  }
}

/** Farthest ancestor first; undefined denotes the global view. */
export function scopeChain(scope?: RegistryScope): readonly RegistryScope[] {
  const chain: RegistryScope[] = [];
  for (let current = scope; current !== undefined; current = parents.get(current)) {
    if (!parents.has(current)) fail("INVALID_REGISTRY_SCOPE", "Expected a RegistryScope created by this library");
    chain.push(current);
  }
  return chain.reverse();
}

export function validateRegistryScopes(scopes: readonly (RegistryScope | undefined)[]): void {
  const identities = new Map<string, RegistryScope>();
  for (const scope of scopes) for (const key of scopeChain(scope)) {
    const previous = identities.get(key.id);
    if (previous && previous !== key) fail("REGISTRY_SCOPE_ID_CONFLICT", `Different scope objects use id: ${key.id}`);
    identities.set(key.id, key);
  }
}

export interface ScopeLayer { isEmpty(): boolean }

export class NamedEntries<T> {
  readonly #entries = new Map<string, T>();
  constructor(readonly duplicate: (name: string) => Error = name => new Error(`Duplicate entry: ${name}`)) {}
  insert(name: string, value: T): () => void {
    if (this.#entries.has(name)) throw this.duplicate(name);
    this.#entries.set(name, value);
    let active = true;
    return () => { if (active) { active = false; this.#entries.delete(name); } };
  }
  get(name: string): T | undefined { return this.#entries.get(name); }
  has(name: string): boolean { return this.#entries.has(name); }
  entries(): IterableIterator<[string, T]> { return this.#entries.entries(); }
  values(): IterableIterator<T> { return this.#entries.values(); }
  isEmpty(): boolean { return this.#entries.size === 0; }
}

export class AnonymousEntries<T> {
  readonly #entries = new Map<symbol, T>();
  append(value: T): () => void {
    const key = Symbol();
    this.#entries.set(key, value);
    return () => { this.#entries.delete(key); };
  }
  values(): IterableIterator<T> { return this.#entries.values(); }
  isEmpty(): boolean { return this.#entries.size === 0; }
}

export interface RegistrationScopeContext {
  readonly registryScope: RegistryScope | undefined;
  onCleanup(dispose: () => void): void;
}

/** Storage and synchronous registration rollback; individual registries own resolution policy. */
export class ScopedLayers<L extends ScopeLayer> {
  readonly global: L;
  readonly #scoped = new Map<RegistryScope, L>();
  constructor(readonly createLayer: (scope: RegistryScope | undefined) => L, readonly onChange: () => void = () => {}) {
    this.global = createLayer(undefined);
  }
  peek(scope?: RegistryScope): L | undefined { return scope === undefined ? undefined : this.#scoped.get(scope); }
  chainLayers(scope?: RegistryScope): readonly L[] {
    return scopeChain(scope).flatMap(key => { const layer = this.#scoped.get(key); return layer ? [layer] : []; });
  }
  allLayers(): readonly L[] { return [this.global, ...this.#scoped.values()]; }
  merge<T>(scope: RegistryScope | undefined, pick: (layer: L) => NamedEntries<T>): Map<string, T> {
    const result = new Map(pick(this.global).entries());
    for (const layer of this.chainLayers(scope)) for (const [name, value] of pick(layer).entries()) result.set(name, value);
    return result;
  }
  /** action must either return an undo or leave the layer unchanged on failure. */
  effect(ctx: RegistrationScopeContext, action: (layer: L) => () => void): () => void {
    const scope = ctx.registryScope;
    scopeChain(scope);
    let layer = scope === undefined ? this.global : this.#scoped.get(scope);
    if (!layer) { layer = this.createLayer(scope); this.#scoped.set(scope!, layer); }
    const reclaim = () => { if (scope !== undefined && layer.isEmpty()) this.#scoped.delete(scope); };
    let undo: () => void;
    try { undo = action(layer); } catch (error) { reclaim(); throw error; }
    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      undo(); reclaim(); this.onChange();
    };
    try { ctx.onCleanup(dispose); this.onChange(); }
    catch (error) {
      // Registration failure must undo even if notification itself is broken.
      active = false;
      undo(); reclaim();
      throw error;
    }
    return dispose;
  }
}
