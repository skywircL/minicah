import { relative } from "node:path";
import { Runtime } from "../runtime.js";
import { API_VERSION, type JsonValue, type Plugin } from "../types.js";
import { services } from "../services.js";
import { fail, HarnessError } from "../errors.js";
import { definition } from "../session/json.js";
import { createSessionPlugin, createContextPlugin, sessionLogPath } from "../session/plugins.js";
import { createCodingToolsPlugin } from "../agent/workspace.js";
import { createAgentLoopPlugin } from "../agent/loop.js";
import { createCompactionPlugin } from "../agent/compaction.js";
import { deepSeekConfig, deepSeekModel } from "../agent/deepseek.js";
import { piConfig, piModel, piApiKey } from "../agent/pi.js";
import type { AgentResult, AgentRunOptions, Message, ModelService } from "../agent/contracts.js";
import { createPermissionPlugin } from "../permissions.js";
import { createToolPipelinePlugin, type PolicyRequest } from "../tool-pipeline.js";
import { createPtcPlugin, projectPtcOutput } from "../ptc/runtime.js";
import { createDockerSandboxPlugin, createSeatbeltSandboxPlugin } from "../sandbox/plugin.js";
import { createObservabilityPlugin, observabilityService } from "../observability/index.js";
import type { ObservabilityReport } from "../observability/index.js";
import type { TrialExecutor, TrialExecutionResult, ToolTraceEvidence } from "./types.js";
import { projectToolTrace } from "./evidence.js";

export interface CodingExecutorOptions {
  readonly provider?: "fixture" | "deepseek" | "pi";
  readonly modelConfig?: JsonValue;
  readonly apiKey?: () => string | undefined;
  readonly allowWrites?: boolean;
  readonly sandbox?: "native" | "docker";
  readonly sandboxImage?: string;
  /** Trusted test/application injection; never loaded from the dataset. */
  readonly modelFactory?: () => ModelService;
  /** Trusted application policy compiled from public inputs only; no graders or reference answers. */
  readonly agentOptions?: (task: { readonly id: string; readonly prompt: string; readonly files?: Readonly<Record<string, string>> }) => AgentRunOptions;
}
const bindings = ["list_files", "read_file", "search_text"];

/** Scripted integration fixture, not a reasoning model or a benchmark baseline. */
export function fixtureModel(mode: "native" | "ptc"): ModelService {
  return {
    definition: () => definition("model", "scripted-smoke", "1.0.0", { script: "read-input-uppercase", mode }),
    limits: () => ({ contextWindow: 32768, maxOutputTokens: 1024 }),
    prepare: (messages, tools) => ({ messages: messages as unknown as JsonValue, tools: tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })), max_tokens: 1024 }),
    async complete(request, options) {
      options?.signal?.throwIfAborted();
      const messages = (request as { messages: unknown }).messages as Message[];
      const result = messages.findLast(message => message.role === "tool");
      if (!result) {
        const args = mode === "native" ? { path: "input.txt" } : { program: 'const r = await tools.read_file({path:"input.txt"}); if(r.status !== "completed") throw new Error("READ_FAILED"); return r.value.text.trim().toUpperCase();', input: null };
        return { message: { role: "assistant", content: null, tool_calls: [{ id: "fixture-read", type: "function", function: { name: mode === "native" ? "read_file" : "run_program", arguments: JSON.stringify(args) } }] }, finishReason: "tool_calls", usage: null, providerId: "fixture-1" };
      }
      const parsed = JSON.parse(result.content ?? "null") as { value?: { text?: string; output?: unknown } };
      const text = mode === "native" ? String(parsed.value?.text ?? "").trim().toUpperCase() : extractPtcText(parsed.value);
      return { message: { role: "assistant", content: text }, finishReason: "stop", usage: null, providerId: "fixture-2" };
    },
  };
}
function extractPtcText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const output = (value as { output?: { value?: unknown } }).output?.value;
  return typeof output === "string" ? output : "";
}

function ptcBridge(): Plugin {
  return { id: "evaluation-ptc-bridge", version: "1.0.0", apiVersion: API_VERSION, scope: "session", provides: [], requires: [services.ptcRuntime],
    setup(ctx) {
      ctx.registerTool({ name: "run_program", effect: "read", description: 'Run an async JavaScript function body in an OS sandbox. Bindings: tools.list_files({path?}), tools.read_file({path,startLine?,lineCount?}), tools.search_text({query,path?}). Each returns {status,value,code}; read_file value contains text. Use input and return a JSON value. No network or write tools. Promise.all is allowed (up to 4 children).',
        inputSchema: { type: "object", additionalProperties: false, required: ["program", "input"], properties: { program: { type: "string", maxLength: 65536 }, input: {} } },
        async execute(input, run, execution) {
          const args = input as { program: string; input: JsonValue };
          const result = await run.services.get(services.ptcRuntime).evaluate({ ...args, bindings, ...(execution ? { parentCallId: execution.callId } : {}) }, execution?.signal);
          if (result.cleanup !== "verified" || result.status === "unknown") fail("CLEANUP_UNCONFIRMED", "PTC execution needs reconciliation");
          return projectPtcOutput(result, 24000);
        },
      });
    },
  };
}

/** Every trial owns its Runtime, Session, policy and workspace. No shell execution is exposed. */
export function createCodingTrialExecutor(options: CodingExecutorOptions = {}): TrialExecutor {
  return async request => {
    if (request.mode === "ptc" && (!options.sandbox || options.allowWrites)) return { status: "failed", cleanup: "verified", failureKind: "infrastructure", errorCode: "EVAL_PTC_POLICY" };
    if (request.mode === "ptc" && options.sandbox === "docker" && !options.sandboxImage) return { status: "failed", cleanup: "verified", failureKind: "infrastructure", errorCode: "SANDBOX_IMAGE_REQUIRED" };
    if (request.signal.aborted) return { status: "cancelled", cleanup: "verified" };
    const taskAllows = (name: string) => !request.executionPolicy || request.executionPolicy.allowedTools.some(tool => tool === name);
    const modelPlugin: Plugin = { id: "evaluation-model", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [services.model], requires: [],
      validateConfig: () => ({ provider: options.modelFactory ? "injected" : options.provider ?? "fixture", mode: request.mode, allowWrites: options.allowWrites ?? false, executionPolicy: request.executionPolicy ? { ...request.executionPolicy } : null, model: options.provider === "pi" ? { ...piConfig(options.modelConfig) } : options.provider === "deepseek" ? { ...deepSeekConfig(options.modelConfig) } : null }),
      setup(ctx) { ctx.provide(services.model, () => {
        const config = options.provider === "pi" ? piConfig(options.modelConfig) : undefined;
        const key = options.provider === "pi" ? options.apiKey?.() ?? piApiKey(config!.provider) : options.provider === "deepseek" ? options.apiKey?.() ?? process.env.DEEPSEEK_API_KEY : undefined;
        if ((options.provider === "deepseek" || options.provider === "pi") && !options.modelFactory && !key) fail("MODEL_KEY_MISSING", "The selected model provider requires an API key");
        const model = options.modelFactory?.() ?? (config ? piModel(config, key!) : options.provider === "deepseek" ? deepSeekModel(deepSeekConfig(options.modelConfig), key!) : fixtureModel(request.mode));
        return { definition: () => model.definition(), ...(model.limits ? { limits: () => model.limits!() } : {}), complete: (request, options) => model.complete(request, options),
          prepare: (messages, tools, output) => model.prepare(messages, tools.filter(tool => request.mode === "ptc" ? tool.name === "run_program" : tool.name !== "run_command" && taskAllows(tool.name)), output) };
      }); },
    };
    const allowed = (p: PolicyRequest) => p.source === "ptc" ? bindings.includes(p.tool.name) && taskAllows(p.tool.name) : request.mode === "ptc" ? p.tool.name === "run_program" : taskAllows(p.tool.name) && (bindings.includes(p.tool.name) || !!options.allowWrites && ["write_file", "edit_file"].includes(p.tool.name));
    const denyExecution: Plugin = { id: "evaluation-no-shell", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [services.execution], requires: [], setup(ctx) {
      ctx.provide(services.execution, () => ({ execute: async () => fail("EVAL_COMMAND_DENIED", "Evaluation adapter does not permit shell commands") }));
    } };
    const sandboxPlugins = request.mode !== "ptc" ? [] : [options.sandbox === "native" ? createSeatbeltSandboxPlugin() : createDockerSandboxPlugin({ image: options.sandboxImage! }), createPtcPlugin(), ptcBridge()];
    const runtime = await Runtime.create({ plugins: [createSessionPlugin({ directory: request.logDirectory, durability: "fsync", maxBytes: 16 * 1024 * 1024 }), createContextPlugin(), createObservabilityPlugin(), modelPlugin,
      createCompactionPlugin(), createAgentLoopPlugin(), denyExecution, createCodingToolsPlugin(request.workspace, !options.allowWrites), createPermissionPlugin(),
      createToolPipelinePlugin({ concurrency: 8, deadlineMs: 120000, policy: { authorize: p => ({ decision: allowed(p) ? "allow" : "deny", reason: "evaluation-scoped-policy-v1" }), assertCurrent: p => { if (!allowed(p)) fail("EVAL_POLICY", "Dispatch denied"); } },
        approve: async (approval, signal) => ({ binding: approval.binding, decision: !signal.aborted && approval.binding.workspace === request.workspace && ["write_file", "edit_file"].includes(approval.binding.tool.name) && options.allowWrites && request.executionPolicy?.writeApproval !== "deny" ? "allow" : "deny" }),
      }, true), ...sandboxPlugins], config: { permissions: { workspace: request.workspace, policyVersion: "evaluation-v1", ttlMs: 120000 } } });
    let result: AgentResult | undefined, metrics: ObservabilityReport | undefined, toolTrace: ToolTraceEvidence | undefined;
    let failed = false, cleanup = true, failureCode: string | undefined;
    const id = request.trialId;
    try {
      const session = await runtime.openSession(id);
      await session.run(async run => {
        try {
          const publicTask = { id: request.task.id, prompt: request.task.prompt, ...(request.task.files ? { files: request.task.files } : {}) };
          result = await run.services.get(services.agentLoop).run(request.task.prompt, request.signal, options.agentOptions?.(publicTask));
        }
        finally {
          metrics = run.services.get(observabilityService).snapshot();
          toolTrace = projectToolTrace(run.services.get(services.session).events(), run.id);
        }
      });
    } catch (error) { failed = true; failureCode = error instanceof HarnessError ? error.code : "EVAL_AGENT_RUNTIME_FAILED"; }
    finally { try { await runtime.close(); } catch { cleanup = false; } }
    cleanup &&= !runtime.health().restartRequired && runtime.health().unresolved.length === 0;
    if (metrics?.calls.some(call => call.status === "unknown" || call.status === "unfinished")) cleanup = false;
    const status: TrialExecutionResult["status"] = !cleanup || result?.status === "needs-reconciliation" ? "unknown" : request.signal.aborted || result?.status === "cancelled" ? "cancelled" : !failed && result?.status === "completed" ? "completed" : "failed";
    // HTTP/provider and harness faults are infrastructure failures, not evidence of reasoning quality.
    const infrastructure = failed || result?.status === "failed" && (result.text.startsWith("MODEL_HTTP_") || ["MODEL_OR_AGENT_ERROR", "MODEL_PROVIDER_ERROR", "MODEL_PROTOCOL", "MODEL_TIMEOUT", "MODEL_KEY_MISSING", "INVALID_EVENT", "INVALID_CONFIG", "JOURNAL_LIMIT"].includes(result.text));
    return { status, cleanup: cleanup ? "verified" : "unconfirmed", ...(result ? { finalText: result.text, runId: result.runId } : {}), sessionId: id,
      ...(result?.status === "failed" && result.text === "COMPLETION_PROTECTED_CHANGED" ? { confirmedFailure: "COMPLETION_PROTECTED_CHANGED" as const, errorCode: "COMPLETION_PROTECTED_CHANGED" } : {}),
      ...(toolTrace ? { toolTrace } : {}),
      journalRefs: [relative(request.logDirectory, sessionLogPath(request.logDirectory, id))],
      ...(metrics ? { metrics: { schemaVersion: 1, timingBasis: metrics.timingBasis, throughSeq: metrics.throughSeq, run: metrics.runs.at(-1) ?? null } as unknown as JsonValue } : {}),
      ...(infrastructure ? { failureKind: "infrastructure" as const, errorCode: failureCode ?? result?.text ?? "EVAL_AGENT_RUNTIME_FAILED" } : {}) };
  };
}
