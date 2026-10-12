import { Ajv } from "ajv";
import { fail } from "../errors.js";
import { canonical, immutable } from "../json.js";
import { registryToken } from "../registry.js";
import { API_VERSION, type Plugin } from "../types.js";
import { readPlainFile, validateTaskPath } from "./dataset.js";
import type { SandboxTestDefinition, SandboxTestPack } from "./sandbox-test-types.js";

export const SANDBOX_TEST_PACK_BYTE_LIMIT = 1024 * 1024;
const identifier = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$", maxLength: 128 } as const;
const validate = new Ajv({ strict: true, ownProperties: true }).compile({
  type: "object", additionalProperties: false, required: ["schemaVersion", "id", "version", "tests"], properties: {
    schemaVersion: { const: 1 }, id: identifier, version: { type: "string", minLength: 1, maxLength: 128 },
    tests: { type: "array", minItems: 1, maxItems: 64, items: {
      type: "object", additionalProperties: false, required: ["id", "module", "export", "cases"], properties: {
        id: identifier, module: { type: "string", minLength: 1, maxLength: 512 },
        export: { type: "string", pattern: "^[a-zA-Z_$][a-zA-Z0-9_$]*$", maxLength: 128 },
        cases: { type: "array", minItems: 1, maxItems: 32, items: {
          type: "object", additionalProperties: false, required: ["id", "args"], properties: {
            id: identifier, args: { type: "array", maxItems: 128 }, expected: {},
            throws: { type: "string", pattern: "^[a-zA-Z_$][a-zA-Z0-9_$]*$", maxLength: 128 },
          }, oneOf: [{ required: ["expected"], properties: { expected: {} } }, { required: ["throws"], properties: { throws: {} } }],
        } },
      },
    } },
  },
});

/** Bound nesting before the general immutable JSON copier or schema validator recurses. */
function checkJson(value: unknown, depth = 0, ancestors = new Set<object>(), count = { value: 0 }): void {
  if (depth > 64 || ++count.value > 100_000) fail("EVAL_TEST_PACK_SIZE", "Test pack exceeds its JSON complexity limit");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value !== "object" || !value || ancestors.has(value)
    || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail("EVAL_TEST_PACK_SCHEMA", "Test packs require finite, acyclic plain JSON");
  }
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string")) fail("EVAL_TEST_PACK_SCHEMA", "Test packs cannot contain symbol properties");
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) fail("EVAL_TEST_PACK_SCHEMA", "Test packs cannot contain sparse arrays or accessors");
      checkJson(descriptor.value, depth + 1, ancestors, count);
    }
  } else for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) fail("EVAL_TEST_PACK_SCHEMA", "Test packs cannot contain accessors");
    checkJson(descriptor.value, depth + 1, ancestors, count);
  }
  ancestors.delete(value);
}

export function validateSandboxTestPack(input: unknown): SandboxTestPack {
  checkJson(input);
  if (!validate(input)) fail("EVAL_TEST_PACK_SCHEMA", `Invalid sandbox test pack: ${validate.errors?.map(error => `${error.instancePath} ${error.keyword}`).join(", ")}`);
  const pack = immutable(input) as SandboxTestPack;
  if (Buffer.byteLength(canonical(pack)) > SANDBOX_TEST_PACK_BYTE_LIMIT) fail("EVAL_TEST_PACK_SIZE", "Sandbox test pack exceeds 1 MiB");
  const ids = new Set<string>();
  for (const definition of pack.tests) {
    if (ids.has(definition.id)) fail("EVAL_TEST_PACK_SCHEMA", "Duplicate sandbox test id");
    ids.add(definition.id);
    validateTaskPath(definition.module);
    if (!/\.(?:mjs|cjs|js)$/.test(definition.module)) fail("EVAL_TEST_PACK_SCHEMA", "Sandbox function tests require a .js, .mjs or .cjs module");
    const cases = new Set<string>();
    for (const testCase of definition.cases) {
      if (cases.has(testCase.id)) fail("EVAL_TEST_PACK_SCHEMA", "Duplicate sandbox case id");
      cases.add(testCase.id);
      // Own-property presence matters: null, false and zero are valid expectations.
      if (Object.hasOwn(testCase, "expected") === Object.hasOwn(testCase, "throws")) fail("EVAL_TEST_PACK_SCHEMA", "A case needs exactly one of expected or throws");
    }
  }
  return pack;
}

export async function readSandboxTestPack(path: string): Promise<SandboxTestPack> {
  const text = await readPlainFile(path, SANDBOX_TEST_PACK_BYTE_LIMIT);
  let input: unknown;
  try { input = JSON.parse(text); } catch { fail("EVAL_TEST_PACK_PARSE", "Sandbox test pack must contain valid JSON"); }
  return validateSandboxTestPack(input);
}

export interface SandboxTestRegistration {
  readonly packId: string;
  readonly packVersion: string;
  readonly definition: SandboxTestDefinition;
}
/** Generic scoped registry: a run pins definitions and their owner/generation together. */
export const sandboxTestRegistry = registryToken<SandboxTestRegistration>("sandbox-tests", value => {
  const pack = validateSandboxTestPack({ schemaVersion: 1, id: value.packId, version: value.packVersion, tests: [value.definition] });
  return { packId: pack.id, packVersion: pack.version, definition: pack.tests[0]! };
});

export function createSandboxTestPackPlugin(input: SandboxTestPack): Plugin {
  const pack = validateSandboxTestPack(input);
  return { id: `sandbox-test-pack-${pack.id}`, version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [],
    setup(ctx) {
      for (const definition of pack.tests) ctx.register(sandboxTestRegistry, `${pack.id}/${definition.id}`, { packId: pack.id, packVersion: pack.version, definition });
    },
  };
}
