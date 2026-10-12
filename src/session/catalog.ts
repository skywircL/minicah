import { readdir, access } from "node:fs/promises";
import { join, basename } from "node:path";
import { API_VERSION, serviceToken, type Plugin } from "../types.js";
import { fail } from "../errors.js";
import { readJournalSnapshot } from "./file-journal.js";
import { sessionLogPath } from "./plugins.js";
import type { SessionEvent } from "./types.js";

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string | null;
  readonly runs: number;
  readonly status: string;
  readonly locked: boolean;
}
export interface SessionListing { readonly items: readonly SessionSummary[]; readonly unavailable: number }
export interface SessionCatalogService {
  list(): Promise<SessionListing>;
  read(id: string): Promise<readonly SessionEvent[]>;
}
export const sessionCatalogService = serviceToken<SessionCatalogService>("SessionCatalogService");

export function sessionSummary(id: string, events: readonly SessionEvent[], locked = false): SessionSummary {
  const first = events.find(event => event.data.type === "user.input");
  const title = first?.data.type === "user.input" ? [...first.data.content.replace(/\s+/g, " ").trim()].slice(0, 72).join("") : "空会话";
  const latest = events.findLast(event => event.data.type === "run.finished" || event.data.type === "run.started");
  return Object.freeze({ id, title, updatedAt: events.at(-1)?.timestamp ?? null,
    runs: events.filter(event => event.data.type === "run.started").length,
    status: latest?.data.type === "run.finished" ? latest.data.status : latest ? "unfinished" : "empty", locked });
}
export function assertSessionWorkspace(events: readonly SessionEvent[], workspace: string): void {
  const root = events.find(event => event.data.type === "protected.recorded" && event.data.id === "workspace-root");
  if (root?.data.type === "protected.recorded" && root.data.content !== workspace) fail("WORKSPACE_MISMATCH", "会话属于另一个工作区");
}

/** Cold reads are a capability plugin; listing never opens a model or a journal writer. */
export function createSessionCatalogPlugin(directory: string, workspace: string): Plugin {
  const read: SessionCatalogService["read"] = async id => {
    if (!id.trim() || id.length > 256) fail("INVALID_SESSION", "无效的会话 ID");
    try {
      const snapshot = await readJournalSnapshot(sessionLogPath(directory, id), id);
      assertSessionWorkspace(snapshot.events, workspace);
      return snapshot.events;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("SESSION_NOT_FOUND", "找不到指定会话");
      throw error;
    }
  };
  return { id: "session-catalog", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [sessionCatalogService], requires: [],
    setup(ctx) {
      ctx.provide(sessionCatalogService, () => ({ read, async list() {
        const items: SessionSummary[] = [];
        let unavailable = 0;
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items, unavailable }; throw error; }
        for (const entry of entries) {
          if (!entry.isFile() || !/^[a-f0-9]{64}\.jsonl$/.test(entry.name)) continue;
          const path = join(directory, entry.name);
          try {
            const snapshot = await readJournalSnapshot(path);
            if (snapshot.sessionId === undefined) continue; // Unused empty journals have no durable identity yet.
            if (basename(sessionLogPath(directory, snapshot.sessionId)) !== entry.name) fail("INVALID_LOG", "Journal identity does not match its filename");
            assertSessionWorkspace(snapshot.events, workspace);
            let locked = false;
            try { await access(`${path}.lock`); locked = true; } catch { /* listing is advisory; actual open enforces the lock */ }
            items.push(sessionSummary(snapshot.sessionId, snapshot.events, locked));
          } catch { unavailable++; }
        }
        items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id));
        return { items: Object.freeze(items), unavailable };
      } }));
    },
  };
}
