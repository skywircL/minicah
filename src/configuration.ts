import { randomUUID } from "node:crypto";
import { contentHash, immutable } from "./json.js";
import type { ConfigurationVersion, JsonValue } from "./types.js";

export function configurationVersion(version: number, configs: ReadonlyMap<string, JsonValue | undefined>, reason: ConfigurationVersion["reason"]): ConfigurationVersion {
  const values = Object.fromEntries([...configs].filter((entry): entry is [string, JsonValue] => entry[1] !== undefined));
  return immutable({ id: randomUUID(), version, reason, createdAt: new Date().toISOString(), hash: contentHash(values), values });
}

/** Internal, synchronous invalidation channel; callbacks must not start lifecycle work. */
export class ConfigurationChannel {
  current: ConfigurationVersion | undefined;
  readonly listeners = new Set<(configuration: ConfigurationVersion) => void>();
  publish(configuration: ConfigurationVersion): unknown[] {
    this.current = configuration;
    const errors: unknown[] = [];
    for (const listener of [...this.listeners]) {
      try { listener(configuration); } catch (error) { errors.push(error); }
    }
    return errors;
  }
}
