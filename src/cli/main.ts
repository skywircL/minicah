#!/usr/bin/env node
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { access, realpath, lstat, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Runtime } from "../runtime.js";
import { HarnessError, fail } from "../errors.js";
import { createSessionPlugin, createContextPlugin, sessionLogPath } from "../session/plugins.js";
import { createPermissionPlugin } from "../permissions.js";
import { createToolPipelinePlugin } from "../tool-pipeline.js";
import { createDeepSeekPlugin, deepSeekConfig } from "../agent/deepseek.js";
import { createPiPlugin, piConfig, piApiKey, listPiModels, PI_API_KEY_ENV } from "../agent/pi.js";
import { createCodingToolsPlugin } from "../agent/workspace.js";
import { createExecutionPlugin } from "../agent/execution.js";
import { createSandboxExecutionPlugin } from "../agent/sandbox-execution.js";
import { createDockerSandboxPlugin, createSeatbeltSandboxPlugin } from "../sandbox/plugin.js";
import { createAgentLoopPlugin } from "../agent/loop.js";
import { createCompactionPlugin } from "../agent/compaction.js";
import { approvalUi, type AgentRunOptions } from "../agent/contracts.js";
import { createCliPlugin, replayCli, terminalText } from "./plugin.js";
import { loadCliEnvironment } from "./environment.js";
import { createSessionCatalogPlugin } from "../session/catalog.js";
import { createCliCommandsPlugin } from "./commands.js";
import { CliSessions } from "./sessions.js";
import { createHotReloadPlugin } from "../hot-reload/index.js";
import { createObservabilityPlugin } from "../observability/index.js";
import { createObservabilityCommandsPlugin } from "./observability-commands.js";

const HELP = `minicah — 插件化 Coding Agent (DeepSeek / Pi)

  npm run agent -- --workspace ./project --task "查看项目并修复失败的测试"

  --workspace PATH    工作目录，默认当前目录
  --task TEXT         单次任务；省略时进入交互模式
  --completion-contract PATH  为本次 --task 提供公开完成条件 JSON（不自动读取工作区配置）
  --read-only         仅注册读取/搜索工具
  --sandbox MODE      命令执行环境：host（默认）、native（macOS）或 docker
  --sandbox-image REF Docker 镜像，必须固定 @sha256 摘要；可用 MINICAH_SANDBOX_IMAGE
  --provider NAME     deepseek（默认，直连）或 pi（复用 Pi 多模型适配）
  --pi-provider NAME  Pi 厂商，例如 openai、anthropic、google；Pi 模式必填
  --model NAME        DeepSeek 默认 deepseek-flash；Pi 模式必填
  --list-models       输出本地 Pi 模型目录，可用 --pi-provider 筛选；无需密钥
  --endpoint URL      覆盖模型 endpoint；直连也可用 DEEPSEEK_BASE_URL
  --thinking          启用直连 DeepSeek thinking
  --reasoning LEVEL   Pi 思考级别：off（默认）、minimal、low、medium、high、xhigh、max
  --resume ID         恢复 Session，输入新的任务；不自动重做历史操作
  --replay ID         只读展示历史与未结算调用，无需密钥
  --context-window N  上下文窗口；DeepSeek 默认 1000000，Pi 使用模型目录值
  --max-output-tokens N  单次输出上限，默认 4096
  --max-request-bytes N  单次请求字节上限，默认 4194304
  --no-auto-compact   关闭自动上下文压缩
  --config PATH       热更新 JSON，默认工作区 .minicah/config.json
  --no-watch          关闭自动监听，仍可使用 /reload
  --watch-poll        使用轮询监听（网络文件系统或原生监听受限时）
  --watch-code PATH   监听源码文件；变化时提示需要重启，可重复指定
  --help              显示帮助

自动读取启动目录中的 .env；已有环境变量优先。
密钥按厂商读取，如 DEEPSEEK_API_KEY、OPENAI_API_KEY、ANTHROPIC_API_KEY、GEMINI_API_KEY。
Pi 支持目录中模型的 API key 接入；思考级别必须受所选模型支持。
写文件和命令逐次审批；非 TTY 默认拒绝。
Docker 命令在无网络的临时工作区副本中执行，排除凭据与元数据，修改不回写。
native 使用 macOS sandbox-exec，无需 Docker；首版禁止子进程，适合单进程命令和 PTC。
需要派生子进程的 npm test 等命令请显式选择 docker 或 host。
源码修改仍使用经审批的 write_file/edit_file。指定 Docker 后失败不会回退至宿主机。
Ctrl-C 取消当前 run。流式文字是临时显示，最终状态以 [已持久提交] 为准。
交互内命令：/history [关键词]、/resume [ID]、/new、/replay、/status、/metrics [runId]、/trace [runId]、/reload、/plugins、/help、/exit。
热更新 JSON 覆盖启动配置；移除字段或删除文件恢复启动值。密钥仍只从环境读取。
`;
async function main(): Promise<number> {
  const { values } = parseArgs({ options: {
    workspace: { type: "string" }, task: { type: "string" }, "completion-contract": { type: "string" }, "read-only": { type: "boolean" }, sandbox: { type: "string" }, "sandbox-image": { type: "string" }, model: { type: "string" }, endpoint: { type: "string" }, thinking: { type: "boolean" },
    provider: { type: "string" }, "pi-provider": { type: "string" }, reasoning: { type: "string" }, "list-models": { type: "boolean" },
    resume: { type: "string" }, replay: { type: "string" }, "context-window": { type: "string" }, "max-output-tokens": { type: "string" }, "max-request-bytes": { type: "string" }, "no-auto-compact": { type: "boolean" }, help: { type: "boolean", short: "h" },
    config: { type: "string" }, "no-watch": { type: "boolean" }, "watch-poll": { type: "boolean" }, "watch-code": { type: "string", multiple: true },
  }, strict: true });
  if (values.help) { process.stdout.write(HELP); return 0; }
  if (values["list-models"]) { process.stdout.write(JSON.stringify(listPiModels(values["pi-provider"]), null, 2) + "\n"); return 0; }
  const provider = values.provider ?? "deepseek";
  if (provider !== "deepseek" && provider !== "pi") fail("CLI_ARGUMENT", "--provider must be deepseek or pi");
  if (provider !== "pi" && (values["pi-provider"] !== undefined || values.reasoning !== undefined)) fail("CLI_ARGUMENT", "--pi-provider / --reasoning require --provider pi");
  if (provider === "pi" && values.thinking !== undefined) fail("CLI_ARGUMENT", "Pi 模式使用 --reasoning，不接受 --thinking");
  if (values.resume && values.replay) fail("CLI_ARGUMENT", "Choose --resume or --replay");
  if (values.replay && values.task) fail("CLI_ARGUMENT", "--replay cannot execute a task");
  if (values["completion-contract"] && (!values.task || values.replay || values.task.trim().startsWith("/"))) fail("CLI_ARGUMENT", "--completion-contract requires a single --task prompt");
  let agentOptions: AgentRunOptions | undefined;
  if (values["completion-contract"]) {
    const text = await readFile(resolve(values["completion-contract"]), "utf8");
    if (Buffer.byteLength(text) > 65536) fail("CLI_ARGUMENT", "Completion contract is too large");
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("CLI_ARGUMENT", "Completion contract must be an object");
      agentOptions = { completion: parsed as NonNullable<AgentRunOptions["completion"]> };
    }
    catch { fail("CLI_ARGUMENT", "Completion contract must be valid JSON"); }
  }
  if (!values.replay) await loadCliEnvironment();
  const executionMode = values.sandbox ?? "host";
  if (executionMode !== "host" && executionMode !== "docker" && executionMode !== "native") fail("CLI_ARGUMENT", "--sandbox must be host, native or docker");
  const sandboxImage = values["sandbox-image"] ?? process.env.MINICAH_SANDBOX_IMAGE;
  if (!values.replay && executionMode === "docker" && !sandboxImage) fail("SANDBOX_IMAGE_REQUIRED", "Docker 模式需要 --sandbox-image 或 MINICAH_SANDBOX_IMAGE，镜像必须固定 @sha256 摘要。");
  if (values["sandbox-image"] && executionMode !== "docker") fail("CLI_ARGUMENT", "--sandbox-image requires --sandbox docker");
  if (!values.replay && !values.task && !process.stdin.isTTY) fail("CLI_ARGUMENT", "非交互运行需要 --task");
  const number = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) fail("CLI_ARGUMENT", "容量参数必须为正整数");
    return parsed;
  };
  if (!values.replay && provider === "pi" && (!values["pi-provider"] || !values.model)) fail("CLI_ARGUMENT", "Pi 模式需要 --pi-provider 和 --model；--list-models 查看可用目录");
  const modelConfig = values.replay ? {} : provider === "pi" ? { ...piConfig({
    provider: values["pi-provider"]!, model: values.model!, reasoning: values.reasoning ?? "off",
    ...(values.endpoint !== undefined ? { endpoint: values.endpoint } : {}),
    ...(values["context-window"] !== undefined ? { contextWindow: number(values["context-window"], 1) } : {}),
    ...(values["max-output-tokens"] !== undefined ? { maxOutputTokens: number(values["max-output-tokens"], 4096) } : {}),
  }) } : { ...deepSeekConfig({ model: values.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-flash", endpoint: values.endpoint ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com", thinking: values.thinking ?? false, contextWindow: number(values["context-window"], 1_000_000), maxOutputTokens: number(values["max-output-tokens"], 4096) }) };
  if (!values.replay && !(provider === "pi" ? piApiKey(values["pi-provider"]!) : process.env.DEEPSEEK_API_KEY)) {
    const keyName = provider === "pi" ? PI_API_KEY_ENV[values["pi-provider"]!] : "DEEPSEEK_API_KEY";
    fail("MODEL_KEY_MISSING", `请先在本地设置 ${keyName} 环境变量，不要把密钥发到聊天中。`);
  }
  const root = await realpath(values.workspace ?? process.cwd()), directory = join(root, ".minicah", "sessions");
  for (const path of [join(root, ".minicah"), directory]) {
    try { if ((await lstat(path)).isSymbolicLink()) fail("WORKSPACE_SYMLINK", "Session directory cannot be a symlink"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const id = values.replay ?? values.resume ?? randomUUID();
  if (values.resume || values.replay) {
    try { await access(sessionLogPath(directory, id)); } catch { fail("SESSION_NOT_FOUND", "找不到指定的 Session"); }
  } else await mkdir(directory, { recursive: true, mode: 0o700 });
  const sessionPlugins = [createSessionPlugin({ directory, durability: "fsync" }), createContextPlugin(), createObservabilityPlugin()];
  const executionPlugins = values.replay ? [] : executionMode === "docker"
    ? [createDockerSandboxPlugin({ image: sandboxImage!, workspace: root, memoryMiB: 512 }), createSandboxExecutionPlugin(root)]
    : executionMode === "native" ? [createSeatbeltSandboxPlugin({ workspace: root }), createSandboxExecutionPlugin(root)]
    : [createExecutionPlugin()];
  const configurable = [provider === "pi" ? createPiPlugin() : createDeepSeekPlugin(), createCompactionPlugin(), createAgentLoopPlugin(), ...executionPlugins.filter(plugin => plugin.configMode === "run")];
  const hotReload = createHotReloadPlugin({ path: resolve(values.config ?? join(root, ".minicah", "config.json")),
    watch: !(values["no-watch"] ?? false), usePolling: values["watch-poll"] ?? false, codePaths: values["watch-code"] ?? [],
    catalog: configurable.map(plugin => ({ plugin, toggle: false })),
  });
  const cli = createCliPlugin({ commandExecutionMode: executionMode, hotReload, ...(agentOptions ? { agentOptions } : {}) });
  const runtime = await Runtime.create({
    plugins: values.replay ? sessionPlugins : [
      ...sessionPlugins, createSessionCatalogPlugin(directory, root), createCliCommandsPlugin(), createObservabilityCommandsPlugin(), cli.plugin, hotReload.plugin, ...configurable,
      ...executionPlugins.filter(plugin => plugin.configMode !== "run"), createCodingToolsPlugin(root, values["read-only"] ?? false, executionMode),
      createPermissionPlugin(), createToolPipelinePlugin({ deadlineMs: 180_000 }, true, approvalUi),
    ],
    config: values.replay ? {} : {
      [provider === "pi" ? "pi-model" : "deepseek-model"]: modelConfig,
      permissions: { workspace: root, policyVersion: "coding-cli-v1", ttlMs: 120_000 },
      "coding-agent-loop": { maxRequestBytes: number(values["max-request-bytes"], 4 * 1024 * 1024) },
      "context-compaction": { auto: !(values["no-auto-compact"] ?? false) },
    },
  });
  try {
    if (!values.replay) {
      hotReload.subscribe(report => {
        if (report.source === "manual" || report.status === "unchanged") return;
        process.stderr.write(terminalText(`[热更新] ${report.status}; config=v${report.configurationVersion}${report.code ? `; ${report.code}` : ""}\n`));
      });
      const report = await hotReload.start(runtime);
      if (report.status === "failed" || report.status === "restart-required") fail("HOT_RELOAD_START", `启动配置未生效：${report.code}；修正配置后重新启动。`);
    }
    const session = await runtime.openSession(id);
    if (values.replay) { await replayCli(session); return 0; }
    return await cli.start(new CliSessions(runtime, session, root), values.task);
  } finally { try { await hotReload.stop(); } finally { await runtime.close(); } }
}
try { process.exitCode = await main(); }
catch (error) {
  const message = error instanceof HarnessError ? `${error.code}: ${error.message}` : error instanceof Error && error.name === "TypeError" ? error.message : "运行失败；请检查参数、工作目录或未清理资源。未确认成功的操作不会被自动重试。";
  process.stderr.write(terminalText(message) + "\n"); process.exitCode = 1;
}
