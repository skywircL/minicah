import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, opendir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { deadline } from "../deadline.js";
import { fail, HarnessError } from "../errors.js";
import { immutable } from "../json.js";
import { positive } from "../pipeline-control.js";
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from "./workspace.js";
import type { SandboxCommandResult, SandboxProcessIO, SandboxProcessRequest, SandboxProcessResult, SandboxService } from "./types.js";

export interface SeatbeltProcessSandboxOptions {
  readonly workspace?: string;
  /** Trusted executable; its Mach-O dependencies are discovered without executing it. */
  readonly nodeExecutable?: string;
  /** Explicit trusted read grants. These are never inferred from the caller's HOME or PATH. */
  readonly runtimeReadPaths?: readonly string[];
  readonly timeoutMs?: number; readonly cleanupMs?: number;
  readonly maxInputBytes?: number; readonly maxOutputBytes?: number; readonly concurrency?: number;
  readonly maxWorkspaceBytes?: number; readonly maxWorkspaceFiles?: number;
}
type Options = Required<Omit<SeatbeltProcessSandboxOptions, "workspace">>;
type Reason = SandboxProcessResult["reason"];
export interface SeatbeltRuntime { readonly nodeExecutable: string; readonly readFiles: readonly string[]; readonly readDirectories: readonly string[] }
export interface SeatbeltAttachment {
  readonly pid?: number;
  readonly closed: Promise<{ readonly exitCode: number | null; readonly failed: boolean }>;
  write(data: string): void; endInput(): void; terminate(): void;
}
/** Trusted transport seam for deterministic lifecycle tests; never model-controlled. */
export interface SeatbeltDriver {
  readonly platform: NodeJS.Platform;
  prepare(nodeExecutable: string, readPaths: readonly string[]): Promise<SeatbeltRuntime>;
  spawn(spec: { readonly profile: string; readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly env: NodeJS.ProcessEnv },
    io: { stdout(chunk: Buffer): void; stderr(chunk: Buffer): void; failed(): void }): SeatbeltAttachment;
}
const systemReadRoots = ["/System/Library", "/usr/lib", "/bin", "/usr/bin"] as const;
const systemPath = (path: string): boolean => systemReadRoots.some(root => path === root || path.startsWith(root + "/"));
const execFileAsync = promisify(execFile);
const quote = (path: string): string => JSON.stringify(path);
const safePath = (path: unknown): path is string => typeof path === "string" && isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path);

/** Exact Node/dylib grants, including symlink spellings dyld may resolve itself. */
async function prepareRuntime(executable: string, extra: readonly string[]): Promise<SeatbeltRuntime> {
  const expires = Date.now() + 10_000;
  const remaining = (): number => {
    const time = expires - Date.now();
    if (time <= 0) fail("ISOLATION_UNAVAILABLE", "Node runtime inspection exceeded its deadline");
    return time;
  };
  await access("/usr/bin/sandbox-exec");
  const nodeExecutable = await realpath(executable), files = new Set<string>(), directories = new Set<string>(systemReadRoots);
  const queue = [nodeExecutable], inspected = new Set<string>();
  const inspect = async (flag: "-L" | "-l", path: string) => (await execFileAsync("/usr/bin/otool", [flag, path], {
    env: { PATH: "/usr/bin:/bin" }, timeout: Math.min(5000, remaining()), killSignal: "SIGKILL", maxBuffer: 256 * 1024,
  })).stdout;
  while (queue.length) {
    remaining();
    const path = queue.shift()!;
    if (systemPath(path)) continue;
    const actual = await realpath(path);
    files.add(path); files.add(actual);
    if (inspected.has(actual)) continue;
    inspected.add(actual);
    if (inspected.size > 128) fail("ISOLATION_UNAVAILABLE", "Node runtime dependency graph exceeds its bound");
    const linked = await inspect("-L", actual);
    let search: string[] | undefined;
    for (const line of linked.split("\n").slice(1)) {
      const match = /^\s+(.+?) \(compatibility version /.exec(line);
      if (!match) continue;
      let dependency = match[1]!;
      const expand = (value: string) => value.startsWith("@loader_path/") ? resolve(dirname(actual), value.slice(13))
        : value.startsWith("@executable_path/") ? resolve(dirname(nodeExecutable), value.slice(17)) : value;
      dependency = expand(dependency);
      if (dependency.startsWith("@rpath/")) {
        search ??= [...(await inspect("-l", actual)).matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)].map(match => expand(match[1]!));
        let found: string | undefined;
        for (const directory of search) {
          const candidate = resolve(directory, dependency.slice(7));
          try { await access(candidate); found = candidate; break; } catch { /* Try the next explicit Mach-O rpath. */ }
        }
        if (!found) fail("ISOLATION_UNAVAILABLE", "Node has an unresolved dynamic library rpath");
        dependency = found;
      }
      if (!safePath(dependency)) fail("ISOLATION_UNAVAILABLE", "Node has an unsupported dynamic library path");
      if (!systemPath(dependency) && !files.has(dependency)) queue.push(dependency);
    }
  }
  // literal directory grants expose only that directory's names, not its subtree.
  for (const path of [...files]) {
    remaining();
    const parent = await realpath(dirname(path));
    files.add(join(parent, basename(path))); files.add(parent);
    if ((await lstat(path)).isSymbolicLink()) files.add(resolve(dirname(path), await readlink(path)));
    for (let part = dirname(path); part !== "/"; part = dirname(part)) {
      if ((await lstat(part)).isSymbolicLink()) files.add(part);
    }
  }
  for (const path of extra) {
    remaining();
    const actual = await realpath(path);
    if ((await lstat(actual)).isDirectory()) directories.add(actual); else files.add(actual);
  }
  // macOS's sh chooses its implementation using this OS-owned selector.
  files.add("/private/var/select/sh"); files.add("/var/select/sh");
  return { nodeExecutable, readFiles: [...files].sort(), readDirectories: [...directories].sort() };
}

export function seatbeltProcessDriver(): SeatbeltDriver {
  return { platform: process.platform, prepare: prepareRuntime,
    spawn(spec, io) {
      const child = spawn("/usr/bin/sandbox-exec", ["-p", spec.profile, spec.command, ...spec.args], {
        cwd: spec.cwd, env: spec.env, shell: false, stdio: ["pipe", "pipe", "pipe"],
      });
      let failed = false;
      const closed = new Promise<{ exitCode: number | null; failed: boolean }>(resolve => {
        child.on("error", () => { failed = true; io.failed(); });
        child.on("close", exitCode => resolve({ exitCode, failed }));
      });
      child.stdout.on("data", io.stdout); child.stderr.on("data", io.stderr);
      child.stdin.on("error", () => { failed = true; io.failed(); });
      return { ...(child.pid ? { pid: child.pid } : {}), closed, write(data) { child.stdin.write(data); }, endInput() { child.stdin.end(); },
        // fork/posix_spawn are denied by Seatbelt; exec replacement keeps this PID.
        terminate() { child.kill("SIGKILL"); },
      };
    },
  };
}

/** No blanket reads of HOME, /private, Homebrew, or the original workspace. */
export function seatbeltProfile(runtime: SeatbeltRuntime, writable: readonly string[]): string {
  return ["(version 1)", "(deny default)", "(allow process-exec)", "(deny process-fork)",
    // Explicitly needed on macOS: deny-default alone does not block KERN_PROCARGS2.
    "(deny process-info*)",
    "(allow file-read* (literal \"/\"))", "(allow file-read-metadata (vnode-type DIRECTORY))",
    "(allow sysctl-read (sysctl-name-prefix \"hw.\") (sysctl-name-prefix \"machdep.cpu.\") (sysctl-name \"kern.osrelease\") (sysctl-name \"kern.ostype\") (sysctl-name \"kern.osversion\") (sysctl-name \"kern.version\") (sysctl-name \"kern.hostname\") (sysctl-name \"kern.maxfilesperproc\"))",
    "(allow file-read* (literal \"/dev/random\") (literal \"/dev/urandom\"))",
    "(allow file-read* file-write* (literal \"/dev/null\") (literal \"/dev/stdout\") (literal \"/dev/stderr\"))",
    ...runtime.readDirectories.map(path => `(allow file-read* (subpath ${quote(path)}))`),
    ...runtime.readFiles.map(path => `(allow file-read* (literal ${quote(path)}))`),
    ...writable.map(path => `(allow file-read* file-write* (subpath ${quote(path)}))`),
  ].join("\n");
}

async function makeWritable(path: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) fail("CANCELLED", "Snapshot preparation cancelled");
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  await chmod(path, info.isDirectory() ? 0o700 : 0o600 | (info.mode & 0o111));
  if (!info.isDirectory()) return;
  const directory = await opendir(path);
  for await (const entry of directory) await makeWritable(join(path, entry.name), signal);
}

/** macOS strict single-process sandbox: no fork, no network, disposable file writes. */
export class SeatbeltProcessSandbox implements SandboxService {
  readonly #options: Options;
  readonly #workspace: string | undefined;
  readonly #active = new Map<string, { abort(): void; done: Promise<void> }>();
  readonly #unresolved = new Set<string>();
  readonly #details = new Map<string, { id: string; pid: number | null; retainedPaths: readonly string[] }>();
  #runtime: Promise<SeatbeltRuntime> | undefined;
  #closed = false;
  constructor(options: SeatbeltProcessSandboxOptions = {}, readonly driver: SeatbeltDriver = seatbeltProcessDriver()) {
    if (options.workspace !== undefined && !safePath(options.workspace)) fail("INVALID_WORKSPACE", "Sandbox workspace must be an absolute Host path");
    const nodeExecutable = options.nodeExecutable ?? process.execPath, readPaths = options.runtimeReadPaths ?? [];
    if (!safePath(nodeExecutable) || !Array.isArray(readPaths) || readPaths.length > 128 || readPaths.some(path => !safePath(path))) fail("INVALID_CONFIG", "Runtime paths must be bounded absolute trusted paths");
    this.#workspace = options.workspace === undefined ? undefined : resolve(options.workspace);
    this.#options = Object.freeze({ nodeExecutable, runtimeReadPaths: Object.freeze([...readPaths]),
      timeoutMs: options.timeoutMs ?? 60_000, cleanupMs: options.cleanupMs ?? 2500,
      maxInputBytes: options.maxInputBytes ?? 1024 * 1024, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
      concurrency: options.concurrency ?? 4, maxWorkspaceBytes: options.maxWorkspaceBytes ?? 64 * 1024 * 1024, maxWorkspaceFiles: options.maxWorkspaceFiles ?? 20_000,
    });
    for (const [key, value] of Object.entries(this.#options)) if (typeof value === "number") positive(value, key);
  }
  get configuration() { return immutable({ ...this.#options, ...(this.#workspace === undefined ? {} : { workspace: this.#workspace }) }); }
  get profile() { return this.#profile(this.#workspace !== undefined); }
  #profile(workspace: boolean, runtime?: SeatbeltRuntime) {
    return immutable({ backend: "macos-seatbelt-single-process-v1", ...this.#options,
      workspace: workspace ? { mode: "filtered-snapshot", root: this.#workspace!, hostWrites: false, credentials: "excluded" } : { mode: "none", hostWrites: false },
      process: "single-process", fork: "denied", exec: "same-pid-replacement", network: "none", unixSockets: "denied", machServices: "denied",
      filesystem: { reads: runtime ? { files: runtime.readFiles, directories: runtime.readDirectories } : { files: "resolved-node-and-dylib-files", directories: systemReadRoots },
        directoryMetadata: "allowed", rootDirectoryListing: "allowed", writes: "private-per-invocation-copy-and-temp" },
      env: { PATH: "trusted-node-bin:/usr/bin:/bin", HOME: "private-temp", TMPDIR: "private-temp", OPENSSL_CONF: "/dev/null" },
      limits: { deadline: true, inputOutputBytes: true, concurrentProcesses: true, workspaceInputBytes: true, cpu: false, totalMemory: false, aggregateDiskBytes: false, threadCount: false },
    });
  }
  health() { return immutable({ active: [...this.#active.keys()], unresolved: [...this.#unresolved], closed: this.#closed, details: [...this.#details.values()] }); }
  async close(): Promise<void> {
    this.#closed = true;
    for (const active of this.#active.values()) active.abort();
    await Promise.allSettled([...this.#active.values()].map(active => active.done));
    if (this.#runtime) await Promise.allSettled([this.#runtime]);
    if (this.#unresolved.size) fail("RESTART_REQUIRED", "Seatbelt process or temporary resource cleanup remains unconfirmed");
  }
  async execute(request: SandboxProcessRequest): Promise<SandboxCommandResult> {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const result = await this.run(request, { stdout: data => stdout.push(data), stderr: data => stderr.push(data) });
    return { ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  }
  async run(request: SandboxProcessRequest, io: SandboxProcessIO = {}): Promise<SandboxProcessResult> {
    if (this.#unresolved.size) fail("RESTART_REQUIRED", "Prior Seatbelt cleanup is unconfirmed");
    if (this.#closed) fail("SANDBOX_CLOSED", "Sandbox is closed");
    if (this.#active.size >= this.#options.concurrency) fail("SANDBOX_BUSY", "Sandbox concurrency limit reached");
    if (this.driver.platform !== "darwin") fail("ISOLATION_UNAVAILABLE", "Native Seatbelt requires macOS");
    const bounded = (value: number | undefined, ceiling: number, name: string) => value === undefined ? ceiling : Math.min(positive(value, name), ceiling);
    const timeoutMs = bounded(request.timeoutMs, this.#options.timeoutMs, "timeoutMs"), maxInput = bounded(request.maxInputBytes, this.#options.maxInputBytes, "maxInputBytes"), maxOutput = bounded(request.maxOutputBytes, this.#options.maxOutputBytes, "maxOutputBytes");
    if (typeof request.command !== "string" || !request.command || request.command.includes("\0") || !Array.isArray(request.args) || request.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) fail("INVALID_COMMAND", "Use an executable and a string argv array");
    const requestedCommand = request.command, args = Object.freeze([...request.args]), signal = request.signal;
    if (Buffer.byteLength(JSON.stringify([requestedCommand, args])) > maxInput) fail("INPUT_LIMIT", "Sandbox command exceeds input limit");
    if (request.workspace !== undefined && request.workspace !== "none" && request.workspace !== "snapshot") fail("INVALID_WORKSPACE", "Unknown workspace mode");
    const workspace = request.workspace === "snapshot", virtualCwd = request.cwd ?? (workspace ? "/workspace" : "/tmp");
    if (workspace && !this.#workspace) fail("INVALID_WORKSPACE", "No workspace configured");
    if (!posix.isAbsolute(virtualCwd) || virtualCwd.includes("\0") || posix.normalize(virtualCwd) !== virtualCwd || (workspace ? virtualCwd !== "/workspace" && !virtualCwd.startsWith("/workspace/") : virtualCwd !== "/tmp")) fail("INVALID_CWD", "cwd must be in its declared workspace, or /tmp without a workspace");
    const id = `minicah-native-${randomUUID()}`, controller = new AbortController();
    let reason: Reason = "exit", code: string | null = null, exitCode: number | null = null, cleanup: SandboxProcessResult["cleanup"] = "verified";
    let runtime: SeatbeltRuntime | undefined, attachment: SeatbeltAttachment | undefined, snapshot: WorkspaceSnapshot | undefined, temporary: string | undefined;
    let finish!: () => void, wake!: () => void, accepting = true, outputBytes = 0, inputBytes = 0;
    const done = new Promise<void>(resolve => { finish = resolve; }), stopped = new Promise<null>(resolve => { wake = () => resolve(null); });
    const stop = (why: Reason, diagnostic: string) => {
      if (controller.signal.aborted) return;
      reason = why; code = diagnostic; controller.abort(); wake();
      try { io.stopped?.(why); } catch { /* Cleanup must continue if its consumer fails. */ }
      try { attachment?.terminate(); } catch { /* Actual close is the cleanup proof. */ }
    };
    const abort = () => stop("cancelled", "CANCELLED");
    this.#active.set(id, { abort, done }); signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop("timeout", "DEADLINE_EXCEEDED"), timeoutMs);
    const output = (chunk: Buffer, channel: "stdout" | "stderr") => {
      if (!accepting || controller.signal.aborted) return;
      const remaining = Math.max(0, maxOutput - outputBytes); outputBytes += chunk.byteLength;
      try { if (remaining) io[channel]?.(chunk.subarray(0, remaining)); } catch { stop("io-failed", "SANDBOX_IO_FAILED"); }
      if (outputBytes > maxOutput) stop("output-limit", "OUTPUT_LIMIT");
    };
    try {
      if (!controller.signal.aborted) {
        this.#runtime ??= this.driver.prepare(this.#options.nodeExecutable, this.#options.runtimeReadPaths);
        runtime = await Promise.race([this.#runtime, stopped.then(() => undefined)]);
        if (workspace && !controller.signal.aborted) {
          snapshot = await createWorkspaceSnapshot(this.#workspace!, { maxBytes: this.#options.maxWorkspaceBytes, maxFiles: this.#options.maxWorkspaceFiles, signal: controller.signal });
          await makeWritable(snapshot.input, controller.signal);
        }
        if (runtime && !controller.signal.aborted) {
          temporary = await realpath(await mkdtemp(join(tmpdir(), "minicah-native-")));
          await chmod(temporary, 0o700);
          const home = join(temporary, "home"), temp = join(temporary, "tmp");
          await mkdir(home, { mode: 0o700 }); await mkdir(temp, { mode: 0o700 });
          const workspaceRoot = snapshot ? await realpath(snapshot.input) : undefined;
          const cwd = workspaceRoot ? join(workspaceRoot, ...virtualCwd.slice("/workspace".length).split("/").filter(Boolean)) : temp;
          if (!(await lstat(cwd)).isDirectory()) fail("INVALID_CWD", "Sandbox cwd is not a directory");
          if (workspaceRoot) for (let part = cwd; part !== workspaceRoot; part = dirname(part)) if ((await lstat(part)).isSymbolicLink()) fail("INVALID_CWD", "Sandbox cwd cannot contain a symlink");
          let command: string;
          if (requestedCommand === "node" || requestedCommand === runtime.nodeExecutable || requestedCommand === this.#options.nodeExecutable) command = runtime.nodeExecutable;
          else if (/^\/(?:usr\/)?bin\/[^/]+$/.test(requestedCommand)) command = requestedCommand;
          else if (!requestedCommand.includes("/") && !requestedCommand.includes(sep)) {
            command = `/usr/bin/${requestedCommand}`;
            try { await access(command); } catch { command = `/bin/${requestedCommand}`; await access(command); }
          } else fail("INVALID_COMMAND", "Native commands must use Node or an OS-owned /bin or /usr/bin executable");
          if (!controller.signal.aborted) {
            attachment = this.driver.spawn({ command, args, cwd, profile: seatbeltProfile(runtime, [...(workspaceRoot ? [workspaceRoot] : []), temporary]),
              env: { PATH: `${dirname(runtime.nodeExecutable)}:/usr/bin:/bin`, HOME: home, TMPDIR: temp, OPENSSL_CONF: "/dev/null" },
            }, { stdout: data => output(data, "stdout"), stderr: data => output(data, "stderr"), failed: () => stop("spawn-failed", "SANDBOX_PROCESS_FAILED") });
            const control = { write: (data: string) => {
              if (!accepting || controller.signal.aborted) return;
              inputBytes += Buffer.byteLength(data);
              if (inputBytes > maxInput) { stop("input-limit", "INPUT_LIMIT"); return; }
              try { attachment!.write(data); } catch { stop("io-failed", "SANDBOX_IO_FAILED"); }
            }, endInput: () => { if (accepting) try { attachment!.endInput(); } catch { stop("io-failed", "SANDBOX_IO_FAILED"); } }, terminate: abort };
            try { if (io.started) io.started(control); else control.endInput(); } catch { stop("io-failed", "SANDBOX_IO_FAILED"); }
            const result = await Promise.race([attachment.closed, stopped]);
            if (result) { exitCode = result.exitCode; if (result.failed && !controller.signal.aborted) { reason = "spawn-failed"; code = "SANDBOX_PROCESS_FAILED"; } }
          }
        }
      }
    } catch (error) { if (!controller.signal.aborted) { reason = "spawn-failed"; code = error instanceof HarnessError ? error.code : "ISOLATION_UNAVAILABLE"; } }
    finally {
      accepting = false; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (attachment) {
        try {
          if (controller.signal.aborted) attachment.terminate();
          const result = await deadline(attachment.closed, this.#options.cleanupMs, "CLEANUP_UNCONFIRMED", "Native process has not exited");
          exitCode ??= result.exitCode;
        } catch { cleanup = "unconfirmed"; }
      }
      // Never remove files still reachable by a process whose termination is unproven.
      if (cleanup === "verified") {
        try { await snapshot?.dispose(); if (temporary) await rm(temporary, { recursive: true, force: true }); } catch { cleanup = "unconfirmed"; }
      }
      if (cleanup === "unconfirmed") {
        this.#unresolved.add(id);
        this.#details.set(id, { id, pid: attachment?.pid ?? null, retainedPaths: [...(snapshot ? [snapshot.directory] : []), ...(temporary ? [temporary] : [])] });
        for (const [other, active] of this.#active) if (other !== id) active.abort();
      }
      this.#active.delete(id); finish();
    }
    return { id, exitCode, reason, cleanup, code: cleanup === "unconfirmed" ? "CLEANUP_UNCONFIRMED" : code,
      profile: immutable({ ...this.#profile(workspace, runtime), timeoutMs, maxInputBytes: maxInput, maxOutputBytes: maxOutput, processId: attachment?.pid ?? null,
        ...(cleanup === "unconfirmed" ? { retainedPaths: this.#details.get(id)!.retainedPaths } : {}),
      }),
    };
  }
}
