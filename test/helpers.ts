import { API_VERSION, HarnessError, type Plugin } from "../src/index.js";

export function plugin(id: string, overrides: Partial<Plugin> = {}): Plugin {
  return { id, version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [], setup() {}, ...overrides };
}

export function code(expected: string) {
  return (error: unknown): boolean => error instanceof HarnessError && error.code === expected;
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
