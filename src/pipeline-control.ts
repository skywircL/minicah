import { fail } from "./errors.js";
import type { JsonValue } from "./types.js";

/** JSON-only resource limits become part of the run configuration manifest. */
export function limitConfiguration(input: JsonValue | undefined, defaults: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) fail("INVALID_CONFIG", "Limits must be an object");
  const raw = input as Record<string, JsonValue> | undefined;
  if (raw && Object.keys(raw).some(key => !Object.hasOwn(defaults, key))) fail("INVALID_CONFIG", "Unknown resource limit");
  return Object.freeze(Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const value = raw && Object.hasOwn(raw, key) ? raw[key] : fallback;
    if (typeof value !== "number") fail("INVALID_CONFIG", "Resource limits must be numbers");
    return [key, positive(value, key)];
  })));
}

export function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) fail("INVALID_LIMIT", `${name} must be a positive bounded integer`);
  return value;
}

/** All counters change synchronously before any await, including concurrent callers. */
export class ToolUsageMeter {
  #attemptedCalls = 0;
  #spentCalls = 0; #spentCost = 0; #reservedCalls = 0; #reservedCost = 0;
  attempt(): void {
    this.#attemptedCalls++;
  }
  reserve(cost = 1) {
    positive(cost, "tool cost");
    this.#reservedCalls++; this.#reservedCost += cost;
    let settled = false;
    return (dispatched: boolean) => {
      if (settled) return;
      settled = true; this.#reservedCalls--; this.#reservedCost -= cost;
      if (dispatched) { this.#spentCalls++; this.#spentCost += cost; }
    };
  }
  state() { return Object.freeze({ attemptedCalls: this.#attemptedCalls, spentCalls: this.#spentCalls, spentCost: this.#spentCost, reservedCalls: this.#reservedCalls, reservedCost: this.#reservedCost }); }
}

export class Scheduler {
  #active = 0;
  #queue: { grant: () => void; reject: () => void; signal: AbortSignal }[] = [];
  constructor(readonly concurrency: number, readonly maxQueued: number) { positive(concurrency, "concurrency"); positive(maxQueued, "maxQueued"); }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error("CANCELLED"));
    if (this.#active < this.concurrency) { this.#active++; return Promise.resolve(this.#release()); }
    if (this.#queue.length >= this.maxQueued) return Promise.reject(new Error("QUEUE_FULL"));
    return new Promise((resolve, reject) => {
      const entry = { signal, grant: () => { signal.removeEventListener("abort", entry.reject); this.#active++; resolve(this.#release()); }, reject: () => {
        this.#queue = this.#queue.filter(item => item !== entry); signal.removeEventListener("abort", entry.reject); reject(new Error("CANCELLED"));
      } };
      this.#queue.push(entry); signal.addEventListener("abort", entry.reject, { once: true });
    });
  }
  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true; this.#active--;
      const next = this.#queue.shift(); next?.grant();
    };
  }
  state() { return Object.freeze({ active: this.#active, queued: this.#queue.length }); }
}

/** Timeout stops waiting; the underlying promise remains observed and owned. */
export async function waitForCleanup<T>(work: Promise<T>, signal: AbortSignal, graceMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => { timer = setTimeout(() => reject(new Error("CLEANUP_UNCONFIRMED")), graceMs); };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
