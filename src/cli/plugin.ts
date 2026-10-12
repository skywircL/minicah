import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { API_VERSION, type Plugin, type RunOptions } from "../types.js";
import type { Session } from "../runtime.js";
import type { ApprovalReply, ApprovalRequest } from "../permissions.js";
import { approvalUi, type AgentResult, type AgentRunOptions } from "../agent/contracts.js";
import { immutable } from "../json.js";
import { HarnessError } from "../errors.js";
import { cliCommandService } from "./commands.js";
import { sessionCatalogService, sessionSummary } from "../session/catalog.js";
import type { CliSessions } from "./sessions.js";
import { services } from "../services.js";
import { codingRecovery } from "../agent/loop.js";
import type { HotReloadHost } from "../hot-reload/index.js";
import { observabilityService } from "../observability/index.js";

/** Strip terminal control sequences from every untrusted display string. */
export function terminalText(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
export interface CliIO {
  readonly interactive: boolean;
  question(text: string, signal?: AbortSignal): Promise<string>;
  write(channel: "out" | "err", text: string): void;
  onInterrupt(listener: () => void): () => void;
  close(): void;
}
class NodeTerminal implements CliIO {
  readonly interactive = !!stdin.isTTY;
  readonly #rl: Interface | undefined = this.interactive ? createInterface({ input: stdin, output: stderr }) : undefined;
  async question(text: string, signal?: AbortSignal): Promise<string> {
    if (!this.#rl || signal?.aborted) return "";
    try { return await this.#rl.question(text, signal ? { signal } : {}); } catch { return ""; }
  }
  write(channel: "out" | "err", text: string): void { (channel === "out" ? stdout : stderr).write(text); }
  onInterrupt(listener: () => void): () => void {
    process.on("SIGINT", listener); this.#rl?.on("SIGINT", listener);
    return () => { process.off("SIGINT", listener); this.#rl?.off("SIGINT", listener); };
  }
  close(): void { this.#rl?.close(); }
}
class CliHost {
  #queue: Promise<unknown> = Promise.resolve();
  #active: AbortController | undefined;
  #closed = false;
  readonly #offInterrupt: () => void;
  constructor(readonly io: CliIO, readonly runOptions: RunOptions = {}, readonly commandExecutionMode: "host" | "docker" | "native" = "host", readonly hotReload?: Pick<HotReloadHost, "reload" | "status">, readonly agentOptions?: AgentRunOptions) {
    this.#offInterrupt = io.onInterrupt(() => { if (this.#active) this.#active.abort(); else this.close(); });
  }
  write(channel: "out" | "err", text: string): void { this.io.write(channel, terminalText(text)); }
  async question(text: string, signal?: AbortSignal): Promise<string> {
    if (this.#closed || signal?.aborted) return "";
    return this.io.question(text, signal);
  }
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalReply> {
    const work = this.#queue.then(async (): Promise<ApprovalReply> => {
      if (!this.io.interactive || this.#closed || signal.aborted) return { binding: request.binding, decision: "deny" };
      const binding = request.binding;
      const environment = this.commandExecutionMode === "docker" ? "（Docker 隔离，临时工作区副本，无网络；修改不回写）"
        : this.commandExecutionMode === "native" ? "（macOS 本机沙箱，禁止网络和子进程，临时副本修改不回写）" : "（宿主机执行，无 OS 沙箱）";
      this.write("err", terminalText(`\n审批 ${binding.tool.name}${binding.tool.name === "run_command" ? environment : ""}\n${JSON.stringify({ binding, arguments: request.arguments }, null, 2)}\n`));
      const reply = await this.question("只批准本次调用？[y/N] ", signal);
      return { binding, decision: !signal.aborted && /^y(?:es)?$/i.test(reply.trim()) ? "allow" : "deny" };
    });
    this.#queue = work.catch(() => {});
    return work;
  }
  showSession(session: Session): void {
    this.write("err", `Session: ${session.id}\n/history 切换会话；/new 新建；/replay 查看历史；/help 帮助\n`);
  }
  async pickSession(sessions: CliSessions, query: string): Promise<void> {
    const listing = await sessions.list();
    const needle = query.toLocaleLowerCase();
    const rows = listing.items.filter(item => `${item.id} ${item.title}`.toLocaleLowerCase().includes(needle)).slice(0, 30);
    this.write("err", `\n会话列表（当前工作区，最多显示 30 项；可用 /history 关键词筛选）\n`);
    rows.forEach((item, index) => this.write("err", `${index + 1}. ${item.id === sessions.current.id ? "[当前] " : item.locked ? "[有锁] " : ""}${item.title}\n   ${item.id}  ${item.updatedAt ?? "尚无记录"}  ${item.status}  ${item.runs} runs\n`));
    if (listing.unavailable) this.write("err", `另有 ${listing.unavailable} 份日志无法读取或不属于当前工作区。\n`);
    if (!rows.length) { this.write("err", "没有匹配的会话。\n"); return; }
    if (!this.io.interactive) return;
    const answer = (await this.question("选择编号切换，回车返回： ")).trim();
    if (!answer || this.#closed) return;
    const number = Number(answer);
    if (!/^\d+$/.test(answer) || !Number.isSafeInteger(number) || !rows[number - 1]) { this.write("err", "无效的会话编号。\n"); return; }
    await sessions.resume(rows[number - 1]!.id);
    if (!this.#closed) this.showSession(sessions.current);
  }
  async start(sessions: CliSessions, task?: string): Promise<number> {
    this.showSession(sessions.current);
    if (!task && !this.io.interactive) throw new Error("Noninteractive input requires --task");
    let exitCode = 0;
    while (!this.#closed) {
      const input = task ?? await this.question("\n任务（/help 帮助，/exit 退出）： ");
      if (this.#closed || !input.trim()) break;
      const action = await sessions.current.run(run => run.services.get(cliCommandService).parse(input), this.runOptions);
      if (action.kind !== "prompt") {
        try {
          if (action.kind === "exit") break;
          if (action.kind === "error") { this.write("err", action.text + "\n"); exitCode = 1; }
          else if (action.kind === "help") this.write("out", await sessions.current.run(run => run.services.get(cliCommandService).help(), this.runOptions) + "\n");
          else if (action.kind === "history") await this.pickSession(sessions, action.query);
          else if (action.kind === "resume") { await sessions.resume(action.id); this.showSession(sessions.current); }
          else if (action.kind === "new") { await sessions.create(); this.showSession(sessions.current); }
          else if (action.kind === "replay") await replayCli(sessions.current, text => this.write("out", text), this.runOptions);
          else if (action.kind === "status") this.write("out", await sessions.current.run(run => JSON.stringify(sessionSummary(sessions.current.id, run.services.get(services.session).events(), true), null, 2), this.runOptions) + "\n");
          else if (action.kind === "metrics" || action.kind === "trace") {
            const result = await sessions.current.run(run => {
              const observer = run.services.get(observabilityService);
              if (action.runId && !observer.run(action.runId)) return { error: "RUN_NOT_FOUND" };
              return action.kind === "trace" ? observer.trace(action.runId) : action.runId ? observer.run(action.runId) : observer.snapshot().runs;
            }, this.runOptions);
            this.write("out", JSON.stringify(result, null, 2) + "\n");
          }
          else if (action.kind === "reload" || action.kind === "plugins") {
            // The parse run has ended. Awaiting reload inside it would wait for itself to drain.
            if (!this.hotReload) this.write("err", "宿主未启用热更新。\n");
            else if (action.kind === "plugins") this.write("out", JSON.stringify(this.hotReload.status(), null, 2) + "\n");
            else {
              const report = await this.hotReload.reload();
              this.write("err", `[热更新] ${report.status}; config=v${report.configurationVersion}${report.code ? `; ${report.code}` : ""}\n`);
              if (report.status === "failed" || report.status === "restart-required") exitCode = 1;
            }
          }
        } catch (error) {
          if (sessions.runtime.health().restartRequired) throw error;
          this.write("err", commandError(error) + "\n"); exitCode = 1;
        }
        if (task) break;
        continue;
      }
      this.#active = new AbortController();
      let streamed = false;
      let result: AgentResult;
      try {
        result = await sessions.current.run(async run => {
          const log = run.services.get(services.session);
          const offDelta = log.subscribeDeltas(delta => { if (delta.channel === "model") { streamed = true; this.write("out", delta.text); } });
          const offCommit = log.subscribeCommitted(notification => {
            for (const event of notification.events) {
              if (event.data.type === "tool.planned") this.write("err", `\n[工具] ${event.data.tool.id} ${event.callId}\n`);
              if (event.data.type === "tool.completed") this.write("err", `[工具已提交] ${event.callId}\n`);
              if (event.data.type === "context.compaction" && event.data.phase === "completed") this.write("err", "[上下文摘要已提交]\n");
              if (event.data.type === "context.compaction" && event.data.phase === "failed") this.write("err", "[上下文摘要未生效]\n");
            }
          });
          try { return await run.services.get(services.agentLoop).run(action.text, this.#active!.signal, this.agentOptions); }
          finally { offDelta(); offCommit(); }
        }, this.runOptions);
      } finally { this.#active = undefined; }
      if (streamed) this.write("out", "\n");
      this.result(result, streamed);
      exitCode = result.status === "completed" ? 0 : result.status === "cancelled" ? 130 : 1;
      if (task) break;
    }
    return exitCode;
  }
  result(result: AgentResult, streamed: boolean): void {
    if (!streamed || result.status !== "completed") this.write("out", terminalText(result.text) + "\n");
    this.write("err", `[已持久提交] ${result.status}; requests=${result.steps}; tokens=${result.tokens}; run=${result.runId}\n`);
  }
  close(): void { if (this.#closed) return; this.#closed = true; this.#active?.abort(); this.#offInterrupt(); this.io.close(); }
}

/** UI resource and Host entrypoint; it acquires a fresh AgentLoop snapshot for each task. */
export function createCliPlugin(options: { io?: CliIO; runOptions?: RunOptions; agentOptions?: AgentRunOptions; commandExecutionMode?: "host" | "docker" | "native"; hotReload?: Pick<HotReloadHost, "reload" | "status"> } = {}): { plugin: Plugin; start(sessions: CliSessions, task?: string): Promise<number> } {
  let host: { get(): CliHost };
  const runOptions = Object.freeze({ ...options.runOptions });
  const agentOptions = options.agentOptions ? immutable(options.agentOptions) : undefined;
  return {
    plugin: { id: "cli", version: "2.1.0", apiVersion: API_VERSION, scope: "runtime", provides: [approvalUi], requires: [cliCommandService, sessionCatalogService],
      setup(ctx) {
        const resource = ctx.resource("terminal-ui", () => new CliHost(options.io ?? new NodeTerminal(), runOptions, options.commandExecutionMode, options.hotReload, agentOptions), host => host.close());
        host = resource;
        ctx.provide(approvalUi, () => ({ approve: (request, signal) => resource.get().approve(request, signal) }));
      },
    },
    start: (sessions, task) => host.get().start(sessions, task),
  };
}
export async function replayCli(session: Session, write: (text: string) => void = text => stdout.write(text), options?: RunOptions): Promise<void> {
  await session.run(run => {
    const log = run.services.get(services.session);
    const summaries = new Set(log.events().filter(event => event.data.type === "model.requested" && event.data.purpose === "compaction").map(event => event.callId));
    for (const event of log.events()) {
      if (event.data.type === "user.input") write(terminalText(`[用户] ${event.data.content}\n`));
      if (event.data.type === "model.completed" && !summaries.has(event.callId)) write(terminalText(`[模型] ${event.data.text}\n`));
      if (event.data.type === "context.compaction" && event.data.phase === "completed") write("[上下文摘要已提交]\n");
      if (event.data.type === "run.finished") write(`[运行] ${event.data.status}\n`);
    }
    write(terminalText(JSON.stringify({ sessionId: session.id, recovery: codingRecovery(log) }, null, 2)) + "\n");
  }, options);
}

function commandError(error: unknown): string {
  const codes = new Set<string>();
  const visit = (value: unknown): void => {
    if (value instanceof HarnessError) codes.add(value.code);
    if (value instanceof AggregateError) for (const child of value.errors) visit(child);
    if (value instanceof Error && value.cause) visit(value.cause);
  };
  visit(error);
  if (codes.has("JOURNAL_LOCKED")) return "目标会话有写锁，无法切换；当前会话保留。请确认其他进程已退出。";
  if (codes.has("INVALID_LOG")) return "目标会话日志校验失败；当前会话保留。";
  if (error instanceof HarnessError) return `${error.code}: ${error.message}`;
  return "会话操作失败；请检查目标 ID、工作区或日志状态。";
}
