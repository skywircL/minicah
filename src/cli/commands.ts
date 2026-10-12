import { API_VERSION, serviceToken, type Plugin } from "../types.js";
import { registryToken, type RegistryEntry } from "../registry.js";
import { fail } from "../errors.js";

export type CliAction =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "history"; readonly query: string }
  | { readonly kind: "resume"; readonly id: string }
  | { readonly kind: "metrics" | "trace"; readonly runId?: string }
  | { readonly kind: "new" | "replay" | "status" | "help" | "exit" | "reload" | "plugins" }
  | { readonly kind: "error"; readonly text: string };
export interface CliCommandService {
  parse(input: string): CliAction;
  help(): string;
  list(): readonly RegistryEntry<CliCommandDefinition>[];
}
export interface CliCommandDefinition {
  readonly usage: string;
  readonly description: string;
  parse(args: string): CliAction;
}
export const commandRegistry = registryToken<CliCommandDefinition>("commands", command => {
  if (!command || typeof command.usage !== "string" || typeof command.description !== "string" || typeof command.parse !== "function") fail("INVALID_REGISTRATION", "Command needs usage, description and parse callback");
  return { usage: command.usage, description: command.description, parse: command.parse };
});
export const cliCommandService = serviceToken<CliCommandService>("CliCommandService");
const definitions = Object.freeze([
  { name: "history", usage: "[关键词]", description: "列出当前工作区的会话，输入编号切换" },
  { name: "resume", usage: "[会话ID或唯一前缀]", description: "切换会话；省略参数时打开列表" },
  { name: "new", usage: "", description: "开始新会话，保留原会话记录" },
  { name: "replay", usage: "", description: "展示当前会话历史和未结算调用" },
  { name: "status", usage: "", description: "查看当前会话 ID、状态和记录数" },
  { name: "help", usage: "", description: "显示这些命令" },
  { name: "exit", usage: "", description: "退出 CLI" },
]);

/** Human commands resolve to host actions before any AgentLoop is acquired. */
export function createCliCommandsPlugin(): Plugin {
  return { id: "cli-commands", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [cliCommandService], requires: [],
    setup(ctx) {
      for (const item of definitions) ctx.register(commandRegistry, item.name, {
        usage: item.usage, description: item.description,
        parse(args): CliAction {
          if (item.name === "history") return { kind: "history", query: args };
          if (item.name === "resume") return args ? { kind: "resume", id: args } : { kind: "history", query: "" };
          if (args) return { kind: "error", text: `/${item.name} 不接受参数` };
          return { kind: item.name as "new" | "replay" | "status" | "help" | "exit" };
        },
      });
      ctx.provide(cliCommandService, run => {
        const commands = run.registries.get(commandRegistry);
        return {
          list: () => commands.list(),
          help: () => commands.list().map(({ info, value }) => `/${info.name}${value.usage ? ` ${value.usage}` : ""} — ${value.description}`).join("\n"),
          parse(input) {
            // Both discovery and dispatch consult the same immutable run view.
            const text = input.trim();
            if (!text.startsWith("/")) return { kind: "prompt", text: input };
            const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text);
            const name = match?.[1], args = match?.[2]?.trim() ?? "";
            const command = name ? commands.get(name) : undefined;
            if (!command) return { kind: "error", text: "未知命令；输入 /help 查看。以路径开头的任务请在前面加上任务说明。" };
            return command.value.parse(args);
          },
        };
      });
    },
  };
}
