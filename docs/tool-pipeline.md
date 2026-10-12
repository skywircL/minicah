# Tool Pipeline 与 PTC

第 5 节的实现由 `createToolPipelinePlugin()`、`createPtcPlugin()` 与 sandbox Provider 组成，可选择 `createDockerSandboxPlugin()` 或 macOS 的 `createSeatbeltSandboxPlugin()`。通用 `SandboxService` 承担隔离执行和进程清理，ExecutionService 与 PTC 在其上分别提供普通命令和模型代码运行。内核仍只负责注册、快照和生命周期；参数验证、计量、调度、隔离与审计属于能力实现。

其中 JSON Schema 校验算法由 Ajv 提供，隔离机制由 Docker/OS 或 macOS Seatbelt 提供；这些第三方实现不计为本项目贡献。本项目新增的是校验器接入、Host 权限与计量编排、后端策略、工作区复制、控制协议、取消/清理状态处理和持久审计。`DockerProcessSandbox` 与 `SeatbeltProcessSandbox` 是隔离后端适配器，不是自研容器或操作系统沙箱。完整复用范围见 [README 的复用与贡献边界](../README.md#复用与贡献边界)。

分层参考 DSH commit `4878cdabd87d4041bdaff61d04c966883b9fd07a`：[SandboxProvider](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/sandbox/sandbox/src/index.ts) 负责按单次策略包装精确 argv，[SubprocessRuntime](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/subprocess/subprocess/src/types.ts) 提供启动、terminate 和受管范围退出确认；[Node PTC](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/ptc-runtime/ptc-runtime-node/src/index.ts) 在上面增加代码 bootstrap、bindings、控制通道和 deadline。DSH 原生 sandbox 的公开策略主要约束文件写入，不能等同于本项目 Docker 的无网络、独立文件空间和资源限制。minicah 将隔离与受管执行合在 `SandboxService` 接口中，提供 Docker 与 macOS Seatbelt 首版 Provider；没有实现 Linux Landlock/Bubblewrap 或 Windows 后端。

`ModelService`、`ToolService` 的 token 版本为 **3**，`PtcRuntimeService` 为 **2**。`PermissionService` 升级为 **3**，要求 `invokeApproved()` 在单次消费审批的同一 dispatch 边界调用 Host 的同步 `beforeExecute`，并将取消上下文传入工具；旧的 v2 Provider 不能用于新管线。Coding 模型适配器返回带 usage 和结构化调用的 ModelCompletion。Native 批量调用使用 `ToolService.invokeMany()`，通过 `Promise.all` 提交到共享调度器，按输入顺序返回结果；它并不逐个等待模型工具调用。PTC 的循环、分支和中间处理在程序中完成。

## 共用执行链路

每个 run 只有一个 ToolService 实例。Native 调用和 PTC 的 Host 子调用都使用这个实例：

1. 统计尝试次数，复制严格 JSON 输入，用 Ajv 验证固定 generation 的 schema。
2. 记录计划，执行 Host 策略；写入还要求 PermissionService 完整绑定审批。
3. 同步、原子地登记在途调用数与成本。
4. 进入有界调度器，等待空位，排队期间允许取消。
5. `fsync` 提交执行意图；在实际 dispatch 的同一同步边界复核取消、策略和审批。
6. 执行固定 generation 的实现，形成结构化结果和脱敏、有界证据。
7. 按 Session 的终态耐久性配置提交事件后，才返回终态或通知订阅者。

Ajv 使用严格模式，不转换类型、不补默认值、不移除额外参数，不接受异步 schema，不自动获取远程 `$ref`。schema 与实现来自同一个 run 快照。`run.tools` 是可信插件的底层调用接口；面向模型的适配器必须使用 `services.tool`，不得绕过管线。

工具需显式声明 `effect: "read"` 才可用于 PTC；未声明时按 `non-idempotent-write` 处理。Host 的只读标签是可信工具实现的契约，不是对任意原生代码的静态证明。

```ts
ctx.registerTool({
  name: "lookup",
  description: "Read an approved record",
  effect: "read",
  inputSchema: {
    type: "object", properties: { key: { type: "string" } },
    required: ["key"], additionalProperties: false,
  },
  async execute(input, run, execution) {
    // Host 工具仍需自己约束路径、网络目标、数据范围，并响应 execution.signal。
    return { value: await readApprovedRecord(input, execution?.signal) };
  },
});
```

运行前由调用方留存 `pipeline.definitions()`，并将其引用加入 `session.start()` 的工具版本列表；模型、prompt、插件实际定义也需照常留存。可运行示例：[examples/tool-pipeline.ts](../examples/tool-pipeline.ts)。

## 策略与审批

默认策略允许显式只读工具，拒绝未审批写入。实际工作区规则通过 `ToolPolicy.authorize(request, signal)` 实现；`request` 包含完整参数、工具 generation、来源和 run。`assertCurrent(request)` 是 dispatch 前的同步校验入口，用于检查策略是否仍有效。PTC 首版即使得到自定义 allow，也会被 Host 拒绝写入。

交互宿主可以提供 `PipelineOptions.approve(request, signal)`，或向 `createToolPipelinePlugin(options, true, approvalUiToken)` 传入 UI 服务 token。回调仅在参数与策略通过后触发，返回包含完整 binding 的一次性回复；管线调用 PermissionService 校验并在日志中记录 allow/deny。取消和退出时撤销未消费的批准。CLI 的具体组合见 [Coding Agent](coding-agent.md)。

Native 写入先用 `PermissionService.request(callId, name, args)` 创建请求。UI 回复完整 binding 后，将回复传入 `pipeline.invoke(name, args, { callId, approval })`；管线负责调用 `reply()`，记录决定，并在最终执行边界单次消费审批。不要在此路径中提前调用 `reply()` 两次。旧审批、参数变更、工作区/策略变化、generation 变化或过期都不能执行写入。

批准 PTC 程序不授予其工具权限。程序不能指定 Host callId、parentCallId、policyVersion、审批、计量成本或 `source`；这些信息由 Host 构造。每个子调用仍通过上面相同的参数与策略检查。

## 计量、并发和取消

默认值可通过插件选项调整。数值限制也支持 `config["tool-pipeline"]` / `config.ptc` 和 L1 更新：先校验，记录配置版本，下一次 run 使用；策略、成本估算和脱敏函数通过 L2 更换相应插件，并由应用留存实际实现定义。PTC 启动事件保存 Provider 配置（包括 Docker 镜像 digest）、声明的 `workspace: "none"` 和本次限制；终态 `result.execution` 保存实际执行 ID 与后端返回的 profile。普通命令结果的 `sandbox` 字段同样保留实际 ID、profile、诊断和清理状态，随工具结果提交。

默认限制：

| 约束 | 默认值 | 含义 |
| --- | --- | --- |
| Pipeline concurrency / maxQueued | 4 / 32 | Native 和 PTC 共用的执行槽位、排队上限 |
| Pipeline deadlineMs / cleanupMs | 30,000 / 5,000 | 从管线准入开始计时；取消后等待执行确认的期限 |
| Pipeline maxInputBytes / maxOutputBytes | 64 KiB / 64 KiB | 输入 JSON 上限、每个结果的审计证据上限 |
| PTC concurrency | 4 | 单个程序的在途子调用上限，同时受共享 Pipeline 调度器约束 |
| PTC deadlineMs / cleanupMs | 30,000 / 10,000 | 包含意图提交与后端启动；到期请求终止，另外等待清理确认 |
| PTC program / input / output | 各 64 KiB | 程序、输入、总 stdout+stderr（含控制帧）与最终证据的限制 |
| Sandbox timeoutMs / concurrency | 60,000 / 4 | 单次受管执行 deadline、共享隔离执行并发上限 |
| Sandbox maxInputBytes / maxOutputBytes | 各 1 MiB | 受管 stdin、stdout+stderr 上限；消费者可缩小 |
| PTC maxTransferBytes | 1 MiB | 控制协议向隔离进程写入的初始化材料及工具回复上限，同时受 Sandbox stdin 限额约束 |
| Sandbox maxWorkspaceBytes / maxWorkspaceFiles | 64 MiB / 20,000 | 过滤后复制总字节数、条目数（含目录和保留的符号链接） |

`ToolUsageMeter` 只统计用量，没有累计次数、尝试次数或成本配额。`ToolService.state().usage` 提供计数；旧的 `state().budget` 接口已替换，旧累计额度配置不再接受。PTC 同样没有累计子调用次数上限，但仍受单次程序的 deadline 和传输字节限额约束。

计量变更在任何 `await` 之前同步完成。排队取消会退还尚未 dispatch 的预留；尝试次数不退还。已派发调用即使失败，也消耗其预留成本。失败不会隐式重试。成本目前是 Host 配置的工作单位，不是模型 token 计费器。

取消立即关闭新 dispatch，传播 `AbortSignal`，请求后端终止隔离执行并等待 Host 工具结算。信号发出、等待超时、实际执行停止是不同状态。原生工具若忽略取消，管线返回 unknown，并保留占用的槽位/预留，直到底层 Promise 真正结算。run 仍跟踪底层工具，因此 Provider 不能在执行期间被安全替换；Runtime drain 超时会报告失败。任意阻塞宿主线程的原生代码无法由 JavaScript 定时器强制停止，应改为受管理的隔离执行。

`run.track()` 跟踪管线及 PTC 从验证到提交的完整异步工作；提前返回 run 回调不会漏掉尚未 dispatch 的调用。它不是第三种资源作用域，也不追踪插件自行启动的任意后台任务。

## 共享的一次性 Docker 隔离

```ts
// 加入 Runtime.create({ plugins: [...] })；同时组合所需 Session/Tool 等插件。
createDockerSandboxPlugin({ image, workspace });
createSandboxExecutionPlugin(workspace); // ExecutionService → SandboxService
createPtcPlugin(undefined, { deadlineMs: 30_000, concurrency: 4 }); // PTC → 同一服务
```

`createPtcPlugin()` 不传后端工厂时，依赖当前 run 中固定 generation 的 `services.sandbox`。`SandboxPtcBackend` 只拥有 bootstrap、ControlChannel 和 bindings，不关闭借用的共享服务。兼容入口 `createPtcPlugin(() => new DockerSandbox({ image }))` 仍可使用；包装器内部创建并拥有独立 `DockerProcessSandbox`，`health().active` 保留原布尔接口。

镜像必须是可信、已经在本地准备好的 Node Linux 镜像，使用 `name@sha256:...` 固定版本。需要包含 `/usr/bin/env`、`/usr/local/bin/node`。代码不自动拉取镜像或启动 Docker 守护进程。镜像不能声明隐式 volumes；镜像本身与 Docker daemon 属于可信计算基础。

每次普通命令或 evaluate 新建容器，用完删除，没有容器复用、状态迁移或宿主脚本回退。共享底座默认最多同时拥有 4 个活动容器；PTC 自身同一实例只允许一个 evaluate，各 Session 的执行仍共享底座资源限制。

| 边界 | 当前策略 |
| --- | --- |
| 文件 | 镜像根只读，独立 `/tmp` tmpfs 默认 16 MiB，nosuid/nodev/noexec；PTC 固定无 workspace；普通命令可使用过滤后的临时副本，不挂载宿主源码原目录、Docker socket 或任意用户路径 |
| 网络 | `--network=none`，不发布端口；工具访问仍受 Host 参数/策略约束 |
| 环境 | 不传入宿主环境；`env -i` 只设置 PATH 和 HOME；镜像需由 Host 审查 |
| 身份/权限 | uid/gid 65534，drop ALL capabilities，no-new-privileges；要求 Linux daemon 的 seccomp 启用，不接受 unconfined 回退 |
| 进程 | 容器 PID namespace，`--init`，默认最多 32 个任务；不共享宿主 PID/IPC；允许容器内受限子进程 |
| 资源 | 核心默认内存/含 swap 总额均 128 MiB，1 CPU，64 个文件描述符；CLI Docker 命令使用 512 MiB；PTC 默认 V8 old-generation 上限 64 MiB，完整内存仍由容器限制 |
| 输出 | 非 TTY 有界管道；普通命令收集 stdout/stderr，PTC stderr 计数后丢弃；关闭 Docker 日志驱动 |

命令的 `workspace: "snapshot"` 将过滤后的 Host 副本只读挂载到 `/input`，再复制到容量有界、可写的 `/workspace` tmpfs。构建和测试可以修改副本，运行结束后丢弃，不回写 Host。每次重新复制当前工作区，前一次容器的依赖安装或构建产物不保留。默认排除 `.git`、`.minicah`、`.env`/`.env.*`、`.ssh`、`.aws`、`.npmrc`、`.netrc` 和常见私钥名；这是路径过滤，不能识别普通源码文件中嵌入的所有秘密。保留经过检查的直接内部相对符号链接（如 npm `.bin`），跳过外部、受保护或链式链接、硬链接和特殊文件。snapshot 默认不超过 64 MiB / 20,000 个条目，`/workspace` 默认 128 MiB；超限明确拒绝，不静默截取项目。网络关闭，因此执行所需依赖须已存在于可信镜像或副本。

`docker-sandbox` 使用静态配置。镜像、工作区和资源策略变更须 L2 替换：暂存仅注册的候选、阻止新 run、等待旧 run drain、切换 generation、关闭旧资源。已进入 run 的 ExecutionService 和 PTC 使用同一旧服务快照。普通命令与 PTC 的 Host 子工具仍分别通过 Tool Pipeline 验证和审批；容器权限不会授予 Host 文件工具额外权限。

这些限制使用 Docker/OS 的隔离机制，参数语义见 [Docker 官方运行说明](https://docs.docker.com/engine/containers/run/) 和 [容器 create 参数](https://docs.docker.com/reference/cli/docker/container/create/)。部署方需维护 daemon、镜像和操作系统，遵循 [Docker 安全边界](https://docs.docker.com/engine/security/)；容器隔离不能替代 Host 工具权限。首版没有用 `node:vm`、Worker、cwd 或普通子进程充当安全边界。程序中的 `AsyncFunction` 仅是隔离环境内的语言入口。

程序经 stdin 传入，输出为 JSON line 协议。程序可伪造控制帧，因此 Host 拒绝额外字段、重复请求 id、非 JSON 数据、未绑定工具、超限帧和终态后的新帧；协议中的请求 id 只用于回复路由。Host 自己生成持久化子调用 id，并绑定父调用。

容器停止需得到 daemon 对 `rm --force --volumes` 的成功回复，并确认 attach 通道关闭。杀掉 Docker CLI 只停止客户端，不能证明容器已停止。创建请求超时还可能在 daemon 继续执行，因此即使之后 remove 返回，也保守标记 unknown。`close()` 先停止准入、取消活动执行并等待清理；未确认资源名保留在 `SandboxService.health().unresolved`，随后关闭报 `RESTART_REQUIRED`、新 dispatch 被拒绝。仍可能被容器引用的临时快照保留待核对。内部 deadline、I/O 限额和取消通过 `stopped` 通知 PTC 立即关闭 Host 子调用准入，最终返回还须等待清理。

## macOS 原生后端首版

`createSeatbeltSandboxPlugin({ workspace })` 提供相同 `SandboxService`，CLI 选择 `--sandbox native`。它使用 macOS 自带的 `/usr/bin/sandbox-exec` 应用 Seatbelt 策略，复用操作系统机制；不依赖 Docker，不实现自己的内核隔离。还需要 Xcode Command Line Tools 提供的 `/usr/bin/otool`，用于解析可信 Node 的动态库依赖。首次运行时的整个依赖图解析有 10 秒期限；工具缺失、依赖无法解析或超时均失败关闭。

策略默认拒绝，禁止网络、系统 socket 和 Mach 服务查找，并限制进程信息读取；只读开放必要的系统运行目录，以及可信 Node 可执行文件和解析出的动态库路径，不开放整个 HOME 或 Homebrew 目录。sysctl 只开放运行时必需的指定系统信息。每次调用的 HOME/TMPDIR 指向私有临时目录，环境使用固定 PATH 和 `OPENSSL_CONF=/dev/null`。`workspace: "snapshot"` 使用同样经过过滤、受输入配额限制的私有可写副本，不回写源目录；PTC 的 `workspace: "none"` 不获得项目副本。目录 metadata 许可仅供系统加载路径解析，具体文件读取仍受 profile 约束。

首版明确禁止 `process-fork`，使每次执行的受管范围保持单个进程；允许该进程的线程。PTC 使用当前后端受信 PATH 解析的 `node`，无需改动 bindings 或 Host 工具管线。程序可以通过 bindings 请求 Host 工具，每个工具仍有独立权限与取消策略；直接创建子进程会失败。需要子进程的 npm、测试运行器或编译流程应使用 Docker，或在明确接受宿主权限的情况下使用 Host 模式。

原生后端有 deadline、输入/输出字节限额、取消和退出确认，但不声称拥有 Docker 等价的 cgroup 内存/CPU 限制、独立 PID namespace 或 tmpfs 磁盘配额。PTC 的 V8 old-generation 参数也不等于进程总内存限制。Provider 不可用时失败关闭，不将普通 spawn 充当 OS 隔离。部署时需按实际 profile 理解文件与执行权限，不能由同一个 `SandboxService` 接口推断所有后端保证相同。

原生清理失败时，`health().unresolved` 保留执行 ID，`health().details` 进一步提供未确认进程的 `pid` 和保留副本/临时目录的 `retainedPaths`，供人工查询与恢复。新执行被拒绝，关闭报告 `RESTART_REQUIRED`；停止等待不代表已确认销毁。

## 结果、审计与恢复

每个子调用包含 `callId`、`parentCallId`、`status`、`dispatched`、`code`、`value`。`dispatched: null` 表示连派发与否也尚未确认。

- `completed`：工具实际返回可序列化结果，终态已提交。输出过大时 `code=OUTPUT_TRUNCATED`，value 为明确受限的证据预览。
- `failed`：未执行、策略拒绝、资源超限，或程序已确认失败；仍逐项保留已完成的子调用。
- `unknown`：执行抛错可能发生在副作用之后，或进程/Host 清理尚未确认。保留未结算调用，不自动重跑程序或写入。

新增 Session 事件包括 `pipeline.rejected`、`ptc.started`、`ptc.completed`、`ptc.uncertain`。拒绝记录也带父子关联。PTC 在启动前 fsync 记录意图；终态在清理检查与子调用处理后提交。未知父调用与未知子调用继续阻止不安全的摘要覆盖。日志重放没有执行器，不会重新执行程序。

默认脱敏覆盖常见 secret/token/password/API key 字段及常见字符串形式。实际数据源应配置 `redactor` 和 `redactionVersion`，负责领域特定信息；通用正则不能识别所有敏感信息。脱敏在截断之前执行，避免在预览里保留原始秘密。原始 stderr、异常消息不会直接进入审计；程序源码、输入、最终输出及工具结果仅留有界、带脱敏版本和截断标记的证据。首版不实现外部 artifact 存储后端。

脱敏的工具输入额外保留原参数 hash 用于审批关联。hash 不替代内容：若原参数已不可用，恢复返回 `restore-input`，`Session.executeTool()` 拒绝直接执行脱敏内容；必须重新取得真实参数，经验证和新权限决定创建明确的新调用。

`projectPtcOutput(result, maxBytes)` 只产生更短的模型可见投影，同时保留审计是否已截断的标志，不改变 Session 事件。对话摘要同样不能删除尚未结算的父子调用。

## 验证

```sh
npm test
npm run demo:pipeline
# Docker 已启动且本地有可信镜像后，设置真实 digest：
export MINICAH_SANDBOX_IMAGE='your-node-image@sha256:实际的64位digest'
export MINICAH_PTC_IMAGE="$MINICAH_SANDBOX_IMAGE"
npm test
npm run demo:pipeline
# macOS：同时启用真实 Seatbelt 回归；可与上面的 Docker 环境变量组合
MINICAH_NATIVE_TEST=1 npm test
```

默认测试覆盖真实文件日志、管线、Host 权限/计量/取消、注入 Docker driver 和恶意协议帧。共享 sandbox 新增测试覆盖命令与 PTC 共用服务、工作区过滤和配额、符号链接与硬链接处理、deadline 时及时取消 Host 子调用、资源关闭、L2 替换等待、CLI 参数与失败关闭。测试 driver 不执行不可信程序，也不作为生产隔离后端。

`MINICAH_SANDBOX_IMAGE` 启用通用底座的真实容器回归：验证可写临时副本、Host 文件不被修改、过滤路径不可见、网络限制、同一底座中的 PTC 无 workspace，以及取消后没有活动/未确认容器。`MINICAH_PTC_IMAGE` 启用兼容包装器的真实回归：循环/分支/并发、只读根、最小环境、非 root 身份和无限循环 deadline 清理。未设置相应变量时显示 skip。演示优先读取 `MINICAH_SANDBOX_IMAGE`，兼容 `MINICAH_PTC_IMAGE`，PTC 预期得到 `{ total: 30 }`。实际结果以本次测试报告为准。

`MINICAH_NATIVE_TEST=1` 在 macOS 启用真实 Seatbelt 共享底座集成，验证普通执行与 PTC、文件/网络/进程权限、Host bindings 和取消清理；其他平台或未设置时跳过。该集成已通过，另已在原生沙箱临时副本中对本项目运行 `tsc --noEmit` 并通过，源工作区未被回写。这验证了单进程 TypeScript 检查场景，不扩大为对多进程构建工具或 Docker 等价资源限制的承诺。

参数验证前可解析出的有界路径，经脱敏后随 `pipeline.rejected.inputPath` 保存，以核验被拒的路径尝试；字段对旧日志可缺省。该记录不表示已派发，也不表示发生过审批。
