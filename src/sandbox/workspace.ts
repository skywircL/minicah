import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, opendir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fail } from "../errors.js";

export interface WorkspaceSnapshotOptions {
  readonly maxBytes: number;
  /** Counts directories, files and retained symlinks, excluding the snapshot root. */
  readonly maxFiles: number;
  readonly signal?: AbortSignal;
}

export interface WorkspaceSnapshot {
  readonly directory: string;
  readonly input: string;
  dispose(): Promise<void>;
}

const protectedPart = (part: string): boolean => /^(\.git|\.minicah|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.netrc|id_rsa|id_ed25519)$/i.test(part);
const identityMatches = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

/**
 * Creates a filtered, bounded input tree. The container sees only this copy.
 * Path/identity checks reject observed source replacement; these Host checks are
 * not an OS security boundary against a concurrently hostile Host filesystem.
 */
export async function createWorkspaceSnapshot(root: string, options: WorkspaceSnapshotOptions): Promise<WorkspaceSnapshot> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || !Number.isSafeInteger(options.maxFiles) || options.maxFiles < 0) {
    fail("SANDBOX_WORKSPACE_LIMIT", "Snapshot limits must be non-negative safe integers");
  }
  const checkSignal = (): void => { if (options.signal?.aborted) fail("CANCELLED", "Workspace snapshot cancelled"); };
  checkSignal();
  const source = await realpath(root), rootStat = await lstat(source);
  if (!rootStat.isDirectory()) fail("SANDBOX_WORKSPACE_PATH", "Workspace must be a directory");
  const directories = new Map<string, Stats>([[source, rootStat]]);
  const directory = await mkdtemp(join(tmpdir(), "minicah-sandbox-")), input = join(directory, "input");
  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> => disposing ??= rm(directory, { recursive: true, force: true }).catch(error => { disposing = undefined; throw error; });
  let entries = 0, bytes = 0;
  const reserveEntry = (): void => {
    if (++entries > options.maxFiles) fail("SANDBOX_WORKSPACE_LIMIT", "Workspace snapshot exceeds its entry limit");
  };

  // Revalidate all known ancestor identities before opening anything by path.
  const checkDirectory = async (path: string): Promise<void> => {
    checkSignal();
    if (!inside(source, path)) fail("SANDBOX_WORKSPACE_PATH", "Snapshot path leaves workspace");
    let current = source;
    for (const part of ["", ...relative(source, path).split(sep).filter(Boolean)]) {
      if (part) current = join(current, part);
      const expected = directories.get(current), actual = await lstat(current);
      if (!expected || !actual.isDirectory() || actual.isSymbolicLink() || !identityMatches(actual, expected)) {
        fail("SANDBOX_WORKSPACE_CHANGED", "Workspace directory changed while creating its snapshot");
      }
    }
  };

  const copyFile = async (path: string, target: string, expected: Stats): Promise<void> => {
    if (expected.nlink !== 1) return;
    reserveEntry();
    if (expected.size > options.maxBytes - bytes) fail("SANDBOX_WORKSPACE_LIMIT", "Workspace snapshot exceeds its byte limit");
    await checkDirectory(dirname(path));
    // NONBLOCK prevents an observed regular file being replaced with a blocking FIFO.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const actual = await file.stat();
      if (!actual.isFile() || actual.nlink !== 1 || !identityMatches(actual, expected)) fail("SANDBOX_WORKSPACE_CHANGED", "Workspace file changed while creating its snapshot");
      await checkDirectory(dirname(path));
      const destination = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
          checkSignal();
          // Read one excess byte when exactly at the limit, to detect growth.
          const length = Math.min(buffer.length, options.maxBytes - bytes + 1);
          const { bytesRead } = await file.read(buffer, 0, length, null);
          if (!bytesRead) break;
          bytes += bytesRead;
          if (bytes > options.maxBytes) fail("SANDBOX_WORKSPACE_LIMIT", "Workspace snapshot exceeds its byte limit");
          let offset = 0;
          while (offset < bytesRead) {
            checkSignal();
            const written = await destination.write(buffer, offset, bytesRead - offset, null);
            if (!written.bytesWritten) fail("SANDBOX_WORKSPACE_IO", "Snapshot write made no progress");
            offset += written.bytesWritten;
          }
        }
        await destination.chmod(0o444 | (actual.mode & 0o111));
        const after = await file.stat();
        if (after.nlink !== 1 || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || after.ctimeMs !== actual.ctimeMs) {
          fail("SANDBOX_WORKSPACE_CHANGED", "Workspace file was modified during snapshot creation");
        }
      } finally { await destination.close(); }
    } finally { await file.close(); }
  };

  const copyLink = async (path: string, target: string, expected: Stats): Promise<void> => {
    await checkDirectory(dirname(path));
    const link = await readlink(path);
    if (isAbsolute(link) || link.includes("\0")) return;
    const resolved = resolve(dirname(path), link);
    if (!inside(source, resolved) || relative(source, resolved).split(sep).some(protectedPart)) return;
    // Retain direct internal relative links (including npm .bin links), but do
    // not follow link chains: an intermediate alias might hide a protected path.
    let current = dirname(path);
    try {
      // Inspect the original components before normalizing '..': otherwise an
      // alias/../target sequence could conceal an intermediate symlink.
      for (const part of link.split(sep).filter(Boolean)) {
        if (part === ".") continue;
        if (protectedPart(part)) return;
        current = part === ".." ? dirname(current) : join(current, part);
        if (!inside(source, current)) return;
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) return;
      }
    } catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return; throw error; }
    await checkDirectory(dirname(path));
    const after = await lstat(path);
    if (!after.isSymbolicLink() || !identityMatches(after, expected) || await readlink(path) !== link) fail("SANDBOX_WORKSPACE_CHANGED", "Workspace symlink changed during snapshot creation");
    reserveEntry();
    await symlink(link, target);
  };

  const copyDirectory = async (path: string, target: string): Promise<void> => {
    await checkDirectory(path);
    const handle = await opendir(path);
    try {
      await checkDirectory(path);
      for (;;) {
        checkSignal();
        const entry = await handle.read();
        if (!entry) break;
        if (protectedPart(entry.name)) continue;
        const child = join(path, entry.name), destination = join(target, entry.name);
        await checkDirectory(path);
        const stat = await lstat(child);
        if (stat.isSymbolicLink()) await copyLink(child, destination, stat);
        else if (stat.isFile()) await copyFile(child, destination, stat);
        else if (stat.isDirectory()) {
          reserveEntry(); directories.set(child, stat);
          await mkdir(destination, { mode: 0o755 }); await chmod(destination, 0o755);
          await copyDirectory(child, destination);
        }
      }
    } finally { await handle.close(); }
    await checkDirectory(path);
  };

  try {
    await chmod(directory, 0o700);
    if (inside(source, await realpath(directory))) fail("SANDBOX_WORKSPACE_PATH", "Snapshot temporary directory must be outside the source workspace");
    await mkdir(input, { mode: 0o755 }); await chmod(input, 0o755);
    await copyDirectory(source, input);
    checkSignal();
    return { directory, input, dispose };
  } catch (error) { await dispose(); throw error; }
}
