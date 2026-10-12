import { randomUUID } from "node:crypto";
import { isAbsolute, posix, resolve } from "node:path";
import { HarnessError, fail } from "../errors.js";
import { positive } from "../pipeline-control.js";
import { deadline } from "../deadline.js";
import { immutable } from "../json.js";
import { dockerCliDriver, type DockerAttachment, type DockerDriver } from "./docker-driver.js";
import { createWorkspaceSnapshot } from "./workspace.js";
import type { SandboxCommandResult, SandboxProcessIO, SandboxProcessRequest, SandboxProcessResult, SandboxService } from "./types.js";

export interface DockerProcessSandboxOptions {
  /** Trusted, locally provisioned Node image. Automatic image pulls are disabled. */
  readonly image: string;
  readonly workspace?: string;
  readonly memoryMiB?: number; readonly cpus?: number; readonly pids?: number; readonly tmpMiB?: number;
  readonly workspaceMiB?: number; readonly maxWorkspaceBytes?: number; readonly maxWorkspaceFiles?: number;
  readonly commandTimeoutMs?: number; readonly maxTransferBytes?: number;
  readonly timeoutMs?: number; readonly maxOutputBytes?: number; readonly maxInputBytes?: number; readonly concurrency?: number;
}
type Limits = Required<Omit<DockerProcessSandboxOptions, "workspace">>;
type Reason = SandboxProcessResult["reason"];
interface Active { readonly abort: () => void; readonly done: Promise<void> }

// This bootstrap runs inside the OS sandbox. It is not itself an isolation boundary.
// The Host snapshot is read-only; builds/tests operate on a disposable tmpfs copy.
const workspaceBootstrap = String.raw`
const fs = require('node:fs'), {spawn} = require('node:child_process');
const spec = JSON.parse(process.argv[1]);
try {
  fs.cpSync('/input', '/workspace', {recursive:true, verbatimSymlinks:true});
  function writable(path) {
    const info = fs.lstatSync(path);
    if (info.isSymbolicLink()) return;
    fs.chmodSync(path, info.mode | 0o600 | (info.isDirectory() ? 0o100 : 0));
    if (info.isDirectory()) for (const name of fs.readdirSync(path)) writable(path + '/' + name);
  }
  writable('/workspace');
  const child = spawn(spec.command, spec.args, {cwd:spec.cwd, env:process.env, shell:false, stdio:'inherit'});
  child.on('error', () => { console.error('SANDBOX_COMMAND_SPAWN_FAILED'); process.exitCode = 127; });
  child.on('exit', code => { process.exitCode = code ?? 128; });
} catch (error) { console.error('SANDBOX_WORKSPACE_PREPARE_FAILED: ' + (error.code || 'UNKNOWN')); process.exitCode = 126; }
`;

/** Fresh containers, bounded I/O, and daemon-acknowledged cleanup shared by commands and PTC. */
export class DockerProcessSandbox implements SandboxService {
  readonly #active = new Map<string, Active>();
  readonly #unresolved = new Set<string>();
  readonly #retained = new Map<string, readonly string[]>();
  readonly #options: Limits;
  readonly #workspace: string | undefined;
  #closed = false;
  constructor(options: DockerProcessSandboxOptions, readonly driver: DockerDriver = dockerCliDriver()) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(options.image)) fail("INVALID_IMAGE", "Use a trusted, digest-pinned image");
    if (options.workspace !== undefined && (!isAbsolute(options.workspace) || options.workspace.includes("\0"))) fail("INVALID_WORKSPACE", "Sandbox workspace must be an absolute Host path");
    this.#workspace = options.workspace === undefined ? undefined : resolve(options.workspace);
    this.#options = Object.freeze({ image: options.image, memoryMiB: options.memoryMiB ?? 128, cpus: options.cpus ?? 1,
      pids: options.pids ?? 32, tmpMiB: options.tmpMiB ?? 16, workspaceMiB: options.workspaceMiB ?? 128,
      maxWorkspaceBytes: options.maxWorkspaceBytes ?? 64 * 1024 * 1024, maxWorkspaceFiles: options.maxWorkspaceFiles ?? 20_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 5_000, maxTransferBytes: options.maxTransferBytes ?? 1024 * 1024,
      timeoutMs: options.timeoutMs ?? 60_000, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
      maxInputBytes: options.maxInputBytes ?? options.maxTransferBytes ?? 1024 * 1024, concurrency: options.concurrency ?? 4 });
    for (const [key, value] of Object.entries(this.#options)) if (typeof value === "number") positive(value, key);
    if (this.#options.maxWorkspaceBytes > this.#options.workspaceMiB * 1024 * 1024) fail("INVALID_LIMIT", "Workspace input must fit its tmpfs size");
  }
  get configuration() { return immutable({ ...this.#options, ...(this.#workspace === undefined ? {} : { workspace: this.#workspace }) }); }
  get profile() { return this.#profile(this.#workspace !== undefined); }
  #profile(workspace: boolean) {
    return immutable({ backend: "docker-restricted-v2", ...this.#options,
      workspace: workspace ? { mode: "filtered-snapshot", root: this.#workspace!, hostWrites: false, credentials: "excluded", maxBytes: this.#options.maxWorkspaceBytes } : { mode: "none", hostWrites: false },
      hostMounts: workspace ? [{ target: "/input", access: "read-only", source: "filtered-snapshot" }] : [],
      network: "none", root: "read-only", user: "65534:65534", capabilities: [], seccomp: "required",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" } });
  }
  health() { return immutable({ active: [...this.#active.keys()], unresolved: [...this.#unresolved], closed: this.#closed,
    details: [...this.#unresolved].map(id => ({ id, pid: null, retainedPaths: this.#retained.get(id) ?? [] })),
  }); }
  async close(): Promise<void> {
    this.#closed = true;
    for (const active of this.#active.values()) active.abort();
    await Promise.allSettled([...this.#active.values()].map(active => active.done));
    if (this.#unresolved.size) fail("RESTART_REQUIRED", "Sandbox cleanup unconfirmed; reconcile containers reported by health() before restarting");
  }
  async execute(request: SandboxProcessRequest): Promise<SandboxCommandResult> {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const result = await this.run(request, { stdout: chunk => stdout.push(chunk), stderr: chunk => stderr.push(chunk) });
    return { ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  }
  async run(request: SandboxProcessRequest, io: SandboxProcessIO = {}): Promise<SandboxProcessResult> {
    if (this.#unresolved.size) fail("RESTART_REQUIRED", "Previous sandbox cleanup is unconfirmed");
    if (this.#closed) fail("SANDBOX_CLOSED", "Sandbox service is closed");
    if (this.#active.size >= this.#options.concurrency) fail("SANDBOX_BUSY", "Sandbox concurrency limit reached");
    const options = this.#options;
    const bounded = (value: number | undefined, ceiling: number, name: string) => value === undefined ? ceiling : Math.min(positive(value, name), ceiling);
    const timeoutMs = bounded(request.timeoutMs, options.timeoutMs, "timeoutMs");
    const maxOutput = bounded(request.maxOutputBytes, options.maxOutputBytes, "maxOutputBytes");
    const maxInput = bounded(request.maxInputBytes, options.maxInputBytes, "maxInputBytes");
    if (typeof request.command !== "string" || !request.command || request.command.includes("\0") || !Array.isArray(request.args) || request.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) fail("INVALID_COMMAND", "Use an executable and a string argv array");
    request = Object.freeze({ ...request, args: Object.freeze([...request.args]) });
    if (Buffer.byteLength(JSON.stringify([request.command, request.args])) > maxInput) fail("INPUT_LIMIT", "Sandbox command exceeds input limit");
    if (request.workspace !== undefined && request.workspace !== "none" && request.workspace !== "snapshot") fail("INVALID_WORKSPACE", "Unknown workspace mode");
    const workspace = request.workspace === "snapshot";
    if (workspace && this.#workspace === undefined) fail("INVALID_WORKSPACE", "This sandbox has no configured workspace");
    const cwd = request.cwd ?? (workspace ? "/workspace" : "/tmp");
    if (!posix.isAbsolute(cwd) || cwd.includes("\0") || posix.normalize(cwd) !== cwd || (workspace && cwd !== "/workspace" && !cwd.startsWith("/workspace/")) || (!workspace && cwd !== "/tmp")) fail("INVALID_CWD", "Sandbox cwd must be within its declared workspace, or /tmp without a workspace");
    const name = `minicah-sandbox-${randomUUID()}`, controller = new AbortController();
    const profile = immutable({ ...this.#profile(workspace), timeoutMs, maxInputBytes: maxInput, maxOutputBytes: maxOutput });
    let reason: Reason = "exit", code: string | null = null, exitCode: number | null = null;
    let finish!: () => void, wake!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const stopped = new Promise<null>(resolve => { wake = () => resolve(null); });
    const stop = (why: Reason, diagnostic: string) => {
      if (controller.signal.aborted) return;
      reason = why; code = diagnostic; controller.abort(); wake();
      try { io.stopped?.(why); } catch { /* Stopping and cleanup must continue even if a consumer fails. */ }
    };
    const abort = () => stop("cancelled", "CANCELLED");
    this.#active.set(name, { abort, done });
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    const timer = setTimeout(() => stop("timeout", "DEADLINE_EXCEEDED"), timeoutMs);
    const command = (args: readonly string[]) => this.driver.command(args, options.commandTimeoutMs);
    let attempted = false, createUncertain = false, attachment: DockerAttachment | undefined;
    let snapshot: Awaited<ReturnType<typeof createWorkspaceSnapshot>> | undefined;
    let cleanup: SandboxProcessResult["cleanup"] = "verified", outputBytes = 0, inputBytes = 0, accepting = true;
    const output = (chunk: Buffer, channel: "stdout" | "stderr") => {
      if (!accepting || controller.signal.aborted) return;
      const available = Math.max(0, maxOutput - outputBytes); outputBytes += chunk.byteLength;
      try { if (available) io[channel]?.(chunk.subarray(0, available)); }
      catch { stop("io-failed", "SANDBOX_IO_FAILED"); }
      if (outputBytes > maxOutput) stop("output-limit", "OUTPUT_LIMIT");
    };
    try {
      if (!controller.signal.aborted) {
        const info = await command(["info", "--format", "{{json .}}"]);
        if (info.code !== 0) fail("ISOLATION_UNAVAILABLE", "Docker daemon unavailable");
        const daemon = JSON.parse(info.stdout) as { OSType?: string; SecurityOptions?: string[] };
        if (daemon.OSType !== "linux" || !daemon.SecurityOptions?.some(value => value.startsWith("name=seccomp") && !value.includes("unconfined"))) fail("ISOLATION_UNAVAILABLE", "Linux seccomp isolation required");
        if (!controller.signal.aborted && !this.#unresolved.size) {
          const inspected = await command(["image", "inspect", "--format", "{{json .Config}}", options.image]);
          if (inspected.code !== 0) fail("ISOLATION_UNAVAILABLE", "Pinned image must already be provisioned");
          const image = JSON.parse(inspected.stdout) as { Volumes?: Record<string, unknown> | null };
          if (image.Volumes && Object.keys(image.Volumes).length) fail("UNSAFE_IMAGE", "Runtime image must not declare implicit volumes");
        }
        if (workspace && !controller.signal.aborted) snapshot = await createWorkspaceSnapshot(this.#workspace!, { maxBytes: options.maxWorkspaceBytes, maxFiles: options.maxWorkspaceFiles, signal: controller.signal });
        if (!controller.signal.aborted) {
          const workspaceFlags = snapshot ? ["--mount", `type=bind,source=${snapshot.input},target=/input,readonly,bind-recursive=disabled`, `--tmpfs=/workspace:rw,nosuid,nodev,size=${options.workspaceMiB}m,mode=0700,uid=65534,gid=65534`] : [];
          const argv = snapshot ? ["/usr/local/bin/node", "-e", workspaceBootstrap, JSON.stringify({ command: request.command, args: request.args, cwd })] : [request.command, ...request.args];
          attempted = true; createUncertain = true;
          const made = await command(["create", "--name", name, "--pull=never", "--interactive", "--init", "--network=none", "--ipc=none", "--read-only",
            "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--user=65534:65534", `--workdir=${snapshot ? "/tmp" : cwd}`,
            `--memory=${options.memoryMiB}m`, `--memory-swap=${options.memoryMiB}m`, `--cpus=${options.cpus}`, `--pids-limit=${options.pids}`,
            "--ulimit=nofile=64:64", `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=${options.tmpMiB}m,mode=1777`, "--log-driver=none", "--no-healthcheck", ...workspaceFlags,
            "--entrypoint=/usr/bin/env", options.image, "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", ...argv]);
          if (made.code !== 0) fail("CREATE_UNCONFIRMED", "Container creation failed; reconcile daemon state");
          createUncertain = false;
          if (!controller.signal.aborted) {
            attachment = this.driver.attach(["start", "--attach", "--interactive", name], chunk => output(chunk, "stdout"), chunk => output(chunk, "stderr"));
            const control = {
              write: (data: string) => {
                if (!accepting || controller.signal.aborted) return;
                inputBytes += Buffer.byteLength(data);
                if (inputBytes > maxInput) { stop("input-limit", "INPUT_LIMIT"); return; }
                try { attachment!.write(data); } catch { stop("io-failed", "SANDBOX_IO_FAILED"); }
              },
              endInput: () => { if (accepting) { try { attachment!.endInput(); } catch { stop("io-failed", "SANDBOX_IO_FAILED"); } } },
              terminate: abort,
            };
            try { if (io.started) io.started(control); else control.endInput(); }
            catch { stop("io-failed", "SANDBOX_IO_FAILED"); }
            exitCode = await Promise.race([attachment.closed, stopped]);
            if (exitCode === -1 && !controller.signal.aborted) { reason = "spawn-failed"; code = "SANDBOX_ATTACH_FAILED"; }
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) { reason = "spawn-failed"; code = error instanceof HarnessError ? error.code : "ISOLATION_UNAVAILABLE"; }
    } finally {
      accepting = false; clearTimeout(timer); request.signal?.removeEventListener("abort", abort);
      if (attempted) {
        try {
          // Killing an attached CLI does not kill its container. Require daemon acknowledgement.
          const removed = await command(["rm", "--force", "--volumes", name]);
          if (removed.code !== 0 || createUncertain) cleanup = "unconfirmed";
          if (attachment) await deadline(attachment.closed, options.commandTimeoutMs, "CLEANUP_UNCONFIRMED", "Docker attachment remains open");
        } catch { cleanup = "unconfirmed"; attachment?.killClient(); }
      }
      // Preserve the staged mount if a live container might still reference it.
      if (snapshot && cleanup === "verified") { try { await snapshot.dispose(); } catch { cleanup = "unconfirmed"; } }
      if (cleanup === "unconfirmed") {
        this.#unresolved.add(name);
        if (snapshot) this.#retained.set(name, Object.freeze([snapshot.directory]));
        for (const [id, active] of this.#active) if (id !== name) active.abort();
      }
      this.#active.delete(name); finish();
    }
    return { id: name, exitCode, reason, cleanup, code: cleanup === "unconfirmed" ? "CLEANUP_UNCONFIRMED" : code,
      profile: cleanup === "unconfirmed" ? immutable({ ...profile, retainedPaths: this.#retained.get(name) ?? [] }) : profile,
    };
  }
}
