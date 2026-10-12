import { join } from "node:path";
import { API_VERSION, type Plugin } from "../types.js";
import { services } from "../services.js";
import { FileJournal } from "./file-journal.js";
import { SessionLog } from "./session-log.js";
import { contentHash } from "./json.js";
import { contextFromState } from "./context.js";
import type { ContextProjection, Durability, SessionEvent } from "./types.js";

export function sessionLogPath(directory: string, sessionId: string): string {
  return join(directory, `${contentHash(sessionId)}.jsonl`);
}

export function createSessionPlugin(options: { directory: string; durability?: Durability; maxBytes?: number }): Plugin {
  const { directory, durability = "fsync", maxBytes } = options;
  return {
    id: "session-journal", version: "1.1.0", apiVersion: API_VERSION, scope: "session",
    provides: [services.session], requires: [],
    setup(ctx) {
      const log = ctx.resource("session-journal", async () => {
        const journal = await FileJournal.open(sessionLogPath(directory, ctx.sessionId!), ctx.sessionId!, maxBytes === undefined ? {} : { maxBytes });
        return SessionLog.open(journal, durability);
      }, log => log.close());
      ctx.provide(services.session, run => log.get().forRun(run.id, run.manifest));
    },
  };
}

export function createContextPlugin(): Plugin {
  return {
    id: "session-context", version: "1.1.0", apiVersion: API_VERSION, scope: "session",
    provides: [services.context], requires: [services.session],
    setup(ctx) {
      let lastEvent: SessionEvent | undefined, cached: ContextProjection | undefined;
      ctx.provide(services.context, run => {
        const session = run.services.get(services.session);
        return { build() {
          const events = session.events(), tail = events.at(-1);
          if (!cached || tail !== lastEvent) {
            cached = contextFromState(session.state(), events);
            lastEvent = tail;
          }
          return cached;
        } };
      });
    },
  };
}
