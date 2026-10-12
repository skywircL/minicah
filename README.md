# minicah

使用 TypeScript / Node.js 实现的轻量插件化 Coding Agent Harness 内核。遵循“一切能力皆插件”的方向，内核只负责服务索引、依赖验证、资源所有权、作用域销毁和生命周期协调。启动入口是普通的 `Runtime.create()`。

当前实现覆盖设计基线第 2–5 节，并提供可运行的 Coding Agent：DeepSeek 直连与 Pi 多模型插件、Agent Loop、工作区工具、受审批的命令，以及交互式 CLI。命令可以运行在宿主机或通用 sandbox，PTC 复用相同 sandbox 底座；隔离 Provider 包括 Docker 和 macOS Seatbelt 首版。所有能力通过现有插件契约组合，内核不内置模型、工具或 UI。

## 复用与贡献边界

模型 API/SDK、JSON Schema 校验库、前端库、HTTP/SSE 基础设施，以及已有操作系统/容器隔离能力均复用成熟实现。本项目负责这些能力与 Harness 契约的适配和编排，不将第三方库或隔离平台的实现计为自己的贡献。

| 能力 | 复用边界 | 当前状态 |
| --- | --- | --- |
| 模型 API/SDK | DeepSeek 直连复用 `openai` SDK；多模型复用 Pi `@earendil-works/pi-ai@1.0.2` 的厂商适配；项目负责 ModelService 桥接、请求留存、工具和续传映射 | 支持 DeepSeek 直连及 Pi 的 8 个 API key 厂商入口；真实服务需本地密钥 |
| JSON Schema | 使用 Ajv；项目负责固定 schema 版本、调用校验器及处理拒绝结果 | 已接入 |
| 文件监听 | 复用 Chokidar；项目负责配置覆盖、整批更新、run 边界和失败报告 | 配置自动热更新与源码重启通知已接入 |
| 前端 | 复用 Node readline；项目负责任务、审批、进度与恢复交互 | CLI 已实现；尚无 Web UI |
| HTTP/SSE | 复用 SDK/Node HTTP 与 SSE；项目负责事件映射和持久提交后的发布语义 | 模型流式调用已接入；未提供面向前端的 HTTP/SSE 服务 |
| OS/容器隔离 | 复用 Docker 与 macOS Seatbelt；项目负责受限配置、Host 工具权限、控制通道与生命周期确认，各后端保证分别描述 | 通用服务提供 Docker 与 macOS 单进程后端 |

当前由本项目实现的部分包括最小插件内核、注册所有权与生命周期、run 版本快照、Session 事件与 Context 投影、共享工具管线、PTC 的 Host 编排和审计，以及 Coding Agent 的适配、循环、工作区策略和 CLI 交互。

文档、演示、评测和项目总结均区分第三方提供的能力与本项目新增的适配、策略和编排。集成测试通过证明所列环境下的测试行为符合断言，不将其表述为自研模型、校验器、前端框架、传输协议或隔离平台。

## 运行

需要 Node.js 22.19 或更新版本。

```sh
npm ci
npm test
npm run demo
npm run demo:pipeline
```

`npm run check` 只检查类型，`npm run build` 输出 JavaScript、类型声明和 source map 到 `dist/`。

启动真实 Coding Agent：

```sh
export DEEPSEEK_API_KEY='你的本地密钥'
npm run agent -- --workspace /path/to/project
```

也可复制公开的无密钥模板，再在本地填写 `.env` 中的 `DEEPSEEK_API_KEY`；CLI 会自动读取，已有环境变量优先。`.env` 与本地 `.env.example` 均由 Git 忽略。

```sh
cp examples/environment.example .env
```

通过 Pi 使用 OpenAI、Claude 或 Gemini，先查看随依赖固定的模型目录，再选择厂商与模型；目录查询不读取密钥、不访问 API。

```sh
npm run agent -- --list-models --pi-provider openai
export OPENAI_API_KEY='你的本地密钥'
npm run agent -- --provider pi --pi-provider openai --model gpt-5.4 --reasoning high --workspace /path/to/project
# Claude：ANTHROPIC_API_KEY；Gemini：GEMINI_API_KEY
npm run agent -- --provider pi --pi-provider anthropic --model claude-sonnet-4-6 --workspace /path/to/project
npm run agent -- --provider pi --pi-provider google --model gemini-2.5-flash --workspace /path/to/project
```

`--provider deepseek` 保留原有直连默认值；`--provider pi` 使用 Pi 的协议实现。目前接入 `openai`、`anthropic`、`google`、`deepseek`、`openrouter`、`xai`、`groq`、`mistral` 的 API key 路径。模型 ID、容量与支持的思考级别以 `--list-models` 为准；它是本地目录，不代表账户已获该模型权限。OAuth、订阅登录及云平台凭证流程尚未接入。模型目录、环境变量、热更新和评测用法见 [Coding Agent](docs/coding-agent.md#pi-多模型接入)。

进入 CLI 后，可用 `/history` 列出历史会话并输入编号切换，`/resume ID或唯一前缀` 直接恢复，`/new` 新建会话，`/replay` 查看当前历史，`/status` 查看当前会话概况，`/help` 查看命令。无需退出到 shell；这些管理命令不请求模型。

CLI 默认监听工作区 `.minicah/config.json`。按 [配置示例](examples/hot-reload.config.json) 创建文件后，模型参数、上下文压缩和执行限额会经校验更新，下一次 run 使用新配置。`/reload` 立即重读，`/plugins` 查看版本和监听状态；`--config PATH` 指定文件，`--no-watch` 关闭自动监听，`--watch-poll` 改用轮询。SDK 的可信插件目录还支持整批启停及静态配置替换，详见 [热更新](docs/hot-reload.md)。

也可以先运行只读任务：

```sh
npm run agent -- --workspace /path/to/project --read-only --task "查看项目结构，说明如何运行测试"
```

Agent 没有累计 token、费用、模型/工具调用次数或整次 run 时长上限。默认启用上下文测量、工具结果裁剪和历史摘要；单次输出、上下文窗口、并发与执行 deadline 仍受控。`--context-window` 设置模型容量，`--no-auto-compact` 可关闭自动压缩。

默认模型为 `deepseek-flash`，可通过 `--model` 修改。文件修改和命令执行逐次审批；非交互模式默认拒绝写入。默认 `--sandbox host` 在宿主机执行命令，不要求 Docker，也不提供 OS 隔离。显式选择 Docker：

```sh
export MINICAH_SANDBOX_IMAGE='your-node-image@sha256:实际的64位digest'
npm run agent -- --workspace /path/to/project --sandbox docker
```

也可通过 `--sandbox-image` 指定本地可信镜像。Docker 命令操作过滤后的临时工作区副本，可以生成构建产物，但不会回写宿主工作区；凭据常见路径、`.git` 和 `.minicah` 被排除，默认复制上限为 64 MiB / 20,000 个条目。依赖须已在镜像或副本中，网络默认关闭。

macOS 可用 `--sandbox native` 选择无需 Docker 的 Seatbelt 后端，需要系统 `sandbox-exec` 和 Xcode Command Line Tools 提供的 `otool`。首版禁止创建子进程，适合单进程命令和 PTC；需要多进程的 npm/build 工作流选择 Docker 或 Host。该后端不承诺 Docker 等价的总内存、CPU、PID 或磁盘配额。完整参数、恢复方法和边界见 [docs/coding-agent.md](docs/coding-agent.md)。

示例输出：

```text
model-v1: Inspect the workspace
Provider generation: 2
model-v2: Continue with the new provider
Recovered messages: 4
Confirmed calls: 4
```

## 评测与可观测

针对 150 题失败的后续修复与同条件回归见 [数据飞轮第一轮](docs/evaluation-flywheel-iteration.md)，包括公开完成核验、有限续接、拒绝事实与回复校验，以及独立的新旧版本对照。旧 86.01% 成绩保留，不用修订后的题目覆盖历史分数。

最新 14 道开发集代表题完成新旧各 82 次真实 DeepSeek 试验：通过率 **75.61%（62/82）→93.90%（77/82）**，20 对改善、5 对退化；新版 tokens 增加 45.57%。这是代表集回归，尚非全量 150 题的迭代后成绩；代码未修改和定义行号错误仍有残留。

历史 150 题实测的可读入口：[失败分析工作台](docs/evaluation-failures/index.html) · [题目与执行阅读目录](docs/evaluation-failures/README.md)。可查看题面、工具时间线、文件差异、实际/预期对比，并切换同题成功重复。

评测按用户附件的能力空间分为三轨，分别报告模型与 Harness 的证据：

| 轨道 | 能力域 | 当前金种子候选 |
| --- | --- | ---: |
| 用户任务 | A1 仓库理解、A2 受约束修改、A3 验证修复、A4 需求约束、A5 连续执行、A6 异常说明 | 14 |
| 运行可靠性 | H1 工具、H2 权限、H3 上下文、H4 持久化恢复、H5 隔离终止、H6 证据一致性 | 16 |
| 插件平台 | P1 生命周期、P2 作用域、P3 配置版本、P4 评测诊断 | 8 |

[GT 总览](docs/evaluation-ground-truth.md)与[金种子构建及验收](docs/evaluation-gold-seeds.md)定义五维矩阵、完整 case 契约、参考执行、错误反例和人审晋级。使用 `npm run gold:build` 构建，`gold:calibrate -- --sandbox native` 校准，`gold:audit` 核验证据；私有逐条审阅包位于 `evals/private/gold-seeds-v2/review.md`。v2.3.2 共 38 条待人审候选（14 A / 16 H / 8 P）：原 33 条保留 27 条、补强 3 条、替换 3 条；包含 DeepSeek Harness、pi 和 SWE-bench 的可追溯改编，逐条取舍见私有 `curation.md`，旧题保留归档。v2.3.1 在前版修复基础上补齐混合证据计分、拒绝后停止写尝试，并统一反例与预期，v2.3.2 统一系统提示和每轮题面的 JSON 输出要求，保持业务期望与判据不变。修订记录见 `revision-review.md`；原 ID 保留，内容 hash 和人审重新绑定。参考校准不是模型成绩。

A3 的 Agent 命令执行受环境限制，当前评测执行器未开放命令；A5 的任务接续与 H3 的压缩结构检查分别验收。旧 `gt:*` 命令及历史数据保留，改写变体不计作新的独立金种子。

先运行无需密钥的离线 smoke：

```sh
npm run eval -- --suite examples/evaluation-smoke.json --repetitions 3
```

默认 `--provider fixture` 使用固定脚本读取文件并转换文本，只验证工具、Session、判分和报告链路；其分数不代表模型能力。真实 DeepSeek 评测需显式选择：

```sh
npm run eval -- --suite examples/evaluation-smoke.json --provider deepseek --model deepseek-flash --repetitions 3
```

[数据集示例](examples/evaluation-smoke.json) 展示 JSON 结构：suite 的 `id/version/split`、任务的 `prompt/files` 与隐藏 `graders`。支持文本等于/包含、文件文本等于/包含和文件 JSON 等于检查；不执行数据集提供的 shell 命令或 grader 代码。每个 trial 创建独立工作区与 Session，支持 `--concurrency`、`--timeout-ms`。报告保留逐次 outcome、失败分类、排除项及 `pass@k` / `pass^k`；流程 completed 不等于任务 passed。

[配置修改案例](examples/evaluation-coding.json) 包含单文件和多文件修改，可用 `npm run eval -- --suite examples/evaluation-coding.json --provider deepseek --allow-writes` 执行。它按最终 JSON 内容及要求保持不变的文件验收。

代码行为检查使用 `sandbox-test`，数据集通过 `testId` 引用显式加载的版本化测试包。[函数修复案例](examples/evaluation-functions.json) 包含 clamp 和 median 两题，[测试包](examples/evaluation-functions.tests.json) 覆盖边界值和预期异常。macOS 可直接运行，无需 Docker：

```sh
npm run eval -- --suite examples/evaluation-functions.json \
  --provider deepseek --allow-writes \
  --test-pack examples/evaluation-functions.tests.json --grader-sandbox native
```

其他平台使用 `--grader-sandbox docker --grader-image 'your-node-image@sha256:实际的64位digest'`。每个测试用例在独立 OS 沙箱进程和最终工作区副本中调用 `.js/.mjs/.cjs` 导出的同步或异步函数，输入输出为 JSON。期望值与异常名称留在 Host 判分，不交给模型或候选代码。`throws` 匹配函数调用所抛异常的 `name`，模块加载失败不满足预期异常。

默认每项测试 5 秒、每组 30 秒，并受 trial 剩余时间限制；可用 `--grader-case-timeout-ms`、`--grader-timeout-ms` 调整。提前退出、缺失有效结果、超时及输出超限均不能算通过；无法确认清理时停止后续试验。报告包含逐 case 结果、沙箱退出状态和 `test-manifest.json` 的版本/hash。评分运行在 Agent 结束后，其耗时不计为模型或工具调用。

首版支持函数行为测试，尚不运行任意 `npm test`、Jest 或联网安装依赖。测试包只包含模块、函数和输入/期望数据，不能指定 Host 命令。评分沙箱独立于 PTC 的 `--sandbox`，不会向 Agent 开放命令执行。正式私有数据集及测试包放在 `evals/private/`；上述示例用于演示与校准。

默认 Native 只开放受控只读文件工具，`--allow-writes` 可额外允许临时工作区中的 `write_file/edit_file`，不开放 shell。PTC 使用只读 bindings，必须显式选择已有隔离后端：

```sh
npm run eval -- --suite examples/evaluation-smoke.json --mode ptc --sandbox native
```

Docker 可改为 `--sandbox docker --sandbox-image 'your-node-image@sha256:实际的64位digest'`。比较 Native 与 PTC 时保持相同模型、任务、只读工具和限制，Native 保留多个工具调用的并发能力。上面的 PTC 命令仍使用离线 fixture；测试真实模型需同样加 `--provider deepseek`。

私有报告和日志默认保存在 Git 忽略的 `.minicah/evals/`，包括保存完整评分定义的私有 `suite.json`、`plan.json`、`trial-*.json`、`report.json` 和对应 Session。每份 trial journal 限制 16 MiB，这是存储保护，不是累计 token 预算。`cleanup-unconfirmed` 或 `needs-reconciliation` 表示需要检查保留证据，不能当作已完成评测。

交互式 Agent 中使用 `/metrics [runId]` 查看指标、`/trace [runId]` 查看调用关联；也可离线读取 Session JSONL：

```sh
npm run observe -- --journal /path/to/session.jsonl --trace
mkdir -p .minicah/observability
npm run observe -- --journal /path/to/session.jsonl --output .minicah/observability/report.json
```

导出文件必须不存在，父目录须已存在。观测只读取已提交事件，默认 JSON 保留计数、状态、关联 ID 和时间等元数据，区分供应商 usage 与本地估算，不导出正文或工具参数。原 Session 仍可能含完整请求与结果。当前为本地 CLI/JSON 能力，未接入 Dashboard、OpenTelemetry 或外部遥测。

## 基本用法

```ts
import { API_VERSION, Runtime, serviceToken, type Plugin } from "./src/index.js";

const greeting = serviceToken<{ say(): string }>("GreetingService", 1);

const provider = (text: string): Plugin => ({
  id: "greeting",
  version: "1.0.0",
  apiVersion: API_VERSION,
  scope: "runtime",
  provides: [greeting],
  requires: [],
  setup(ctx) {
    ctx.provide(greeting, () => ({ say: () => text }));
    ctx.onCleanup(() => { /* 关闭由本插件创建的连接等资源 */ });
  },
});

const runtime = await Runtime.create({ plugins: [provider("hello")] });
try {
  const session = await runtime.openSession("conversation-1");
  console.log(await session.run(run => run.services.get(greeting).say()));

  const replacement = await runtime.replacePlugin(provider("你好"));
  if (replacement.status !== "switched") {
    throw new Error(`升级需要处理：${replacement.status}`);
  }
  console.log(await session.run(run => run.services.get(greeting).say()));
} finally {
  await runtime.close();
}
```

完整组合示例见 [examples/demo.ts](examples/demo.ts)：Runtime 级模型、工具，以及 Session 级日志、Context 和 Agent 服务。模型替换后，同一 Session 继续保留记录；Runtime 重建后恢复展示，不重做工具调用。demo 使用独立临时目录，结束时删除示例日志。

同一个插件定义可以用不同 `instanceId` 挂载多次。`ServiceScope.isolate(token, key)` 为指定服务建立独立绑定，其他服务继承原绑定；用同一个 key 对象可显式共享。示例见 [examples/service-isolation.ts](examples/service-isolation.ts)，运行 `npm run build && node dist/examples/service-isolation.js`，可看到两套组合分别使用同名服务，并只替换其中一套模型。API 与边界见 [docs/service-isolation.md](docs/service-isolation.md)。

## Session 与 Context

通过 `createSessionPlugin({ directory, durability: "fsync" })` 和 `createContextPlugin()` 注册能力。`SessionService` / `ContextService` 的接口版本为 **4**：异步事件提交与只读投影，并在状态和 Context 中提供可重放的 Surface 索引。

Session 保存用户输入、模型实际请求/响应、结构化工具调用/结果、权限决定、预算退出、任务状态、受保护信息及版本化摘要。每条事件附带序号、run/call/parent 标识、版本引用和配置 hash。模型、prompt、工具及插件定义的实际内容必须先留存，重建请求不依赖当前 Provider。

- `flush`：完整事务已写入操作系统缓存；`fsync`：在此基础上请求文件同步。默认 `fsync`，返回值明确标注级别。
- `subscribeCommitted()` 仅在提交完成后收到通知；`subscribeDeltas()` 是独立、非持久化的 UI 通道。
- 工具执行前先 `fsync` 执行意图。恢复区分未开始、已确认完成、结果不确定；恢复过程不调用模型或工具。
- Context 根据已提交事件投影。Surface 支持连续前缀摘要和局部范围替换；完整模型响应及其工具结果作为一个节点，不删除日志、不隐藏未结算调用、不移除约束或受保护信息。模型侧工具结果不重复携带审计 evidence。

具体 API、事件表、崩溃恢复与耐久性边界见 [docs/session.md](docs/session.md)。

## Tool Pipeline 与 PTC

`createToolPipelinePlugin()` 提供 ToolService v3：参数验证、Host 策略/审批、原子用量计量、有界调度、结构化结果与持久事件。`invokeMany()` 并发处理一个模型响应中的多个工具调用；PTC 的 Host 子调用使用同一实例和计量器。ModelService v3 将 `prepare()` 与 `complete()` 分开，保证实际请求先持久提交再发送；响应保留结构化工具调用及用量。

`createDockerSandboxPlugin({ image, workspace })` 提供 Runtime 级 `SandboxService`：精确 argv、文件/网络/环境/资源限制、有界 I/O 和可验证清理。`createSandboxExecutionPlugin(workspace)` 和默认的 `createPtcPlugin()` 分别在其上提供 ExecutionService 与 PtcRuntimeService v2。每次命令或程序使用新容器；PTC 固定无工作区挂载，输入输出为 JSON，首版只开放显式 read-only 工具。Host 重新验证每个子调用，生成父子调用关联，处理 deadline、输出限额和取消清理；结果保留 completed/failed/unknown 明细。Docker 不可用时拒绝执行。

macOS 可将底座替换为 `createSeatbeltSandboxPlugin({ workspace })`，ExecutionService 与 PTC 保持相同接口；它的单进程和资源边界见工具文档。旧的 `createPtcPlugin(() => new DockerSandbox({ image }))` 仍兼容，但会创建独立底座。共享 sandbox 的策略是静态插件配置，变更镜像、工作区或资源边界通过 L2 替换并等待 run drain。插件关闭时取消活动进程并等待清理；清理不确定会保留资源名、报告 `RESTART_REQUIRED` 并拒绝新 dispatch。

可运行的 Native/PTC 示例见 [examples/tool-pipeline.ts](examples/tool-pipeline.ts)，隔离配置、DSH 分层参考、审批接入、脱敏和测试说明见 [docs/tool-pipeline.md](docs/tool-pipeline.md)。共享底座的真实容器测试使用 `MINICAH_SANDBOX_IMAGE=name@sha256:...`，兼容 PTC 回归使用 `MINICAH_PTC_IMAGE`；macOS 原生回归通过 `MINICAH_NATIVE_TEST=1` 启用。未设置相应变量或平台不匹配时显示跳过。原生共享底座集成和在沙箱临时副本中对本项目执行 `tsc --noEmit` 已通过验证，后者不回写宿主工作区。

## 插件契约

| 字段 | 约定 |
| --- | --- |
| `id` | 插件定义标识，可以由多个挂载实例复用 |
| `instanceId` | Runtime 内唯一的挂载标识，省略时使用 `id`；配置、owner、generation 与生命周期操作均按此标识 |
| `serviceScope` | 可选的不可变服务绑定域；由 `ServiceScope.mount()` 附加，省略时使用根绑定 |
| `registryScope` | 可选的贡献可见层；由 `RegistryScope.mount()` 附加，工具、命令、Skill 等沿父链继承 |
| `version` | 插件发行版本，首版只接受稳定版 `x.y.z` |
| `apiVersion` | 内核插件 API 版本；首版固定为整数 `1` |
| `scope` | 仅支持 `runtime` / `session` |
| `provides` | 提供的服务 token；同一服务名、同一隔离键只允许一个 Provider |
| `requires` | 所需服务 token；精确匹配接口版本 |
| `validateConfig` | 可选的同步、纯函数配置校验及转换 |
| `configMode` | 默认 `static`；`run` 启用 L1，要求配置校验器，并从 run 快照读取 |
| `replacementBoundary` | 默认 `drained`；排他资源可声明 `stop-first` |
| `upgradePolicy` | 默认可信宿主代码 `in-process`；第三方宿主代码升级标记 `restart-required` |
| `setup` | 注册服务工厂、工具、监听器和清理回调 |

`serviceToken<T>(id, version)` 的版本是正整数，表示一个接口契约代次；不执行 semver 范围推断。插件发行版本与接口版本相互独立。

配置通过 `Runtime.create({ plugins, config: { [instanceId]: value } })` 提供，必须是 JSON 数据。未设置 `instanceId` 的旧插件继续按 `id` 配置。动态配置应从 `run.configuration.values[ctx.owner]` 读取，避免把定义 id 写死在工厂里。所有作用域的配置、描述符、绑定和依赖图先统一验证，然后才运行任何 setup。使用 `definePlugin()` 可让校验后的配置类型传入 `setup(ctx)`。配置与工具 schema 会复制并冻结。

`setup` 的注册上下文提供：

| 方法 | 行为 |
| --- | --- |
| `provide(token, factory)` | 注册同步服务工厂，每个 run 最多调用一次 |
| `registerTool(definition)` | 注册工具；工具处理器接收该 run 的上下文 |
| `register(registry, name, definition)` | 向通用分层目录注册贡献，固定 owner、generation 与注册层 |
| `listen(target, type, listener)` | 管理 EventTarget 监听器，成功提交后激活 |
| `onCleanup(callback)` | 注册同步或异步清理回调 |
| `manage(resource, disposer)` | 兼容启动阶段已有资源；升级候选阶段拒绝使用 |
| `resource(name, acquire, dispose)` | 暂存资源声明，到激活阶段才获取；用返回句柄的 `get()` 访问 |
| `onConfigChange(listener)` | 注册受所有权管理的同步配置失效回调；不支持异步回调 |

注册仅在 setup 尚未完成时开放。所有注册记录都含 `owner`、`generation`、`scope`、`sessionId`，可通过 `runtime.inspect()` 查看。目录贡献还包含 `registryScope`。跨 Session 的同名工具互不冲突；同一注册层内重名拒绝，显式子层可以覆盖祖先。工具、命令和 Skill 共享 `ScopedLayers` 底座，使用方式及边界见[注册目录作用域](docs/scoped-registries.md)与[完整示例](examples/scoped-registries.ts)。

## Run 快照与替换

每次 `session.run(callback, options?)` 在入口复制当前服务和目录绑定，并提供不可变的快照接口。第二参数兼容原 `ServiceScope`，也支持 `{ serviceScope, registryScope }`。服务绑定只选择宿主回调的 Provider；工厂和工具处理器仍使用自身插件的服务绑定。贡献目录则由本次 run 的所有消费者共享，使模型 schema、工具执行、PTC、命令和 Skill 使用一致的可见层。服务工厂按需执行并按完整绑定身份缓存于本次 run；消费者应当在工厂或工具处理器里用 `run.services.get()` 解析声明过的依赖。setup 没有全局服务查询入口。

快照不可变指绑定、版本及元数据不可变，服务内部的业务状态仍可更新。跨 run 的消息、连接等状态应保存在相应的 Runtime / Session setup 闭包中，并注册清理。服务工厂只构造 run 内使用的对象；首版没有第三种 Run 资源作用域。

L1 `updateConfig()` 先经 schema 校验，再生成不可变配置版本；已有 run 保留旧版本，之后的 run 使用新版本。适配器从 `run.configuration` 读取 endpoint、模型和工具策略，不从 setup 闭包保存旧值。Session 插件在 `start()` 时自动持久记录配置版本及 `run.manifest`。

L2 `enablePlugin()` / `disablePlugin()` / `replacePlugin()` 执行 validate → 仅注册候选 → 阻止新 run → 等待已有 run 结束 → 按声明边界激活并切换 → 释放旧资源 → 返回并记录结果。暂存阶段允许旧 run 继续进入。首版每个 run 捕获全部已启用插件，因此使用 Runtime 级等待屏障。

结果含 `status`、`switched`、`generation`、`boundary` 和 `cleanupErrors`；历史结果可从 `upgradeHistory()` 查询。`stop-first` 必须先停止旧资源，随后失败不承诺无损回退。释放超时或失败会保留未确认资源的信息，并要求重启；`health()` 可查询详情。generation 不复用。

L3 使用 `ManagedProcess` 在空闲边界重启第三方子进程，或向宿主返回整进程 `restart-required`。不修改 Node ESM 缓存图，不实现任意状态迁移。完整说明及审批接入见 [docs/hot-reload.md](docs/hot-reload.md)。

## 生命周期与边界

- 初始化失败按依赖逆序撤销已注册的服务、工具、监听器和受管理资源。同一插件内按注册逆序清理，并在异步清理前移除监听器。
- `session.close()` 关闭该 Session；`runtime.close()` 先关闭全部 Session，再按依赖逆序关闭 Runtime 插件。清理失败会汇总为 `AggregateError`，其余清理继续执行。
- run 的回调抛错同样释放生命周期屏障。通过快照启动的在途工具，以及通过 `run.track()` 跟踪的管线/PTC 工作，会在结束 run 前等待完成。
- run 结束后，快照查询与工具调用拒绝访问。插件必须自行遵守已取得的服务实例仅在本次 run 内使用的约定；首版不使用 proxy/lease 拦截任意对象引用。
- 生命周期操作串行执行；L2 切换和关闭使用 Runtime 等待屏障，因此关闭一个 Session 也会等待其他 Session 的 run。L1 更新无需等待旧 run。
- 为避免自等待死锁，禁止在同一 Runtime 的 run、setup、cleanup 回调内发起 run 或生命周期操作；这类调用会报 `REENTRANT_LIFECYCLE`。请从外部调用它们。
- 插件必须等待自己启动的异步工作。等待 run 和清理资源有可配置超时；超时只报告失败，不能冒充 JavaScript 工作已取消或资源已销毁。内核不会追踪直接启动的任意后台任务。
- 内核只回收通过注册上下文管理的资源，不承诺撤销文件写入、网络请求等外部副作用；原生插件在宿主进程内执行。

## 源码导航

| 文件 | 职责 |
| --- | --- |
| [src/types.ts](src/types.ts) | 公共插件、服务、工具和快照契约 |
| [src/isolation.ts](src/isolation.ts) | 不可变服务绑定域、隔离键与插件实例身份 |
| [src/scopes.ts](src/scopes.ts)、[src/registry.ts](src/registry.ts) | 贡献父链、通用分层存储、注册契约及目录快照 |
| [src/skills.ts](src/skills.ts) | 显式 Skill 注册、局部摘要/正文/附属文本读取 |
| [src/plan.ts](src/plan.ts) | 配置、版本、作用域、依赖图验证与拓扑排序 |
| [src/resources.ts](src/resources.ts) | 注册事务、资源所有权、回滚和清理 |
| [src/snapshot.ts](src/snapshot.ts) | run 内的绑定快照、依赖访问和工具调用 |
| [src/runtime.ts](src/runtime.ts) | 启动、Session、等待屏障、替换与关闭 |
| [src/services.ts](src/services.ts) | 能力服务的最小接口与 token，包括通用 SandboxService |
| [src/session/](src/session/) | 事件模型、文件日志、恢复状态机及 Context 投影插件 |
| [src/configuration.ts](src/configuration.ts) | 配置版本与同步失效通知 |
| [src/permissions.ts](src/permissions.ts) | 完整绑定、过期校验、单次消费的审批及 PermissionService v3 |
| [src/managed-process.ts](src/managed-process.ts) | 第三方子进程停止确认与受控重启 |
| [src/tool-pipeline.ts](src/tool-pipeline.ts) | Native/PTC 共用校验、权限、计量、调度与持久结果 |
| [src/sandbox/](src/sandbox/) | Docker/macOS Seatbelt 后端、过滤工作区副本、限制与清理确认 |
| [src/ptc/](src/ptc/) | 共用 sandbox 上的模型代码协议、取消与父子调用审计 |
| [src/agent/](src/agent/) | DeepSeek、Agent Loop、工作区工具及 Host/Sandbox 命令插件 |
| [src/evaluation/](src/evaluation/) | 版本化任务、独立 trial、受控执行器、确定性判分与本地报告 |
| [src/observability/](src/observability/) | 已提交 Session 的指标与调用投影、插件和离线导出 |
| [src/cli/](src/cli/) | 薄启动入口、终端插件、单次审批与 Session 恢复 |
| [test/](test/) | 失败路径、并发隔离、替换与生命周期测试 |

这些能力均由插件显式注册，内核不会隐式调用。CLI 使用 Native Tool Pipeline；PTC 可由宿主按需组合。用户审批必须走完整绑定的回复与 `invokeApproved()` 路径；仅在日志中写入 allow 不等于获得可重放的审批凭据。
