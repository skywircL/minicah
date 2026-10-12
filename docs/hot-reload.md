# 热更新与审批边界

首版实现三个层级，不修改 Node 的 ESM 缓存图。run 在入口固定配置、插件版本/generation 及工具清单，资源只在声明的生命周期边界切换。

| 层级 | 入口 | 生效点 |
| --- | --- | --- |
| L1 配置 | `runtime.updateConfig({ pluginId: config })` | schema 校验后发布配置版本；下一次进入的 run 使用新版本 |
| L2 插件 | `enablePlugin()` / `disablePlugin()` / `replacePlugin()` | 暂存注册后阻止新 run，等待已有 run 完成，再切换 generation |
| L3 第三方代码 | `ManagedProcess` 或整进程 `restart-required` | 确认旧子进程关闭后启动新子进程，或由宿主 supervisor 重启整个进程 |

## 文件监听与 CLI

热更新入口由独立的 `hot-reload` 插件提供，复用 Chokidar 监听文件、Ajv 校验配置结构。实现参考 [DSH HMR（4878cda）](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/boot/hmr/src/index.ts) 的“文件监听 → 串行协调 → 配置树变更 → 生命周期完成后发布结果”；继续使用本项目的 run 快照与 drain 边界，不修改 Node 内部模块缓存。

CLI 默认监听工作区的 `.minicah/config.json`，文件可以在启动后创建。示例见 [examples/hot-reload.config.json](../examples/hot-reload.config.json)：

```json
{
  "version": 1,
  "plugins": {
    "deepseek-model": { "config": { "maxOutputTokens": 8192 } },
    "context-compaction": { "config": { "auto": true } }
  }
}
```

- `/reload`：立即读取并应用文件，不等待自动监听的稳定窗口。
- `/plugins`：查看当前插件版本、generation、可配置目录、监听状态和最近结果。
- `--config PATH`：指定 JSON 文件，相对路径相对于启动目录。
- `--no-watch`：只在启动和 `/reload` 时读取配置。
- `--watch-poll`：使用轮询，用于网络文件系统或原生监听受限的环境。
- `--watch-code PATH`：监听明确指定的源码/依赖文件，可重复指定。代码改变只报告 `CODE_RESTART_REQUIRED`；旧代继续可用，宿主决定何时重启。

CLI 暴露 `deepseek-model`、`coding-agent-loop`、`context-compaction` 和当前 `host-execution` / `sandbox-execution` 的配置。这些基础插件不能在文件中停用。工作区、只读策略、sandbox 后端和隔离策略仍由启动参数与可信宿主决定；环境变量和 `.env` 不自动重读，密钥不得放入会进入 Session 记录的 JSON 配置。

文件中的 `config` 是对**启动输入**的单层对象覆盖：对象字段合并，数组和标量整体替换，不深合并，也不逐次叠加上次编辑。移除字段恢复启动值；删除文件等价于空覆盖。格式、插件 schema 或最终依赖图非法时，整份候选不生效。删除后若恢复启动组合无法通过依赖校验，也保留当前组合并报告失败。

监听处理创建、修改、删除、编辑器原子重命名保存和启动时不存在的父目录。默认写入稳定窗口 250ms、事件合并 100ms；更新期间收到新事件，会在当前更新结束后重新读取最新文件。文件最多 256 KiB，只接受普通 JSON 文件，不执行 JS/YAML 表达式，不动态 import 文件中的路径。监听器先就绪再首次读取，避免启动读取与订阅之间漏掉变化。

测试默认使用原生文件事件。受限测试环境禁用原生监听时，可用 `MINICAH_TEST_POLLING=1 npm test` 验证相同的文件更新链路。

启动配置失败时 CLI 退出并提示修正；运行中的失败不会停止健康的旧实现。通知只包含状态、配置版本/hash、操作 ID 和错误码，不打印配置原文。`history()` 保留最近 50 次管理结果，仅在内存中；每个业务 run 的完整配置仍由 Session start 持久化。`applied` 表示该次配置或插件事务已完成，不表示源码重启请求已经处理；后者单独保留在 `restartPaths`。

## 宿主目录、整批更新与关闭

宿主通过 `createHotReloadPlugin({ path, catalog })` 提供可信描述符目录。目录之外的插件 ID 会被拒绝。目录条目可设置 `toggle: false`，只允许修改配置；其他条目支持 `{ "enabled": true/false }`。省略 `enabled` 恢复该条目启动时的启用状态，配置文件不能自行安装或导入未知插件。

```ts
const hotReload = createHotReloadPlugin({
  path: "/workspace/.minicah/config.json",
  catalog: [{ plugin: optionalTools }],
});
const runtime = await Runtime.create({ plugins: [basePlugin, hotReload.plugin] });
try {
  const initial = await hotReload.start(runtime); // 在 Runtime.create 完成后、首次 run 前调用
  if (initial.status === "failed" || initial.status === "restart-required") {
    throw new Error(initial.code ?? "Hot reload startup failed");
  }
  // Host 接受业务请求；运行时创建文件并 enabled:true 即可启用 optionalTools。
} finally {
  try { await hotReload.stop(); } finally { await runtime.close(); }
}
```

`Runtime.applyUpdate({ changes, config, resetConfig })` 在内核串行队列中执行一批变更。`changes` 包含 `enable` / `disable` / `replace`；`config` 替换对应插件的完整输入，`resetConfig` 恢复其未配置状态。普通 L1 API 仍只接受 run-config 插件；整批 API 会将静态配置变化转为 L2 替换。整个最终依赖图校验成功才暂存候选，允许 Provider 与 Consumer 的接口版本一起替换、一起启停，不暴露中间的缺失依赖状态。若包含任何 L2 变更，L1 配置也等到同一个切换点发布。任意排他资源使整批采用 `stop-first`；任意必须进程重启的代码升级使整批返回 `restart-required`，不部分应用。

目录和配置文件按挂载 instanceId 定位，保留描述符中的 ServiceScope / RegistryScope；第一版等待屏障仍覆盖整个 Runtime。此次没有加入 DSH 的 volatile 可变配置引用、基于依赖的局部 drain 或 ESM/CJS 缓存重载。

`HotReloadService` 只提供状态与历史，变更入口留在 Host facade，`/reload` 在命令解析 run 结束后执行，避免等待自身 drain。`ctx.resource` 拥有监听器；插件清理时先关闭监听并取消尚未执行的更新，避免在 Runtime 清理队列中等待排在自己后面的操作。宿主正常退出先调用 `hotReload.stop()`，还会等待已派发的更新完成清理，再关闭 Runtime。普通资源清理失败仍按原有 `restart-required` 规则处理。

## L1：按 run 固定配置

支持 L1 的插件声明 `configMode: "run"` 和 `validateConfig`。校验器是同步、纯函数 schema 校验入口，可以直接编码 schema，或由宿主提供所用 schema 库的适配器。内核不引入 JSON Schema 引擎。

```ts
const plugin = {
  id: "model-config",
  version: "1.0.0",
  apiVersion: API_VERSION,
  scope: "runtime" as const,
  configMode: "run" as const,
  provides: [modelToken],
  requires: [],
  validateConfig: validateModelConfig,
  setup(ctx) {
    ctx.provide(modelToken, run => {
      const config = validateModelConfig(run.configuration.values[ctx.owner]);
      return createModelFacade(config);
    });
  },
};

await runtime.updateConfig({
  "model-config": { endpoint: "https://api.example/v2", model: "model-v2", toolPolicy: "ask" },
});
```

`updateConfig()` 接受插件配置的替换值，不做隐式深合并。所有 patch 项统一验证，失败不会发布部分配置。L1 不等待旧 run：它们仍持有旧配置的不可变快照。run-config 插件在 setup 中读取 `ctx.config` 会被拒绝，避免把旧配置固化到长期闭包；默认 `static` 插件继续用 `ctx.config`，改变它们的初始化配置需走 L2。

`run.configuration` 包含唯一 id、当前 Runtime 内的版本序号、变更层级、创建时间、稳定 JSON hash 和经校验后的值。`configurationHistory()` 是内存管理历史；内置 Session 插件在 `SessionService.start()` 时，把该 run 使用的完整配置版本和 manifest 一起持久提交。API endpoint、模型、工具策略必须放在对应插件的 schema 配置中，才能随版本留存。没有调用 Session 的 start，就没有可冒称已持久化的 run 记录。

`ctx.onConfigChange()` 用于同步失效旧审批、缓存等。它在资源激活时先收到该候选版本的配置，之后收到每次发布的配置；旧实现不会在暂存阶段收到候选配置。回调不能异步返回，也不能发起嵌套生命周期操作。发布后失效回调出错时，配置不会被虚构为已回滚，Runtime 会要求重启并拒绝后续 run。

## L2：先暂存注册，再切换

严格顺序是：

1. 校验描述符、配置、接口兼容性和完整依赖图。
2. 执行 candidate setup，仅暂存服务工厂、工具 schema/execute 对、监听器和资源声明。此时旧 run 仍可运行及进入。
3. 阻止新的受影响 run；等待已进入的 run 和其在途工具结束。
4. 按 `replacementBoundary` 获取候选资源、切换注册和 generation。
5. 释放旧资源，收集失败信息。
6. 返回结果并写入 `upgradeHistory()`，之后开放健康 Runtime 的新 run。

首版每次 run 捕获 Runtime 中的全部启用插件，所以 L2 采用整个 Runtime 的等待屏障；没有虚构对未声明插件使用集合的精细并行切换。L1 的快照发布不需要该屏障。

`enablePlugin(plugin, config?)` 注册新挂载；`enablePlugin(instanceId)` 重新启用当前 Runtime 已保存的描述符。`disablePlugin(instanceId)` 不自动级联停止消费者：如果仍有依赖它的启用插件，会拒绝缺失依赖。替换保留挂载 instanceId 和资源作用域；未设置 instanceId 时沿用定义 id。generation 按挂载单调增加，失败尝试所用代次不复用；跨进程追踪使用 runId 和配置版本 UUID 消除歧义。服务依赖按隔离绑定解析，详见 [服务隔离](service-isolation.md)。

### 资源接口

```ts
setup(ctx) {
  const connection = ctx.resource(
    "connection",
    () => openConnection(),
    connection => connection.close(),
  );
  ctx.provide(serviceToken, () => ({
    perform: input => connection.get().perform(input),
  }));
}
```

`resource()` 在 setup 中只保存声明，到激活时按注册顺序获取。`get()` 在激活前和退役后拒绝访问。`manage()` 只保留对启动阶段已有资源的兼容；升级候选使用它会报 `REGISTRATION_ONLY`。监听器也只在激活时挂载。

原生插件是同进程可信代码，注册上下文不是 JavaScript 沙箱。setup 自行写文件、发送消息、启动子进程等行为违反 registration-only 契约，内核无法撤销任意外部副作用；第三方代码应使用 L3。

### 默认与排他边界

- `drained`：旧 run 结束后，先激活候选，再切换注册并释放旧资源。候选失败且受管理回收成功时，旧 Provider 保持可用。
- `stop-first`：先停止并移除旧 Provider，再激活候选，用于文件锁、独占端口等排他资源。旧实现停止后，新实现若启动失败，不承诺恢复原状态；Runtime 报 `RESTART_REQUIRED` 并阻止后续 run。

受管理回收发生失败或超时时，`health()` 保留相关 owner/generation 注册信息；不能把发出关闭请求当成资源已经安全销毁。JavaScript timeout 不会取消底层 Promise，后续外部副作用仍可能发生，宿主必须处理失败或重启。已经写出的文件、消息、网络操作从来不在回滚承诺中。

`RuntimeOptions.drainTimeoutMs` 默认 30 秒，`cleanupTimeoutMs` 默认每个清理回调 10 秒。等待 run 超时会失败并回收尚未激活的候选，保留旧实现；清理超时会要求重启，不能继续接纳新 run。

### 结果协议

`UpgradeResult` 包含 `operationId`、`pluginId`、`kind`、`boundary`、`status`、`switched`、`generation`、`cleanupErrors`：

| 状态 | 含义 |
| --- | --- |
| `switched` | 已完成切换与旧资源清理 |
| `failed` | 校验、暂存或可回滚激活失败；调用会抛错，记录可从 `upgradeHistory()` 查询 |
| `restart-required`, `switched: false` | 该代码升级要求整进程重启，或旧实现停止后无法安全恢复 |
| `restart-required`, `switched: true` | 新代已经发布，但旧资源清理或配置失效失败；不能视作回滚 |

边界失败会抛 `HarnessError`，其 cause 保留升级结果与原始错误。受管理清理失败的返回结果也必须检查 `status`，不能只看 Promise 是否 fulfilled。若只是 L3 策略拒绝原地代码升级，旧 Runtime 仍健康；若有未确认资源或不可恢复边界，`health().restartRequired` 为 true。

### 工具与模型保持同代

`run.tools.list()` 的 schema、owner、generation 和 `invoke()` 捕获的执行函数来自同一份注册快照。模型适配器必须从该清单构建模型看到的工具定义，并用该 run 的 `invoke()` 执行返回调用；不要从另一个全局注册表重新解析。

`run.manifest` 包含配置、插件定义/挂载身份及版本/generation、工具 schema/generation，以及服务 Provider 与消费者绑定。Session 重放校验 owner、代次、接口版本和隔离槽的一致性；旧日志允许缺少服务绑定扩展。`reconstructRequest()` 返回当时留存的 manifest，不以当前配置或当前实现覆盖旧记录。

## L3：受管理进程升级

```ts
const plugin = {
  // 其余描述符字段省略。此包装插件是可信宿主代码。
  replacementBoundary: "stop-first",
  setup(ctx) {
    const worker = ctx.resource(
      "third-party-worker",
      () => ManagedProcess.start({
        command: process.execPath,
        args: ["/absolute/path/worker-v2.mjs"],
      }),
      worker => worker.dispose(),
    );
    // 业务协议适配器通过 worker 运行的服务通信。
  },
};
```

替换包装插件经 L2 边界调用 `dispose()`，确认旧进程关闭后才启动新的第三方代码。子进程自然拥有新的模块图；没有 import query cachebuster、ESM cache 删除或任意内存状态迁移。

`ManagedProcess.stop()` 先发 SIGTERM，超时后发 SIGKILL；只有收到进程及其 stdio 的 close 确认才返回 `stopped`。两阶段都未确认时返回 `restart-required`，保留 pid，`dispose()` 抛错。`restart()` 在此情况下不启动新进程；旧进程停止但新进程启动失败时返回 `failed` / `oldStopped: true`，不声称无损回退。

默认每阶段等待 5 秒，可配置 `termTimeoutMs` / `killTimeoutMs`。Runtime 的清理回调超时应覆盖子进程这两个阶段的总等待及调度余量，否则外层会提前正确地报告“尚未确认退出”。原生实现使用 `spawn(..., { shell: false, stdio: "ignore" })`，不解释 shell 命令；确认 spawn 不等于应用协议 ready。应用就绪检查、RPC 协议及孙进程管理由适配器承担，首版不声称管理整个进程树。独立调用 `ManagedProcess.restart()` 的宿主必须自己确保相关 run 已空闲；集成到 `ctx.resource()` 和 `stop-first` 可使用 Runtime 的等待边界。

已经在宿主加载的第三方代码应标记 `upgradePolicy: "restart-required"`。替换这种描述符，或以新描述符重新启用它，返回整进程重启要求，不调用候选 setup。宿主 supervisor 负责真正的整进程重启，库不会自行杀死宿主。插件来源分类由可信加载器提供，不能靠不受信任的插件自报建立安全边界。

## 完整审批绑定

`createPermissionPlugin()` 提供 PermissionService v2，配置 schema 为 `{ workspace, policyVersion, ttlMs }`。workspace 转为绝对路径；有效 policyVersion 包含配置 UUID，任何配置发布都会保守地使旧审批失效，包括改回旧值的情况。旧 run 仍固定旧配置，因此需要在新 run 中重新申请，而不能继续使用旧策略审批。

每个审批绑定 `approvalId`、`sessionId`、`runId`、`callId`、`argumentsHash`、`workspace`、`policyVersion`、`expiresAt`，以及工具名称、owner、generation、schemaHash。UI 必须展示请求里的实际参数和 workspace，并回传完整 `binding`；只传工具名或自行改动绑定字段会被拒绝。

```ts
const permission = run.services.get(services.permission);
const session = run.services.get(services.session);
const request = permission.request(callId, toolName, input);

// UI 展示 request.arguments / request.binding，并返回完整 binding + decision。
const decision = permission.reply(uiReply);
await session.record([{ callId, data: {
  type: "permission.decided",
  decision: decision.decision,
  reason: "User replied to this exact operation",
  approval: decision.binding,
} }]);

await session.executeTool(callId, async ({ input }) => ({
  outcome: "success",
  result: await permission.invokeApproved(decision.binding.approvalId, callId, toolName, input),
}));
```

上例在此之前已按 Session 协议记录 `tool.planned`，工具结果需满足 Session 的 JSON 约定。拒绝回复应记录取消，不进入执行。

审批在回复时校验一次，在实际调度 execute 的同一调用栈再次核对并单次消费。参数复制后再校验和调度，避免调用者在异步边界修改原对象。重复回复、过期、参数/workspace/调用/generation 改变、策略变更均使原审批不能执行；替换调用应重新 request 或 revoke。审批记录可以重放展示，但不会重建可消费的授权。

Session 的持久 `permission.decided` 是审计事实；用户审批的执行门禁是活的 `invokeApproved()`。自动策略可直接产生权限决定，但不能把任意一条日志 allow 当成用户审批。首版不提供 HTTP/UI 身份认证、完整规则引擎或进程内恶意插件隔离，宿主必须让用户审批执行路径经过该门禁。

第 5 节中 PermissionService token 已升级为 v3：保留完整审批绑定，并为共享管线增加最终同步派发检查与取消上下文。上文的直接审批调用方式保持可用；管线接入见 [Tool Pipeline 与 PTC](tool-pipeline.md)。
