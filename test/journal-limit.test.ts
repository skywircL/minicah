import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJournal, SessionLog, contentHash, definition, type SessionEvent } from "../src/index.js";
import { canonical } from "../src/session/json.js";
import { code } from "./helpers.js";

function event(seq: number, content: string): SessionEvent {
  return { schemaVersion: 1, sessionId: "limited", seq, timestamp: "2026-01-01T00:00:00.000Z", runId: null, callId: null, parentCallId: null,
    versions: null, tool: null, configHash: contentHash(null), data: { type: "definition.recorded", definition: definition("prompt", `p-${seq}`, "1", content) } };
}
function bytes(events: readonly SessionEvent[]): number {
  const body = { format: 1, sessionId: "limited", fromSeq: events[0]!.seq, events };
  return Buffer.byteLength(canonical({ ...body, checksum: contentHash(body) }) + "\n");
}

test("journal byte admission serializes concurrent appends and rejects whole frames before writing", async t => {
  const directory = await mkdtemp(join(tmpdir(), "minicah-journal-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "journal.jsonl"), first = event(1, "中文"), second = event(2, "ok"), large = event(2, "x".repeat(10000));
  const maxBytes = bytes([first]) + bytes([second]);
  const journal = await FileJournal.open(path, "limited", { maxBytes });
  const result = await Promise.allSettled([journal.append([first], "fsync"), journal.append([large], "fsync")]);
  assert.equal(result[0]!.status, "fulfilled");
  assert.equal(result[1]!.status, "rejected");
  if (result[1]!.status === "rejected") assert.ok(code("JOURNAL_LIMIT")(result[1]!.reason));
  assert.equal((await stat(path)).size, bytes([first]));
  assert.equal(journal.read().length, 1);
  // A rejected admission does not poison the journal or consume sequence/bytes.
  await journal.append([second], "fsync");
  assert.equal((await stat(path)).size, maxBytes);
  assert.equal(journal.read().length, 2);
  await assert.rejects(journal.append([event(3, "extra")], "flush"), code("JOURNAL_LIMIT"));
  await journal.close();
  const before = await readFile(path);
  await assert.rejects(FileJournal.open(path, "limited", { maxBytes: maxBytes - 1 }), code("JOURNAL_LIMIT"));
  assert.deepEqual(await readFile(path), before);
  const reopened = await FileJournal.open(path, "limited", { maxBytes });
  assert.equal(reopened.read().length, 2);
  await reopened.close();
});

test("storage limit failures publish no committed events and invalid limits create no journal", async t => {
  const directory = await mkdtemp(join(tmpdir(), "minicah-journal-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "journal.jsonl");
  for (const maxBytes of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(FileJournal.open(path, "limited", { maxBytes }), code("INVALID_JOURNAL_LIMIT"));
  }
  const journal = await FileJournal.open(path, "limited", { maxBytes: 1 }), log = await SessionLog.open(journal);
  let notifications = 0;
  log.subscribeCommitted(() => { notifications++; });
  await assert.rejects(log.commit([{ runId: null, data: { type: "definition.recorded", definition: definition("prompt", "small", "1", "text") } }]), code("JOURNAL_LIMIT"));
  assert.equal(notifications, 0);
  assert.equal(log.events().length, 0);
  assert.equal((await stat(path)).size, 0);
  await log.close();
  // Omission preserves the existing unlimited-bytes behavior.
  const unlimited = await FileJournal.open(path, "limited");
  await unlimited.append([event(1, "x".repeat(1024))], "flush");
  assert.equal(unlimited.read().length, 1);
  await unlimited.close();
});
