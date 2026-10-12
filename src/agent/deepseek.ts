import OpenAI from "openai";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import { Ajv } from "ajv";
import { API_VERSION, type JsonValue, type Plugin } from "../types.js";
import { services } from "../services.js";
import { contentHash, immutable } from "../json.js";
import { definition } from "../session/json.js";
import { fail } from "../errors.js";
import type { ModelCompletion, ModelService, ProviderCall } from "./contracts.js";

export interface DeepSeekConfig {
  readonly endpoint: string; readonly model: string; readonly thinking: boolean;
  readonly maxOutputTokens: number; readonly timeoutMs: number; readonly maxResponseBytes: number; readonly contextWindow: number;
}
const defaults: DeepSeekConfig = { endpoint: "https://api.deepseek.com", model: "deepseek-flash", thinking: false, maxOutputTokens: 4096, timeoutMs: 120_000, maxResponseBytes: 1024 * 1024, contextWindow: 1_000_000 };
const validate = new Ajv({ strict: true }).compile({ type: "object", additionalProperties: false,
  required: Object.keys(defaults), properties: {
    endpoint: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1, maxLength: 128 }, thinking: { type: "boolean" },
    contextWindow: { type: "integer", minimum: 2, maximum: 100_000_000 },
    maxOutputTokens: { type: "integer", minimum: 1, maximum: 131072 }, timeoutMs: { type: "integer", minimum: 1, maximum: 3_600_000 },
    maxResponseBytes: { type: "integer", minimum: 1024, maximum: 16 * 1024 * 1024 },
  } });
export function deepSeekConfig(input: JsonValue | undefined): DeepSeekConfig {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) fail("INVALID_CONFIG", "DeepSeek config must be an object");
  const config = { ...defaults, ...input as object };
  if (!validate(config)) fail("INVALID_CONFIG", "Invalid DeepSeek configuration");
  if (config.maxOutputTokens >= config.contextWindow) fail("INVALID_CONFIG", "Output reservation must be smaller than contextWindow");
  let url: URL;
  try { url = new URL(config.endpoint); } catch { return fail("INVALID_CONFIG", "Invalid model endpoint"); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) fail("INVALID_CONFIG", "Endpoint requires HTTPS (HTTP allowed for loopback tests only)");
  return immutable({ ...config, endpoint: url.href.replace(/\/$/, "") });
}

/** Reuses the SDK's HTTP/SSE implementation; no retry after ambiguous requests. */
export function deepSeekModel(config: DeepSeekConfig, apiKey: string): ModelService {
  const client = new OpenAI({ apiKey, baseURL: config.endpoint, maxRetries: 0, timeout: config.timeoutMs, organization: null, project: null, logLevel: "off" });
  return {
    limits: () => ({ contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens }),
    definition: () => definition("model", config.model, `deepseek-adapter.2.${contentHash(config)}`, { provider: "deepseek", protocol: "chat-completions", config: { ...config }, sdk: "openai", adapterVersion: "2.0.0" }),
    prepare(messages, tools, maxOutputTokens = config.maxOutputTokens) {
      return immutable({ model: config.model, messages: messages.map(({ providerReplay: _replay, ...message }) => message),
        max_tokens: Math.min(config.maxOutputTokens, maxOutputTokens), thinking: { type: config.thinking ? "enabled" : "disabled" },
        stream: true, stream_options: { include_usage: true },
        ...(tools.length ? { tools: tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
      }) as unknown as JsonValue;
    },
    async complete(request, options = {}) {
      const deadline = AbortSignal.timeout(config.timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      const stream = await client.chat.completions.create(request as unknown as ChatCompletionCreateParamsStreaming, { signal }).catch(error => {
        // Only an explicit rejection before streaming permits a changed-input retry.
        if (error instanceof OpenAI.APIError && [400, 413].includes(error.status ?? 0) &&
          (["context_length_exceeded", "context_window_exceeded"].includes(error.code ?? "") ||
            /maximum context length.{0,80}tokens|input tokens? exceed(?:s|ed)? the limit|context window (?:is )?exceeded/i.test(error.message))) {
          fail("MODEL_CONTEXT_OVERFLOW", "Provider rejected the request because its context window was exceeded");
        }
        throw error;
      });
      let text = "", reasoning = "", bytes = 0, providerId = "", finishReason = "";
      let usage: ModelCompletion["usage"] = null;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      try {
        for await (const chunk of stream) {
          bytes += Buffer.byteLength(JSON.stringify(chunk));
          if (bytes > config.maxResponseBytes) fail("MODEL_OUTPUT_LIMIT", "Model response exceeded its byte limit");
          providerId = chunk.id;
          if (chunk.usage) usage = { prompt: chunk.usage.prompt_tokens, completion: chunk.usage.completion_tokens, total: chunk.usage.total_tokens };
          if (chunk.choices.length > 1 || chunk.choices.some(choice => choice.index !== 0)) fail("MODEL_PROTOCOL", "Expected exactly one model choice");
          const choice = chunk.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          if (choice.delta.content) { text += choice.delta.content; options.onText?.(choice.delta.content); }
          const opaque = (choice.delta as unknown as Record<string, unknown>).reasoning_content;
          if (opaque !== undefined && opaque !== null && typeof opaque !== "string") fail("MODEL_PROTOCOL", "Invalid continuation field");
          if (typeof opaque === "string") reasoning += opaque;
          for (const part of choice.delta.tool_calls ?? []) {
            if (!Number.isSafeInteger(part.index) || part.index < 0 || part.index >= 32) fail("MODEL_PROTOCOL", "Too many or invalid tool calls");
            const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
            call.id += part.id ?? ""; call.name += part.function?.name ?? ""; call.arguments += part.function?.arguments ?? "";
            calls.set(part.index, call);
          }
        }
      } finally { stream.controller.abort(); }
      if (deadline.aborted) fail("MODEL_TIMEOUT", "Model stream deadline exceeded");
      signal.throwIfAborted();
      if (!finishReason) fail("MODEL_PROTOCOL", "Stream ended without a finish reason");
      const toolCalls: ProviderCall[] = [...calls].sort(([a], [b]) => a - b).map(([, call]) => {
        if (!call.id || call.id.length > 256 || !/^[a-zA-Z0-9_-]{1,64}$/.test(call.name)) fail("MODEL_PROTOCOL", "Invalid model tool call identity");
        return { id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } };
      });
      if (new Set(toolCalls.map(call => call.id)).size !== toolCalls.length || (toolCalls.length > 0 && finishReason === "stop") || (finishReason === "tool_calls" && !toolCalls.length)) fail("MODEL_PROTOCOL", "Inconsistent model tool calls");
      if (usage && Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0)) fail("MODEL_PROTOCOL", "Invalid token usage");
      return immutable({ message: { role: "assistant", content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finishReason, usage, providerId });
    },
  };
}

export function createDeepSeekPlugin(options: { apiKey?: () => string | undefined } = {}): Plugin {
  return { id: "deepseek-model", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", configMode: "run",
    validateConfig: value => ({ ...deepSeekConfig(value) }), provides: [services.model], requires: [],
    setup(ctx) {
      ctx.provide(services.model, run => {
        const key = (options.apiKey ?? (() => process.env.DEEPSEEK_API_KEY))();
        if (!key) fail("MODEL_KEY_MISSING", "Set DEEPSEEK_API_KEY in the local environment");
        return deepSeekModel(deepSeekConfig(run.configuration.values[ctx.owner]), key);
      });
    },
  };
}
