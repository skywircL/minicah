import type { JsonValue } from "../types.js";
import type { SessionEvent } from "../session/types.js";
import { canonical } from "../json.js";

export const TOKEN_ESTIMATOR = "weighted-json-v1";
function object(value: JsonValue): Readonly<Record<string, JsonValue>> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, JsonValue>> : null;
}

/** Local admission estimate, not a tokenizer or a billing guarantee. */
export function baseEstimate(request: JsonValue): number {
  const body = object(request);
  const material = body && Array.isArray(body.messages)
    ? { messages: body.messages, tools: body.tools ?? [], response_format: body.response_format ?? null, tool_choice: body.tool_choice ?? null }
    : request;
  let units = 0;
  for (const char of JSON.stringify(material)) {
    // ASCII/code and non-ASCII have different densities; never equate UTF-8 bytes with tokens.
    units += char.codePointAt(0)! <= 0x7f ? 1 / 3 : Math.max(1, Buffer.byteLength(char) / 2);
  }
  const messages = body && Array.isArray(body.messages) ? body.messages.length : 0;
  const tools = body && Array.isArray(body.tools) ? body.tools.length : 0;
  return Math.ceil((units + 24 + messages * 8 + tools * 16) * 1.2);
}

/** Replay a matching request anchor; spending across earlier calls is never added to pressure. */
export function measurePrompt(request: JsonValue, events: readonly SessionEvent[], modelHash: string) {
  const estimatedPromptTokens = baseEstimate(request);
  const header = (body: JsonValue) => {
    const record = object(body);
    return canonical(record ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== "messages")) : body);
  };
  const requests = new Map(events.flatMap(event => event.data.type === "model.requested" && event.callId ? [[event.callId, event] as const] : []));
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.data.type !== "model.completed") continue;
    const prior = requests.get(event.callId!);
    if (prior?.data.type !== "model.requested" || prior.data.purpose === "compaction") continue;
    const completion = object(object(event.data.response)?.completion ?? null);
    const usage = object(completion?.usage ?? null), inputTokens = usage?.prompt;
    if (prior.versions?.model.hash !== modelHash || header(prior.data.request) !== header(request)) break;
    if (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0) break;
    const anchorEstimate = baseEstimate(prior.data.request);
    if (inputTokens < anchorEstimate) break;
    return { promptTokens: Math.max(0, inputTokens + estimatedPromptTokens - anchorEstimate), estimatedPromptTokens, anchorCallId: event.callId, estimator: "surface-anchor-v1", calibration: 1 };
  }
  return { promptTokens: estimatedPromptTokens, estimatedPromptTokens, anchorCallId: null, estimator: TOKEN_ESTIMATOR, calibration: 1 };
}

export function outputReservation(request: JsonValue, cap: number): number {
  const value = object(request)?.max_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : cap;
}
