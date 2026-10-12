import { fail } from "./errors.js";
import { freezeJson } from "./plan.js";
import { registryToken } from "./registry.js";
import type { ToolDefinition } from "./types.js";

export const toolRegistry = registryToken<ToolDefinition>("tools", tool => {
  if (!tool || typeof tool.name !== "string" || !tool.name.trim() || typeof tool.description !== "string" || typeof tool.execute !== "function") fail("INVALID_REGISTRATION", "A tool needs a name, description and execute function");
  if (tool.effect !== undefined && !["read", "idempotent-write", "non-idempotent-write"].includes(tool.effect)) fail("INVALID_REGISTRATION", "Invalid tool effect");
  return { name: tool.name, description: tool.description, inputSchema: freezeJson(tool.inputSchema), execute: tool.execute, ...(tool.effect ? { effect: tool.effect } : {}) };
});
