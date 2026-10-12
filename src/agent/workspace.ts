import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, opendirSync, realpathSync, renameSync, unlinkSync, writeFileSync, linkSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { API_VERSION, serviceToken, type JsonValue, type Plugin } from "../types.js";
import { contentHash } from "../json.js";
import { fail, HarnessError } from "../errors.js";
import { services } from "../services.js";

const MAX_FILE = 512 * 1024;
const skipped = new Set(["node_modules", "dist", "coverage", ".idea", ".next", ".venv"]);
function protectedPart(part: string): boolean { return /^(\.git|\.minicah|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.netrc|id_rsa|id_ed25519)$/i.test(part); }
function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) fail("CANCELLED", "Operation cancelled"); }

/** Native workspace policy, not an OS security boundary against concurrent hostile filesystem mutation. */
export class Workspace {
  readonly root: string;
  readonly #identity: { dev: number; ino: number };
  constructor(root: string) {
    this.root = realpathSync(root);
    const stat = lstatSync(this.root);
    if (!stat.isDirectory()) fail("WORKSPACE_PATH", "Workspace must be a directory");
    this.#identity = { dev: stat.dev, ino: stat.ino };
  }
  path(path: string, allowMissing = false): string {
    const root = lstatSync(this.root);
    if (root.isSymbolicLink() || root.dev !== this.#identity.dev || root.ino !== this.#identity.ino) fail("WORKSPACE_CHANGED", "Workspace root changed");
    if (typeof path !== "string" || path.includes("\0") || isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || protectedPart(part))) fail("WORKSPACE_PATH", "Path must be relative and outside protected metadata/credential paths");
    const target = resolve(this.root, path || ".");
    if (relative(this.root, target).split("/")[0] === "..") fail("WORKSPACE_PATH", "Path leaves workspace");
    let current = this.root;
    for (const part of relative(this.root, target).split("/").filter(Boolean)) {
      current = join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) fail("WORKSPACE_SYMLINK", "Symlinks are not followed"); }
      catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    }
    return target;
  }
  read(path: string): { text: string; hash: string; mode: number } {
    const fd = openSync(this.path(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE) fail("FILE_LIMIT", "Expected a regular text file <= 512 KiB");
      const buffer = Buffer.alloc(MAX_FILE + 1); let length = 0, bytes: number;
      while (length < buffer.length && (bytes = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += bytes;
      const data = buffer.subarray(0, length);
      if (data.length > MAX_FILE || data.includes(0)) fail("FILE_LIMIT", "File is binary or exceeds the limit");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return fail("FILE_ENCODING", "Expected UTF-8 text"); }
      return { text, hash: contentHash(text), mode: stat.mode & 0o777 };
    } finally { closeSync(fd); }
  }
  files(path = ".", limit = 500): { paths: string[]; truncated: boolean } {
    const paths: string[] = [], queue = [this.path(path)]; let visited = 0, truncated = false;
    while (queue.length) {
      const dir = queue.shift()!;
      const handle = opendirSync(dir);
      try { for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++visited > 10_000 || paths.length >= limit) { truncated = true; break; }
        if (protectedPart(entry.name) || skipped.has(entry.name) || entry.isSymbolicLink()) continue;
        const child = join(dir, entry.name);
        if (entry.isDirectory()) queue.push(child);
        else if (entry.isFile()) paths.push(relative(this.root, child));
      } } finally { handle.closeSync(); }
      if (truncated) break;
    }
    return { paths: paths.sort(), truncated };
  }
  write(path: string, text: string, expectedHash: string | null, signal?: AbortSignal): JsonValue {
    checkSignal(signal);
    if (Buffer.byteLength(text) > MAX_FILE) fail("FILE_LIMIT", "New content exceeds 512 KiB");
    const target = this.path(path, true);
    let previous: ReturnType<Workspace["read"]> | undefined;
    try { previous = this.read(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if ((previous?.hash ?? null) !== expectedHash) fail("FILE_CONFLICT", "File changed; read it again before editing");
    if (previous && lstatSync(target).nlink !== 1) fail("WORKSPACE_HARDLINK", "Hardlinked files cannot be edited");
    mkdirSync(dirname(target), { recursive: true });
    this.path(path, true);
    const temporary = join(dirname(target), `.minicah-write-${randomUUID()}`);
    let committed = false;
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, previous?.mode ?? 0o644);
      try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      checkSignal(signal);
      // Recheck just before commit; synchronous operations serialize writes in this process.
      this.path(path, true);
      if (previous) {
        if (this.read(path).hash !== expectedHash) fail("FILE_CONFLICT", "File changed before commit");
        renameSync(temporary, target);
      } else { linkSync(temporary, target); unlinkSync(temporary); }
      committed = true;
      const dir = openSync(dirname(target), constants.O_RDONLY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
      return { ok: true, path, hash: contentHash(text), bytes: Buffer.byteLength(text) };
    } catch (error) {
      if (committed) throw new Error("WRITE_DURABILITY_UNCERTAIN", { cause: error });
      throw error;
    } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
}
export const workspaceService = serviceToken<Workspace>("WorkspaceService");
const pathSchema = { type: "string", maxLength: 4096 };
const hashSchema = { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] };
const schema = (properties: Record<string, JsonValue>, required: string[]): JsonValue => ({ type: "object", additionalProperties: false, properties, required });
export function workspaceError(error: unknown): JsonValue {
  if (error instanceof HarnessError) return { ok: false, code: error.code, message: error.message };
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === "string" && ["ENOENT", "EEXIST", "EISDIR", "ENOTDIR", "EACCES"].includes(code)) return { ok: false, code };
  throw error;
}
export function createCodingToolsPlugin(root: string, readOnly = false, executionMode: "host" | "docker" | "native" = "host"): Plugin {
  return { id: "coding-tools", version: "1.1.0", apiVersion: API_VERSION, scope: "runtime", provides: [workspaceService], requires: readOnly ? [] : [services.execution],
    validateConfig(input) { if (input !== undefined) fail("INVALID_CONFIG", "Workspace, read-only and command isolation policies require a new coding-tools plugin generation"); return { workspace: resolve(root), readOnly, executionMode }; },
    setup(ctx) {
      const resource = ctx.resource("workspace", () => new Workspace(root), () => {});
      ctx.provide(workspaceService, () => resource.get());
      const register = (name: string, description: string, inputSchema: JsonValue, effect: "read" | "non-idempotent-write", operation: (args: Record<string, any>, workspace: Workspace, signal?: AbortSignal) => JsonValue) => {
        ctx.registerTool({ name, description, inputSchema, effect, execute(input, _run, execution) {
          try { checkSignal(execution?.signal); return operation(input as Record<string, any>, resource.get(), execution?.signal); } catch (error) { return workspaceError(error); }
        } });
      };
      register("list_files", "List workspace files. Skips dependencies, generated output, credentials and metadata.", schema({ path: pathSchema }, []), "read", (args, workspace) => ({ ...workspace.files(args.path ?? ".") }));
      register("read_file", "Read UTF-8 text and its full-file content hash. Use the hash for edits.", schema({ path: pathSchema, startLine: { type: "integer", minimum: 1 }, lineCount: { type: "integer", minimum: 1, maximum: 300 } }, ["path"]), "read", (args, workspace) => {
        const file = workspace.read(args.path), lines = file.text.split("\n"), start = args.startLine ?? 1, count = args.lineCount ?? 200;
        const selected = lines.slice(start - 1, start - 1 + count).join("\n");
        return { path: args.path, hash: file.hash, startLine: start, totalLines: lines.length, text: selected.slice(0, 24_000), truncated: selected.length > 24_000 || start - 1 + count < lines.length };
      });
      register("search_text", "Search literal text in bounded UTF-8 workspace files. No regular expressions.", schema({ query: { type: "string", minLength: 1, maxLength: 1024 }, path: pathSchema }, ["query"]), "read", (args, workspace) => {
        const listing = workspace.files(args.path ?? ".", 500), matches: JsonValue[] = []; let scannedBytes = 0, truncated = listing.truncated;
        for (const path of listing.paths) {
          let text: string;
          try { text = workspace.read(path).text; } catch (error) { workspaceError(error); continue; }
          scannedBytes += Buffer.byteLength(text);
          if (scannedBytes > 8 * 1024 * 1024) { truncated = true; break; }
          for (const [index, line] of text.split("\n").entries()) if (line.includes(args.query)) {
            matches.push({ path, line: index + 1, text: line.slice(0, 400) });
            if (matches.length >= 50) break;
          }
          if (matches.length >= 50) { truncated = true; break; }
        }
        return { matches, truncated };
      });
      if (readOnly) return;
      register("write_file", "Create/replace a file. expectedHash=null creates only; otherwise use the hash from read_file. Requires approval.", schema({ path: pathSchema, content: { type: "string", maxLength: MAX_FILE }, expectedHash: hashSchema }, ["path", "content", "expectedHash"]), "non-idempotent-write", (args, workspace, signal) => workspace.write(args.path, args.content, args.expectedHash, signal));
      register("edit_file", "Replace exactly one literal occurrence in an existing file using its read_file hash. Requires approval.", schema({ path: pathSchema, oldText: { type: "string", minLength: 1, maxLength: MAX_FILE }, newText: { type: "string", maxLength: MAX_FILE }, expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$" } }, ["path", "oldText", "newText", "expectedHash"]), "non-idempotent-write", (args, workspace, signal) => {
        const file = workspace.read(args.path), at = file.text.indexOf(args.oldText);
        if (at < 0 || file.text.indexOf(args.oldText, at + 1) >= 0) fail("EDIT_AMBIGUOUS", "oldText must occur exactly once");
        return workspace.write(args.path, file.text.slice(0, at) + args.newText + file.text.slice(at + args.oldText.length), args.expectedHash, signal);
      });
      const commandDescription = executionMode === "docker"
        ? "Run an argv command in a fresh restricted Docker container with networking disabled. cwd is relative to a filtered disposable workspace copy: credentials and metadata are excluded; changes and build outputs are discarded afterward. Use approved write_file/edit_file for persistent workspace changes. Requires explicit approval for every invocation."
        : executionMode === "native" ? "Run a single-process argv command in the macOS OS sandbox. Network access and spawning child processes are denied; commands such as npm test that require children cannot run in this mode. cwd is relative to a filtered disposable workspace copy; use relative file paths. Credentials and metadata are excluded; changes are discarded afterward. Use approved write_file/edit_file for persistent changes. Requires explicit approval for every invocation."
        : "Run an argv command on the HOST, with no OS sandbox. cwd is relative to the workspace. Requires explicit approval for every invocation.";
      ctx.registerTool({ name: "run_command", description: commandDescription, effect: "non-idempotent-write",
        inputSchema: schema({ command: { type: "string", minLength: 1, maxLength: 4096 }, args: { type: "array", maxItems: 100, items: { type: "string", maxLength: 8192 } }, cwd: pathSchema }, ["command", "args"]),
        async execute(input, run, execution) {
          const args = input as { command: string; args: string[]; cwd?: string };
          let cwd: string;
          try { cwd = resource.get().path(args.cwd ?? "."); if (!lstatSync(cwd).isDirectory()) fail("WORKSPACE_PATH", "cwd must be a directory"); } catch (error) { return workspaceError(error); }
          return run.services.get(services.execution).execute({ command: args.command, args: args.args, cwd, ...(execution ? { signal: execution.signal } : {}) });
        },
      });
    },
  };
}
