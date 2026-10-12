import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Ajv } from "ajv";
import { fail } from "../errors.js";
import { canonical, immutable } from "../json.js";
import type { EvaluationSuite } from "./types.js";

export const SUITE_BYTE_LIMIT = 4 * 1024 * 1024;
export const GRADER_FILE_BYTE_LIMIT = 1024 * 1024;
const protectedPart = /^(\.git|\.minicah|\.env(?:\..*)?|\.ssh|\.aws|\.codex|\.npmrc|\.netrc|id_rsa|id_ed25519)$/i;
export function validateTaskPath(path: string): void {
  if (!path || path.length > 512 || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path)
    || path.split("/").some(part => !part || part === "." || part === ".." || protectedPart.test(part))) {
    fail("EVAL_PATH", "Evaluation file paths must be safe relative paths without protected components");
  }
}
const label = { type: "string", minLength: 1, maxLength: 128 };
export const evaluationSuiteSchema = {
  type: "object", additionalProperties: false, required: ["schemaVersion", "id", "version", "split", "tasks"], properties: {
    schemaVersion: { const: 1 }, id: { type: "string", minLength: 1, maxLength: 128 }, version: { type: "string", minLength: 1, maxLength: 128 },
    split: { enum: ["regression", "capability", "holdout"] }, tasks: { type: "array", minItems: 1, maxItems: 1000, items: {
      type: "object", additionalProperties: false, required: ["id", "prompt", "graders"], properties: {
        id: { type: "string", minLength: 1, maxLength: 128 }, prompt: { type: "string", minLength: 1, maxLength: 65536 },
        tags: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", maxLength: 128 } },
        files: { type: "object", maxProperties: 1000, additionalProperties: { type: "string", maxLength: 1048576 } },
        executionPolicy: { type: "object", additionalProperties: false, required: ["allowedTools", "writeApproval"], properties: {
          allowedTools: { type: "array", maxItems: 5, uniqueItems: true, items: { enum: ["list_files", "read_file", "search_text", "write_file", "edit_file"] } },
          writeApproval: { enum: ["allow", "deny"] },
        } },
        trialProtocol: { type: "object", additionalProperties: false, required: ["repetitions", "timeoutMs"], properties: {
          repetitions: { type: "integer", minimum: 1, maximum: 100 }, timeoutMs: { type: "integer", minimum: 1, maximum: 86400000 },
        } },
        contract: { type: "object", additionalProperties: false,
          required: ["version", "capabilityId", "seedId", "mutation", "risk", "reset", "sources", "assertions"], properties: {
            version: { const: "1.0.0" }, capabilityId: label, seedId: label,
            mutation: { enum: ["none", "wording", "boundary", "permission", "adversarial"] }, risk: { enum: ["low", "medium", "high"] },
            reset: { const: "fresh-workspace-and-session" },
            sources: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false,
              required: ["id", "reference", "version", "statement"], properties: { id: label, version: label,
                reference: { type: "string", minLength: 1, maxLength: 1024 }, statement: { type: "string", minLength: 1, maxLength: 4096 },
              } } },
            assertions: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false,
              required: ["graderId", "layer", "sourceIds", "description"], properties: {
                graderId: label, layer: { enum: ["outcome", "behavior", "response"] },
                sourceIds: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: label },
                description: { type: "string", minLength: 1, maxLength: 4096 },
              } } },
          },
        },
        graders: { type: "array", minItems: 1, maxItems: 100, items: { oneOf: [{
          type: "object", additionalProperties: false, required: ["id", "kind", "expected"], properties: {
            id: { type: "string", minLength: 1, maxLength: 128 },
            kind: { enum: ["text-equals", "text-includes", "text-json-equals", "file-equals", "file-includes", "file-json-equals"] },
            expected: {}, path: { type: "string", minLength: 1, maxLength: 512 }, required: { type: "boolean" },
            weight: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
          },
        }, {
          type: "object", additionalProperties: false, required: ["id", "kind", "testId"], properties: {
            id: { type: "string", minLength: 1, maxLength: 128 }, kind: { const: "sandbox-test" },
            testId: { type: "string", minLength: 1, maxLength: 128 }, required: { type: "boolean" },
            weight: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
          },
        }, {
          type: "object", additionalProperties: false, required: ["id", "kind", "paths"], properties: {
            id: label, kind: { const: "workspace-unchanged-except" }, required: { type: "boolean" }, weight: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
            paths: { type: "array", maxItems: 1000, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } },
          },
        }, {
          type: "object", additionalProperties: false, required: ["id", "kind", "tools", "phase", "min", "max"], properties: {
            id: label, kind: { const: "tool-call-count" }, required: { type: "boolean" }, weight: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
            tools: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: label },
            phase: { enum: ["attempted", "dispatched", "rejected", "approval-denied", "attempted-after-denial"] },
            path: { type: "string", minLength: 1, maxLength: 512 },
            exceptPaths: { type: "array", maxItems: 1000, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } },
            min: { type: "integer", minimum: 0, maximum: 1000000 }, max: { type: "integer", minimum: 0, maximum: 1000000 },
          },
        }] } },
      },
    } },
  },
};
const validate = new Ajv({ strict: true, ownProperties: true }).compile(evaluationSuiteSchema);
export function validateSuite(input: unknown): EvaluationSuite {
  if (!validate(input)) fail("EVAL_SCHEMA", `Invalid evaluation suite: ${validate.errors?.map(error => `${error.instancePath} ${error.keyword}`).join(", ")}`);
  const suite = immutable(input) as unknown as EvaluationSuite;
  if (Buffer.byteLength(canonical(suite)) > SUITE_BYTE_LIMIT) fail("EVAL_SIZE", "Evaluation suite exceeds 4 MiB");
  const ids = new Set<string>();
  for (const task of suite.tasks) {
    if (ids.has(task.id)) fail("EVAL_SCHEMA", "Duplicate evaluation task id");
    ids.add(task.id);
    const paths = Object.keys(task.files ?? {}).sort();
    for (const path of paths) validateTaskPath(path);
    const allPaths = new Set(paths);
    for (const path of paths) {
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index++) {
        if (allPaths.has(parts.slice(0, index).join("/"))) fail("EVAL_PATH", "A task file cannot also be a directory");
      }
    }
    const graders = new Set<string>();
    if (!task.graders.some(grader => grader.required !== false)) fail("EVAL_SCHEMA", "Each task needs at least one required grader");
    for (const grader of task.graders) {
      if (graders.has(grader.id)) fail("EVAL_SCHEMA", "Duplicate grader id");
      graders.add(grader.id);
      if (grader.kind === "sandbox-test") continue;
      if (grader.kind === "workspace-unchanged-except") { for (const path of grader.paths) validateTaskPath(path); continue; }
      if (grader.kind === "tool-call-count") {
        if (grader.min > grader.max) fail("EVAL_SCHEMA", "Tool count minimum exceeds maximum");
        if (grader.phase === "attempted-after-denial" && (grader.path !== undefined || grader.exceptPaths !== undefined)) fail("EVAL_SCHEMA", "Post-denial attempts count all paths, including unavailable arguments");
        if (grader.path !== undefined) validateTaskPath(grader.path);
        if (grader.exceptPaths !== undefined) {
          if (grader.path !== undefined) fail("EVAL_SCHEMA", "Tool count path filters are mutually exclusive");
          for (const path of grader.exceptPaths) validateTaskPath(path);
        }
        continue;
      }
      if (grader.kind.startsWith("file-")) {
        if (grader.path === undefined) fail("EVAL_SCHEMA", "File graders require a path");
        validateTaskPath(grader.path);
      } else if (grader.path !== undefined) fail("EVAL_SCHEMA", "Text graders cannot specify a path");
      if (!["file-json-equals", "text-json-equals"].includes(grader.kind) && typeof grader.expected !== "string") fail("EVAL_SCHEMA", "Text comparisons require string expectations");
    }
    if (task.contract) {
      if (!task.executionPolicy || !task.trialProtocol) fail("EVAL_CONTRACT", "Gold contracts require executionPolicy and trialProtocol");
      const sources = new Set(task.contract.sources.map(source => source.id));
      if (sources.size !== task.contract.sources.length) fail("EVAL_CONTRACT", "Duplicate contract source id");
      const mapped = new Set<string>();
      for (const assertion of task.contract.assertions) {
        const grader = task.graders.find(item => item.id === assertion.graderId);
        if (!grader || mapped.has(assertion.graderId) || assertion.sourceIds.some(id => !sources.has(id))) fail("EVAL_CONTRACT", "Invalid assertion or source reference");
        mapped.add(assertion.graderId);
        const layer = grader.kind === "tool-call-count" ? "behavior" : grader.kind.startsWith("text-") ? "response" : "outcome";
        if (layer !== assertion.layer) fail("EVAL_CONTRACT", "Assertion layer does not match its grader");
        if (grader.required === false && layer !== "response") fail("EVAL_CONTRACT", "Outcome and behavior assertions must be required");
      }
      if (mapped.size !== task.graders.length) fail("EVAL_CONTRACT", "Every grader needs a sourced assertion");
      if (!task.contract.assertions.some(assertion => assertion.layer === "outcome")) fail("EVAL_CONTRACT", "Gold contracts need an outcome assertion");
    }
  }
  return suite;
}

/** O_NOFOLLOW plus regular-file identity and hardlink checks; bounded even if a file grows. */
export async function readPlainFile(path: string, limit: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail("EVAL_UNSAFE_FILE", "Expected a regular file with a single link");
    if (stat.size > limit) fail("EVAL_SIZE", "Evaluation input exceeds its byte limit");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const chunk = await file.read(buffer, size, buffer.length - size, null);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (size > limit) fail("EVAL_SIZE", "Evaluation input exceeds its byte limit");
    const after = await file.stat();
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || after.nlink !== 1) fail("EVAL_FILE_CHANGED", "File changed while grading");
    return buffer.subarray(0, size).toString("utf8");
  } finally { await file.close(); }
}

export async function readSuite(path: string): Promise<EvaluationSuite> {
  const text = await readPlainFile(path, SUITE_BYTE_LIMIT);
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("EVAL_PARSE", "Evaluation suite must contain valid JSON"); }
  return validateSuite(value);
}

/** Check every ancestor: O_NOFOLLOW on the leaf alone does not reject directory aliases. */
export async function readWorkspaceFile(workspace: string, path: string): Promise<string> {
  validateTaskPath(path);
  const root = resolve(workspace), parts = path.split("/");
  const identities: { path: string; dev: number; ino: number }[] = [];
  let current = root;
  for (const part of ["", ...parts.slice(0, -1)]) {
    if (part) current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("EVAL_UNSAFE_FILE", "Workspace ancestors must be real directories");
    identities.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  if (await realpath(root) !== root) fail("EVAL_UNSAFE_FILE", "Workspace root must not be aliased");
  const text = await readPlainFile(join(root, path), GRADER_FILE_BYTE_LIMIT);
  for (const expected of identities) {
    const actual = await lstat(expected.path);
    if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino) fail("EVAL_FILE_CHANGED", "Workspace ancestor changed while grading");
  }
  return text;
}
