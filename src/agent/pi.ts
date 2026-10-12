import { Ajv } from "ajv";
import { createModels, getSupportedThinkingLevels, hasApi } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import type { Api, AssistantMessage, Context, Message as PiMessage, Model, ModelThinkingLevel, Tool, Usage } from "@earendil-works/pi-ai";
import { API_VERSION, type JsonValue, type Plugin } from "../types.js";
import { services } from "../services.js";
import { canonical, contentHash, immutable } from "../json.js";
import { definition } from "../session/json.js";
import { fail, HarnessError } from "../errors.js";
import type { Message, ModelService, ProviderCall } from "./contracts.js";

const factories = { openai: openaiProvider, anthropic: anthropicProvider, google: googleProvider, deepseek: deepseekProvider,
  openrouter: openrouterProvider, xai: xaiProvider, groq: groqProvider, mistral: mistralProvider };
export const PI_API_KEY_ENV: Readonly<Record<string, string>> = Object.freeze({ openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY", openrouter: "OPENROUTER_API_KEY", xai: "XAI_API_KEY", groq: "GROQ_API_KEY", mistral: "MISTRAL_API_KEY" });
export function piApiKey(provider: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[PI_API_KEY_ENV[provider] ?? ""] || (provider === "google" ? env.GOOGLE_API_KEY : undefined);
}
function collection(provider: string) {
  if (!Object.hasOwn(factories, provider)) fail("INVALID_CONFIG", `Unsupported Pi provider: ${provider}`);
  const models = createModels();
  models.setProvider(factories[provider as keyof typeof factories]());
  return models;
}
export function listPiModels(provider?: string) {
  return immutable((provider ? [provider] : Object.keys(factories)).flatMap(id => collection(id).getModels(id).map(model => ({
    provider: id, id: model.id, api: model.api, contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens,
    reasoning: model.reasoning, reasoningLevels: getSupportedThinkingLevels(model),
  }))));
}
export interface PiConfig {
  readonly provider: string; readonly model: string; readonly endpoint?: string; readonly reasoning: ModelThinkingLevel;
  readonly contextWindow: number; readonly maxOutputTokens: number; readonly timeoutMs: number; readonly maxResponseBytes: number;
}
const validate = new Ajv({ strict: true }).compile({ type: "object", additionalProperties: false,
  required: ["provider", "model"], properties: {
    provider: { type: "string", enum: Object.keys(factories) }, model: { type: "string", minLength: 1, maxLength: 256 }, endpoint: { type: "string", minLength: 1 },
    reasoning: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    contextWindow: { type: "integer", minimum: 2, maximum: 100_000_000 }, maxOutputTokens: { type: "integer", minimum: 1, maximum: 1_000_000 },
    timeoutMs: { type: "integer", minimum: 1, maximum: 3_600_000 }, maxResponseBytes: { type: "integer", minimum: 1024, maximum: 16 * 1024 * 1024 },
  } });
export function piConfig(input: JsonValue | undefined): PiConfig {
  if (!validate(input)) fail("INVALID_CONFIG", "Pi configuration requires a supported provider and catalog model (see --list-models)");
  const raw = input as unknown as Partial<PiConfig> & Pick<PiConfig, "provider" | "model">;
  const model = collection(raw.provider).getModel(raw.provider, raw.model);
  if (!model) fail("INVALID_CONFIG", "Unknown Pi catalog model; use --list-models --pi-provider PROVIDER");
  const config: PiConfig = { reasoning: "off", contextWindow: model.contextWindow, maxOutputTokens: Math.min(4096, model.maxTokens), timeoutMs: 120_000, maxResponseBytes: 1024 * 1024, ...raw };
  if (config.contextWindow > model.contextWindow || config.maxOutputTokens > model.maxTokens || config.maxOutputTokens >= config.contextWindow) fail("INVALID_CONFIG", "Pi limits must fit the catalog model capacity");
  if (!getSupportedThinkingLevels(model).includes(config.reasoning)) fail("INVALID_CONFIG", `Unsupported reasoning level; model supports ${getSupportedThinkingLevels(model).join(", ")}`);
  outputCap(model, config.maxOutputTokens, config.reasoning);
  if (config.endpoint !== undefined) {
    let url: URL;
    try { url = new URL(config.endpoint); } catch { return fail("INVALID_CONFIG", "Invalid Pi endpoint"); }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) fail("INVALID_CONFIG", "Endpoint requires HTTPS (HTTP allowed for loopback tests only)");
    return immutable({ ...config, endpoint: url.href.replace(/\/$/, "") });
  }
  return immutable(config);
}

const zeroUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
// Pi types contain optional undefined fields. Persist the SDK's JSON representation, never its live partial object.
function jsonCopy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function visible(message: Message) { return { content: message.content, tool_calls: message.tool_calls ?? [] }; }
function contextMessages(messages: readonly Message[], route: string, model: Model<Api>): PiMessage[] {
  const names = new Map<string, string>();
  return messages.map(message => {
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
    if (message.role === "system" || message.role === "user") return { role: message.role, content: message.content ?? "", timestamp: 0 };
    if (message.role === "tool") {
      const name = names.get(message.tool_call_id ?? "");
      if (!name) fail("MODEL_PROTOCOL", "Tool result has no preceding assistant call");
      let isError = false;
      try { const result = JSON.parse(message.content ?? "null") as { status?: string } | null; isError = !!result?.status && result.status !== "completed"; } catch { /* Plain tool text is allowed. */ }
      return { role: "toolResult", toolCallId: message.tool_call_id!, toolName: name, content: [{ type: "text", text: message.content ?? "" }], isError, timestamp: 0 };
    }
    const replay = message.providerReplay as unknown as { format?: string; route?: string; publicHash?: string; nativeHash?: string; message?: AssistantMessage } | undefined;
    if (replay?.format === "pi-ai-v1" && replay.route === route) {
      const native = replay.message;
      if (replay.publicHash !== contentHash(visible(message)) || !native || native.role !== "assistant" || !Array.isArray(native.content) || replay.nativeHash !== contentHash(native) || native.provider !== model.provider || native.model !== model.id || native.api !== model.api) fail("MODEL_PROTOCOL", "Pi replay state does not match its source or public message");
      const calls = native.content.filter(block => block.type === "toolCall");
      if ((native.content.filter(block => block.type === "text").map(block => block.text).join("") || null) !== message.content || calls.length !== (message.tool_calls?.length ?? 0)) fail("MODEL_PROTOCOL", "Pi replay content mismatch");
      for (const [index, call] of calls.entries()) {
        const projected = message.tool_calls![index]!;
        if (call.id !== projected.id || call.name !== projected.function.name) fail("MODEL_PROTOCOL", "Pi replay call mismatch");
        let parsed: unknown;
        try { parsed = JSON.parse(projected.function.arguments); } catch { continue; } // Raw invalid JSON was rejected by the Host pipeline.
        if (canonical(parsed) !== canonical(call.arguments)) fail("MODEL_PROTOCOL", "Pi replay arguments mismatch");
      }
      return jsonCopy(native);
    }
    // Foreign histories deliberately carry no signatures or private reasoning. Pi normalizes tool IDs across APIs.
    const content: AssistantMessage["content"] = message.content ? [{ type: "text", text: message.content }] : [];
    for (const call of message.tool_calls ?? []) {
      let args: unknown;
      try { args = JSON.parse(call.function.arguments); } catch { args = {}; }
      content.push({ type: "toolCall", id: call.id, name: call.function.name, arguments: args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, JsonValue> : {} });
    }
    return { role: "assistant", content, api: "minicah-history", provider: "minicah-history", model: "history", usage: zeroUsage,
      stopReason: message.tool_calls?.length ? "toolUse" : "stop", timestamp: 0 };
  });
}

interface Request { format: "pi-model-v1"; route: string; provider: string; model: string; reasoning: ModelThinkingLevel; messages: PiMessage[]; tools: Tool[]; max_tokens: number }
/** Pi may increase output limits to accommodate thinking. The harness reservation remains the hard cap. */
function enforceOutputCap(payload: unknown, api: string, cap: number): unknown {
  if (!payload || typeof payload !== "object") fail("MODEL_PROTOCOL", "Invalid Pi payload");
  const body = payload as Record<string, any>; // Provider-owned payload; shapes depend on the selected protocol.
  if (api === "anthropic-messages") {
    body.max_tokens = Math.min(body.max_tokens ?? cap, cap);
    if (body.thinking?.type === "enabled") {
      if (body.max_tokens < 2048) fail("INVALID_CONFIG", "Budget-based thinking needs at least 2048 output tokens");
      body.thinking.budget_tokens = Math.min(body.thinking.budget_tokens, body.max_tokens - 1024);
    }
  } else if (api === "google-generative-ai") {
    body.config.maxOutputTokens = Math.min(body.config.maxOutputTokens ?? cap, cap);
    if (body.config.thinkingConfig?.thinkingBudget > 0) body.config.thinkingConfig.thinkingBudget = Math.min(body.config.thinkingConfig.thinkingBudget, Math.max(0, cap - 1024));
  } else if (api === "openai-responses") body.max_output_tokens = Math.min(body.max_output_tokens ?? cap, cap);
  else if (api === "openai-completions") {
    const field = "max_completion_tokens" in body ? "max_completion_tokens" : "max_tokens";
    body[field] = Math.min(body[field] ?? cap, cap);
  } else if (api === "mistral-conversations") body.maxTokens = Math.min(body.maxTokens ?? cap, cap);
  else fail("INVALID_CONFIG", "Unsupported Pi protocol");
  return body;
}
function outputCap(model: Model<Api>, cap: number, reasoning: ModelThinkingLevel) {
  if (!Number.isSafeInteger(cap) || cap < 1 || (model.api === "openai-responses" && cap < 16)) fail("INVALID_CONFIG", "Invalid output token reservation for Pi model");
  if (hasApi(model, "anthropic-messages") && reasoning !== "off" && model.compat?.forceAdaptiveThinking !== true && cap < 2048) fail("INVALID_CONFIG", "Budget-based thinking needs at least 2048 output tokens");
  if (model.api === "google-generative-ai" && reasoning !== "off" && cap < 2048) fail("INVALID_CONFIG", "Google thinking needs at least 2048 output tokens");
}

/** Pi 1.0.2 reports SDK failures as terminal messages; onResponse only sees successful responses. */
function errorStatus(message: string): number | undefined {
  const prefix = /^(?:[A-Za-z0-9_-]+ API error \()?([45]\d{2})(?:\):|:|\s|$)/.exec(message);
  if (prefix) return Number(prefix[1]);
  try {
    const parsed = JSON.parse(message) as { error?: { code?: unknown } } | null;
    const code = parsed?.error?.code;
    if (typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 599) return code;
  } catch { /* Unknown SDK formats stay generic and are never retried. */ }
  return undefined;
}

/** Pi owns protocol serialization, HTTP and SSE. Minicah owns replay, limits and failure admission. */
export function piModel(input: PiConfig, apiKey: string): ModelService {
  const config = piConfig(input as unknown as JsonValue), models = collection(config.provider);
  if (!apiKey?.trim()) fail("MODEL_KEY_MISSING", `Set ${PI_API_KEY_ENV[config.provider]} locally`);
  const model = jsonCopy({ ...models.getModel(config.provider, config.model)!, ...(config.endpoint ? { baseUrl: config.endpoint } : {}) });
  const route = contentHash({ provider: model.provider, model: model.id, api: model.api, endpoint: model.baseUrl });
  outputCap(model, config.maxOutputTokens, config.reasoning);
  return {
    limits: () => ({ contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens }),
    definition: () => definition("model", `${config.provider}/${config.model}`, `pi-adapter.1.${contentHash(config)}`, { adapter: "pi-ai", adapterVersion: "1.0.0", sdkVersion: "1.0.2", config: { ...config }, model: model as unknown as JsonValue }),
    prepare(messages, tools, maxOutputTokens = config.maxOutputTokens) {
      const cap = Math.min(config.maxOutputTokens, maxOutputTokens);
      outputCap(model, cap, config.reasoning);
      return immutable({ format: "pi-model-v1", route, provider: config.provider, model: config.model, reasoning: config.reasoning,
        messages: contextMessages(messages, route, model), tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })), max_tokens: cap }) as unknown as JsonValue;
    },
    async complete(request, options = {}) {
      const body = request as unknown as Request;
      if (!body || body.format !== "pi-model-v1" || body.route !== route || body.provider !== config.provider || body.model !== config.model || body.reasoning !== config.reasoning || !Array.isArray(body.messages) || !Array.isArray(body.tools) || body.max_tokens > config.maxOutputTokens) fail("MODEL_PROTOCOL", "Pi request does not match the run snapshot");
      outputCap(model, body.max_tokens, body.reasoning);
      const controller = new AbortController(), deadline = AbortSignal.timeout(config.timeoutMs);
      const signal = AbortSignal.any([controller.signal, deadline, ...(options.signal ? [options.signal] : [])]);
      let bytes = 0, providerBytes = 0, status: number | undefined, started = false, final: AssistantMessage | undefined, payloadError: unknown;
      const rawArguments = new Map<number, string>();
      const responseArguments = new Map<string, string>();
      const checkAbort = () => { options.signal?.throwIfAborted(); if (deadline.aborted) fail("MODEL_TIMEOUT", "Pi model stream deadline exceeded"); };
      const bounded = (value: string) => { bytes += Buffer.byteLength(value); if (bytes > config.maxResponseBytes) fail("MODEL_OUTPUT_LIMIT", "Pi response exceeded its byte limit"); };
      try {
        checkAbort();
        const cap = body.max_tokens, budget = Math.max(0, cap - 1024);
        const stream = models.streamSimple({ ...model, maxTokens: cap }, jsonCopy({ messages: body.messages, tools: body.tools }) as Context, {
          apiKey, signal, timeoutMs: config.timeoutMs, maxRetries: 0, transport: "sse", maxTokens: cap, cacheRetention: "none",
          ...(config.reasoning !== "off" ? { reasoning: config.reasoning } : {}),
          ...(model.api === "anthropic-messages" ? { thinkingBudgets: { minimal: Math.min(1024, budget), low: Math.min(2048, budget), medium: Math.min(8192, budget), high: Math.min(16384, budget) } } : {}),
          onPayload: payload => { try { return enforceOutputCap(payload, model.api, cap); } catch (error) { payloadError = error; throw error; } },
          onResponse: response => { status = response.status; },
          onProviderStreamEvent: data => {
            try {
              providerBytes += Buffer.byteLength(JSON.stringify(data));
              if (providerBytes > config.maxResponseBytes) fail("MODEL_OUTPUT_LIMIT", "Pi provider stream exceeded its byte limit");
              // Responses final arguments can replace earlier deltas. Never execute Pi's repaired JSON.
              const event = data as { type?: string; item_id?: string; arguments?: string; item?: { type?: string; id?: string; call_id?: string; arguments?: string } };
              if (model.api === "openai-responses") {
                if (event.type === "response.function_call_arguments.done" && event.item_id && typeof event.arguments === "string") responseArguments.set(event.item_id, event.arguments);
                if (["response.output_item.added", "response.output_item.done"].includes(event.type ?? "") && event.item?.type === "function_call" && event.item.id && typeof event.item.arguments === "string" && (event.item.arguments || event.type === "response.output_item.done")) responseArguments.set(event.item.id, event.item.arguments);
              }
            } catch (error) { payloadError = error; controller.abort(); throw error; }
          },
        });
        for await (const event of stream) {
          checkAbort();
          if (event.type === "start") { started = true; continue; }
          if (event.type === "error") {
            if (payloadError) throw payloadError;
            status = errorStatus(event.error.errorMessage ?? "") ?? status;
            const overflow = [400, 413].includes(status ?? 0) && isContextOverflow(event.error, config.contextWindow);
            if (overflow && !started) fail("MODEL_CONTEXT_OVERFLOW", "Provider rejected the context before generation");
            fail(status && status >= 400 ? `MODEL_HTTP_${status}` : "MODEL_PROVIDER_ERROR", "Pi provider request failed");
          }
          if (!started) fail("MODEL_PROTOCOL", "Pi stream update before start");
          if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") bounded(event.delta);
          if (event.type === "text_delta") options.onText?.(event.delta);
          if (event.type === "toolcall_delta") rawArguments.set(event.contentIndex, (rawArguments.get(event.contentIndex) ?? "") + event.delta);
          if (event.type === "done") { final = jsonCopy(event.message); break; }
        }
        checkAbort();
        if (!final || !["stop", "toolUse", "length"].includes(final.stopReason)) fail("MODEL_PROTOCOL", "Pi stream ended without an admitted terminal response");
        if (Buffer.byteLength(JSON.stringify(final)) > config.maxResponseBytes) fail("MODEL_OUTPUT_LIMIT", "Pi response exceeded its byte limit");
        let text = "";
        const calls: ProviderCall[] = [];
        for (const [index, part] of final.content.entries()) {
          if (part.type === "text") text += part.text;
          if (part.type !== "toolCall") continue;
          if (!part.id || part.id.length > 512 || !/^[a-zA-Z0-9_-]{1,64}$/.test(part.name) || calls.length >= 32) fail("MODEL_PROTOCOL", "Invalid Pi tool call identity");
          const responseId = part.id.split("|")[1];
          calls.push({ id: part.id, type: "function", function: { name: part.name, arguments: (responseId ? responseArguments.get(responseId) : undefined) ?? rawArguments.get(index) ?? JSON.stringify(part.arguments) } });
        }
        if (new Set(calls.map(call => call.id)).size !== calls.length || final.stopReason === "stop" && calls.length || final.stopReason === "toolUse" && !calls.length || final.stopReason === "stop" && !text.trim()) fail("MODEL_PROTOCOL", "Inconsistent or empty Pi response");
        const usage = final.usage;
        const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];
        if (counts.some(value => !Number.isSafeInteger(value) || value < 0)) fail("MODEL_PROTOCOL", "Invalid Pi usage");
        const message: Message = { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) };
        return immutable({ message: { ...message, providerReplay: { format: "pi-ai-v1", route, publicHash: contentHash(visible(message)), nativeHash: contentHash(final), message: final as unknown as JsonValue } },
          finishReason: final.stopReason === "toolUse" ? "tool_calls" : final.stopReason,
          // Pi initializes absent usage to zero. Do not invent zero-cost evidence when no tokens were reported.
          usage: counts.some(value => value > 0) ? { prompt: usage.input + usage.cacheRead + usage.cacheWrite, completion: usage.output, total: usage.totalTokens } : null,
          providerId: final.responseId ?? "" });
      } catch (error) {
        checkAbort();
        if (error instanceof HarnessError) throw error;
        fail("MODEL_PROVIDER_ERROR", "Pi provider request failed");
      } finally { controller.abort(); }
    },
  };
}

export function createPiPlugin(options: { apiKey?: () => string | undefined } = {}): Plugin {
  return { id: "pi-model", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", configMode: "run",
    validateConfig: value => ({ ...piConfig(value) }), provides: [services.model], requires: [],
    setup(ctx) { ctx.provide(services.model, run => {
      const config = piConfig(run.configuration.values[ctx.owner]);
      const key = options.apiKey ? options.apiKey() : piApiKey(config.provider);
      if (!key) fail("MODEL_KEY_MISSING", `Set ${PI_API_KEY_ENV[config.provider]} in the local environment`);
      return piModel(config, key);
    }); },
  };
}
