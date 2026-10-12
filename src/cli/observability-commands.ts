import { API_VERSION, type Plugin } from "../types.js";
import { commandRegistry } from "./commands.js";

/** Surface commands are optional registry contributions, separate from the Session observer. */
export function createObservabilityCommandsPlugin(): Plugin {
  return { id: "observability-commands", version: "1.0.0", apiVersion: API_VERSION, scope: "runtime", provides: [], requires: [],
    setup(ctx) {
      for (const kind of ["metrics", "trace"] as const) ctx.register(commandRegistry, kind, {
        usage: "[runId]", description: kind === "metrics" ? "查看已提交的用量、工具、权限及上下文统计" : "查看已提交的调用关联、状态和事件时间间隔",
        parse(args) {
          if (args && !/^[A-Za-z0-9:_-]{1,256}$/.test(args)) return { kind: "error", text: "请输入完整 runId，或省略参数查看整个会话。" };
          return { kind, ...(args ? { runId: args } : {}) };
        },
      });
    },
  };
}
