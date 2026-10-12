import type { JsonValue } from "../types.js";
import type { Definition, DefinitionKind, DefinitionRef } from "./types.js";
import { immutable, canonical, contentHash } from "../json.js";
export { immutable, canonical, contentHash } from "../json.js";

export function definition(kind: DefinitionKind, id: string, version: string, content: JsonValue): Definition {
  return immutable({ kind, id, version, hash: contentHash(content), content });
}

export function reference(value: DefinitionRef): DefinitionRef {
  return immutable({ kind: value.kind, id: value.id, version: value.version, hash: value.hash });
}

export function definitionKey(value: DefinitionRef): string {
  return canonical([value.kind, value.id, value.version]);
}
