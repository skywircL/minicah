import { open, mkdir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fail, HarnessError } from "../errors.js";
import { canonical, contentHash, immutable } from "./json.js";
import { replay } from "./reducer.js";
import type { CommitReceipt, Durability, EventJournal, FlushReceipt, SessionEvent } from "./types.js";

function checkDurability(value: Durability): void {
  if (value !== "flush" && value !== "fsync") fail("INVALID_DURABILITY", "Expected flush or fsync durability");
}
interface Frame {
  format: 1;
  sessionId: string;
  fromSeq: number;
  events: SessionEvent[];
  checksum: string;
}

/** Validate complete frames without modifying a torn tail or acquiring a writer. */
function decodePrefix(bytes: Buffer, expectedId?: string) {
  const end = bytes.lastIndexOf(10) + 1, events: SessionEvent[] = [];
  let sessionId = expectedId;
  for (const line of bytes.subarray(0, end).toString("utf8").split("\n").slice(0, -1)) {
    let frame: Frame;
    try { frame = JSON.parse(line) as Frame; }
    catch (cause) { throw new HarnessError("INVALID_LOG", "Malformed complete journal frame", { cause }); }
    if (!frame || frame.format !== 1 || typeof frame.sessionId !== "string" || !frame.sessionId.trim() || (sessionId !== undefined && frame.sessionId !== sessionId) || frame.fromSeq !== events.length + 1 || !Array.isArray(frame.events) || !frame.events.length) fail("INVALID_LOG", "Journal frame header or sequence is invalid");
    sessionId ??= frame.sessionId;
    const { checksum, ...body } = frame;
    if (checksum !== contentHash(body)) fail("INVALID_LOG", "Journal frame checksum mismatch");
    events.push(...frame.events);
  }
  if (sessionId !== undefined) replay(sessionId, events);
  return { sessionId, events: immutable(events), discardedTailBytes: bytes.length - end };
}

/** A point-in-time committed-prefix read; never starts an Agent or repairs the file. */
export async function readJournalSnapshot(path: string, expectedId?: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) fail("INVALID_LOG", "Expected a regular session journal");
    // Freeze the read boundary even if another process is appending a transaction.
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return decodePrefix(bytes.subarray(0, offset), expectedId);
  } finally { await file.close(); }
}

/** One checksummed JSON line is one local commit, never an external transaction. */
export class FileJournal implements EventJournal {
  readonly #file: FileHandle;
  readonly #lock: FileHandle;
  readonly #path: string;
  #events: readonly SessionEvent[];
  #syncedThrough: number;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #poisoned = false;
  #closing: Promise<void> | undefined;
  #byteLength: number;

  private constructor(
    readonly sessionId: string, path: string, file: FileHandle, lock: FileHandle,
    events: readonly SessionEvent[], readonly discardedTailBytes: number, byteLength: number, readonly maxBytes?: number,
  ) {
    this.#path = path; this.#file = file; this.#lock = lock;
    this.#events = events; this.#syncedThrough = events.length;
    this.#byteLength = byteLength;
  }

  static async open(path: string, sessionId: string, options: { readonly maxBytes?: number } = {}): Promise<FileJournal> {
    if (typeof sessionId !== "string" || !sessionId.trim()) fail("INVALID_SESSION", "Journal needs a session id");
    if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) fail("INVALID_JOURNAL_LIMIT", "Journal maxBytes must be a positive safe integer");
    path = resolve(path);
    await mkdir(dirname(path), { recursive: true });
    path = resolve(await realpath(dirname(path)), basename(path));
    // Resolve an existing file symlink so it cannot bypass the writer lock.
    try { path = await realpath(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let lock: FileHandle;
    try { lock = await open(`${path}.lock`, "wx", 0o600); }
    catch (cause) { throw new HarnessError("JOURNAL_LOCKED", `Cannot acquire journal writer lock: ${path}.lock`, { cause }); }
    let file: FileHandle | undefined;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, sessionId, createdAt: new Date().toISOString() }));
      file = await open(path, "a+", 0o600);
      const stat = await file.stat();
      if (options.maxBytes !== undefined && stat.size > options.maxBytes) fail("JOURNAL_LIMIT", "Existing journal exceeds its storage byte limit");
      const bytes = await file.readFile();
      if (options.maxBytes !== undefined && bytes.length > options.maxBytes) fail("JOURNAL_LIMIT", "Existing journal exceeds its storage byte limit");
      const { events, discardedTailBytes } = decodePrefix(bytes, sessionId);
      const end = bytes.length - discardedTailBytes;
      if (end !== bytes.length) await file.truncate(end);
      // Recovery establishes a fresh fsync receipt for the bytes actually found.
      await file.sync();
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return new FileJournal(sessionId, path, file, lock, events, discardedTailBytes, end, options.maxBytes);
    } catch (cause) {
      const cleanup = await Promise.allSettled([file?.close(), lock.close()]);
      try { await unlink(`${path}.lock`); } catch { /* preserve original failure */ }
      const errors = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError([cause, ...errors], "Journal open and cleanup failed");
      throw cause;
    }
  }

  read(): readonly SessionEvent[] { return this.#events; }

  append(events: readonly SessionEvent[], durability: Durability): Promise<CommitReceipt> {
    checkDurability(durability);
    const copied = immutable(events);
    if (!copied.length) fail("INVALID_EVENT", "Cannot append an empty transaction");
    return this.#enqueue(async () => {
      const fromSeq = this.#events.length + 1;
      for (const [index, event] of copied.entries()) {
        if (event.seq !== fromSeq + index || event.sessionId !== this.sessionId) fail("INVALID_LOG", "Journal append sequence mismatch");
      }
      const body = { format: 1, sessionId: this.sessionId, fromSeq, events: copied };
      const line = `${canonical({ ...body, checksum: contentHash(body) })}\n`;
      const bytes = Buffer.byteLength(line);
      // Admission runs in the same serialized queue as the write. Reject the
      // entire transaction before touching the file, never a truncated frame.
      if (this.maxBytes !== undefined && bytes > this.maxBytes - this.#byteLength) fail("JOURNAL_LIMIT", "Journal transaction exceeds its storage byte limit");
      try {
        // writeFile resolves after the complete buffer is submitted to the OS.
        await this.#file.writeFile(line, "utf8");
        if (durability === "fsync") await this.#file.sync();
      } catch (cause) {
        this.#poisoned = true;
        throw new HarnessError("COMMIT_UNCERTAIN", "Journal write/sync failed; close and recover before further writes", { cause });
      }
      this.#byteLength += bytes;
      this.#events = Object.freeze([...this.#events, ...copied]);
      if (durability === "fsync") this.#syncedThrough = this.#events.length;
      return Object.freeze({ fromSeq, toSeq: this.#events.length, durability });
    });
  }

  flush(durability: Durability): Promise<FlushReceipt> {
    checkDurability(durability);
    return this.#enqueue(async () => {
      if (durability === "fsync") {
        try { await this.#file.sync(); }
        catch (cause) { this.#poisoned = true; throw new HarnessError("COMMIT_UNCERTAIN", "Journal sync failed", { cause }); }
        this.#syncedThrough = this.#events.length;
      }
      return Object.freeze({ flushedThrough: this.#events.length, syncedThrough: this.#syncedThrough });
    });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = this.#tail.then(async () => {
      this.#closed = true;
      const errors: unknown[] = [];
      try { await this.#file.close(); } catch (error) { errors.push(error); }
      try { await this.#lock.close(); } catch (error) { errors.push(error); }
      try { await unlink(`${this.#path}.lock`); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Journal close failed");
    });
    return this.#closing;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#closing) fail("JOURNAL_CLOSED", "Journal is closed");
    const next = this.#tail.then(() => {
      if (this.#poisoned) fail("COMMIT_UNCERTAIN", "Journal requires recovery after an I/O failure");
      return operation();
    });
    this.#tail = next.then(() => {}, () => {});
    return next;
  }
}
