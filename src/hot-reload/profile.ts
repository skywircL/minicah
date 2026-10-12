import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Ajv } from "ajv";
import { fail } from "../errors.js";
import { freezeJson } from "../plan.js";
import type { JsonValue } from "../types.js";

export interface HotReloadProfile {
  readonly version: 1;
  readonly plugins: Readonly<Record<string, { readonly enabled?: boolean; readonly config?: JsonValue }>>;
}
const validate = new Ajv({ strict: true, ownProperties: true }).compile({
  type: "object", additionalProperties: false, required: ["version", "plugins"], properties: {
    version: { const: 1 }, plugins: { type: "object", additionalProperties: {
      type: "object", additionalProperties: false, properties: { enabled: { type: "boolean" }, config: {} },
    } },
  },
});
export function parseHotReloadProfile(text: string): HotReloadProfile {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail("PROFILE_PARSE", "热更新配置必须是合法 JSON；当前运行配置保留。"); }
  if (!validate(value)) fail("PROFILE_SCHEMA", "热更新配置需要 version: 1 和 plugins 对象；插件条目只接受 enabled/config。");
  return freezeJson(value as unknown as JsonValue) as unknown as HotReloadProfile;
}
/** Missing files remove the overlay; malformed files never discard the last successful generation. */
export async function readHotReloadProfile(path: string): Promise<HotReloadProfile> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, plugins: {} };
    return fail("PROFILE_READ", "无法读取热更新配置；请使用普通 JSON 文件。");
  }
  try {
    const info = await file.stat(), limit = 256 * 1024;
    if (!info.isFile() || info.size > limit) fail("PROFILE_SIZE", "热更新配置必须是最多 256 KiB 的普通文件。");
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const part = await file.read(bytes, size, bytes.length - size, null);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    if (size > limit) fail("PROFILE_SIZE", "热更新配置超过 256 KiB。");
    return parseHotReloadProfile(bytes.subarray(0, size).toString("utf8"));
  } finally { await file.close(); }
}

/** A file is an overlay on the startup baseline, never on the previous edit. Objects merge one level. */
export function overlayConfig(base: JsonValue | undefined, overlay: JsonValue | undefined): JsonValue | undefined {
  if (overlay === undefined) return base;
  if (base && overlay && typeof base === "object" && typeof overlay === "object" && !Array.isArray(base) && !Array.isArray(overlay)) return freezeJson({ ...base, ...overlay });
  return overlay;
}
