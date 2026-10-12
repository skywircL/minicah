import { spawn } from "node:child_process";
import { deadline } from "./deadline.js";
import { fail, HarnessError } from "./errors.js";
import { immutable } from "./json.js";

export interface ProcessSpec { readonly command: string; readonly args: readonly string[]; readonly cwd?: string; readonly env?: Readonly<Record<string, string>> }
export interface ProcessExit { readonly code: number | null; readonly signal: string | null }
export interface ProcessHandle {
  readonly pid: number;
  /** Resolve only after the managed process and its stdio handles have closed. */
  readonly closed: Promise<ProcessExit>;
  signal(signal: "SIGTERM" | "SIGKILL"): void;
}
export interface ProcessDriver { start(spec: ProcessSpec): Promise<ProcessHandle> }
export interface ProcessStopResult { readonly status: "stopped" | "restart-required"; readonly pid: number; readonly exit: ProcessExit | null; readonly errors: readonly unknown[] }
export interface ProcessRestartResult { readonly status: "restarted" | "failed" | "restart-required"; readonly pid: number | null; readonly oldStopped: boolean; readonly error?: unknown }

const nodeDriver: ProcessDriver = {
  start(spec) {
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, [...spec.args], { ...(spec.cwd ? { cwd: spec.cwd } : {}), ...(spec.env ? { env: { ...process.env, ...spec.env } } : {}), shell: false, stdio: "ignore" });
      const closed = new Promise<ProcessExit>(resolve => child.once("close", (code, signal) => resolve(Object.freeze({ code, signal }))));
      child.once("error", reject);
      child.once("spawn", () => resolve({ pid: child.pid!, closed, signal: signal => { child.kill(signal); } }));
    });
  },
};

/** L3 primitive. Invoke at a drained boundary; no import-cache edits or state migration. */
export class ManagedProcess {
  #handle: ProcessHandle;
  #exit: ProcessExit | null = null;
  #state: "running" | "stopped" | "restart-required" = "running";
  #tail: Promise<void> = Promise.resolve();
  #spec: ProcessSpec;
  private constructor(handle: ProcessHandle, spec: ProcessSpec, readonly driver: ProcessDriver, readonly termTimeoutMs: number, readonly killTimeoutMs: number) {
    this.#handle = handle; this.#spec = spec; this.#observe(handle);
  }
  static async start(spec: ProcessSpec, options: { driver?: ProcessDriver; termTimeoutMs?: number; killTimeoutMs?: number } = {}): Promise<ManagedProcess> {
    spec = validateSpec(spec);
    const term = options.termTimeoutMs ?? 5_000, kill = options.killTimeoutMs ?? 5_000;
    for (const ms of [term, kill]) if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2_147_483_647) fail("INVALID_CONFIG", "Invalid process stop timeout");
    const driver = options.driver ?? nodeDriver;
    return new ManagedProcess(await driver.start(spec), spec, driver, term, kill);
  }
  status() { return Object.freeze({ state: this.#state, pid: this.#handle.pid, exit: this.#exit, spec: this.#spec }); }
  stop(): Promise<ProcessStopResult> { return this.#serialize(() => this.#stop()); }
  async dispose(): Promise<void> {
    const result = await this.stop();
    if (result.status !== "stopped") throw new HarnessError("RESTART_REQUIRED", `Process ${result.pid} has not confirmed closure`, { cause: result });
  }
  restart(spec: ProcessSpec): Promise<ProcessRestartResult> {
    spec = validateSpec(spec);
    return this.#serialize(async () => {
      const stopped = await this.#stop();
      if (stopped.status !== "stopped") return Object.freeze({ status: "restart-required", pid: stopped.pid, oldStopped: false });
      try {
        const handle = await this.driver.start(spec);
        this.#handle = handle; this.#spec = spec; this.#exit = null; this.#state = "running"; this.#observe(handle);
        return Object.freeze({ status: "restarted", pid: handle.pid, oldStopped: true });
      } catch (error) { return Object.freeze({ status: "failed", pid: null, oldStopped: true, error }); }
    });
  }
  #observe(handle: ProcessHandle): void {
    void handle.closed.then(exit => {
      if (this.#handle !== handle) return;
      this.#exit = exit;
      if (this.#state !== "restart-required") this.#state = "stopped";
    }, () => { if (this.#handle === handle) this.#state = "restart-required"; });
  }
  async #stop(): Promise<ProcessStopResult> {
    const errors: unknown[] = [];
    const result = (status: ProcessStopResult["status"]): ProcessStopResult => Object.freeze({ status, pid: this.#handle.pid, exit: this.#exit, errors: Object.freeze(errors) });
    if (this.#state === "restart-required") return result("restart-required");
    if (this.#exit) return result("stopped");
    for (const [signal, timeout] of [["SIGTERM", this.termTimeoutMs], ["SIGKILL", this.killTimeoutMs]] as const) {
      try { this.#handle.signal(signal); } catch (error) { errors.push(error); }
      try {
        this.#exit = await deadline(this.#handle.closed, timeout, "PROCESS_STOP_TIMEOUT", `Process ${this.#handle.pid} did not confirm closure after ${signal}`);
        this.#state = "stopped"; return result("stopped");
      } catch (error) { errors.push(error); }
    }
    this.#state = "restart-required";
    return result("restart-required");
  }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.#tail.then(operation); this.#tail = work.then(() => {}, () => {}); return work;
  }
}

function validateSpec(spec: ProcessSpec): ProcessSpec {
  if (!spec || typeof spec.command !== "string" || !spec.command.trim() || !Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== "string")) fail("INVALID_CONFIG", "Process requires a command and string arguments");
  return immutable(spec);
}
