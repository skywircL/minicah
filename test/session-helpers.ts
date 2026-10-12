import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { FileJournal, SessionLog, definition, reference, type Durability, type EventJournal, type SessionEvent } from "../src/index.js";

export const definitions = [
  definition("model", "test-model", "1", { adapter: "echo", source: "input => input" }),
  definition("prompt", "test-prompt", "1", "Preserve user constraints."),
  definition("tool", "write-file", "1", { schema: { type: "object" }, source: "write(input)" }),
  definition("plugin", "test-plugin", "1", { source: "setup(context) { /* test plugin */ }" }),
] as const;
export const versions = { model: reference(definitions[0]!), prompt: reference(definitions[1]!), tools: [reference(definitions[2]!)], plugins: [reference(definitions[3]!)] };
export const toolRef = versions.tools[0]!;

export async function journalFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "minicah-test-"));
  const path = join(directory, "session.jsonl");
  const logs: SessionLog[] = [];
  t.after(async () => {
    await Promise.all(logs.map(log => log.close()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, path,
    async open(options: { durability?: Durability; wrap?: (journal: EventJournal) => EventJournal } = {}) {
      const journal = await FileJournal.open(path, "session");
      const log = await SessionLog.open(options.wrap ? options.wrap(journal) : journal, options.durability);
      logs.push(log);
      return { log, journal };
    },
  };
}

export async function start(log: SessionLog, runId = "run-1") {
  const run = log.forRun(runId);
  await run.retain(definitions);
  await run.start(versions, { temperature: 0, maxTokens: 100 });
  return run;
}

export function intercept(journal: EventJournal, hooks: {
  before?: (events: readonly SessionEvent[], durability: Durability) => Promise<void>;
  after?: (events: readonly SessionEvent[]) => Promise<void>;
}): EventJournal {
  return {
    sessionId: journal.sessionId,
    read: () => journal.read(), flush: durability => journal.flush(durability), close: () => journal.close(),
    async append(events, durability) {
      await hooks.before?.(events, durability);
      const receipt = await journal.append(events, durability);
      await hooks.after?.(events);
      return receipt;
    },
  };
}
