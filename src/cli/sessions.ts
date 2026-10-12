import { randomUUID } from "node:crypto";
import { fail } from "../errors.js";
import { services } from "../services.js";
import type { Runtime, Session } from "../runtime.js";
import { sessionCatalogService, assertSessionWorkspace, sessionSummary, type SessionListing } from "../session/catalog.js";

/** The CLI owns navigation outside run callbacks, avoiding lifecycle self-waits. */
export class CliSessions {
  constructor(readonly runtime: Runtime, public current: Session, readonly workspace: string) {}
  async list(): Promise<SessionListing> {
    const listing = await this.current.run(run => run.services.get(sessionCatalogService).list());
    const current = await this.current.run(run => sessionSummary(this.current.id, run.services.get(services.session).events(), true));
    return { ...listing, items: [current, ...listing.items.filter(item => item.id !== current.id)] };
  }
  async resume(query: string): Promise<Session> {
    if (query === this.current.id) return this.current;
    const listing = await this.list();
    const exact = listing.items.find(item => item.id === query);
    const matches = exact ? [exact] : listing.items.filter(item => item.id.startsWith(query));
    if (matches.length > 1) fail("AMBIGUOUS_SESSION", "会话 ID 前缀不唯一，请输入更完整的 ID");
    const id = matches[0]?.id ?? query;
    if (id === this.current.id) return this.current;
    await this.current.run(run => run.services.get(sessionCatalogService).read(id));
    return this.#switch(id);
  }
  async create(): Promise<Session> { return this.#switch(randomUUID()); }
  async #switch(id: string): Promise<Session> {
    // Keep the old Session usable if loading/locking/validating the target fails.
    const candidate = await this.runtime.openSession(id);
    try {
      await candidate.run(run => assertSessionWorkspace(run.services.get(services.session).events(), this.workspace));
      await this.current.close();
    } catch (error) {
      await candidate.close();
      throw error;
    }
    this.current = candidate;
    return candidate;
  }
}
