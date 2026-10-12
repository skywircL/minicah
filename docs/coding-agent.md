# Coding Agent

## 启动

Node.js 22.19+，当前宿主机命令管理支持 macOS/Linux 的 POSIX 进程组。默认 `--sandbox host`，运行 Coding Agent 不要求 Docker，但宿主命令没有 OS 隔离。显式选择 `--sandbox docker` 或 macOS 的 `--sandbox native` 后，命令使用与 PTC 共用的通用 SandboxService。

```sh
npm ci
export DEEPSEEK_API_KEY='你的本地密钥'
npm run agent -- --workspace /path/to/project
```

交互模式每次输入一个任务，`/help` 查看命令，`/exit` 退出。单次执行使用 `--task`；只读检查使用 `--read-only`。`Ctrl-C` 取消当前 run，等待执行清理和日志提交。

```sh
npm run agent -- --workspace /path/to/project --task "阅读相关代码，修复这个问题并运行测试"
npm run agent -- --workspace /path/to/project --read-only --task "解释项目结构"
npm run agent -- --help
```

启用通用 Docker sandbox：

```sh
export MINICAH_SANDBOX_IMAGE='your-node-image@sha256:实际的64位digest'
npm run agent -- --workspace /path/to/project --sandbox docker
# 也可直接传 --sandbox-image 'your-node-image@sha256:实际的64位digest'
```

镜像必须可信、预先准备在本地并固定 digest，包含 `/usr/bin/env` 和 `/usr/local/bin/node`。CLI 不自动拉取镜像或启动 Docker；选择 Docker 后，缺失镜像或不可用隔离会明确失败。普通 CLI 仍使用 Native 工具调用，`--sandbox docker` 切换命令执行后端；模型代码 PTC 由宿主另行组合。

macOS 原生隔离无需镜像：

```sh
npm run agent -- --workspace /path/to/project --sandbox native
```

这使用 Seatbelt 首版，需要系统 `sandbox-exec` 和 Xcode Command Line Tools 中的 `otool`：禁止网络、创建子进程和未经授权的进程信息读取，命令在过滤后的私有工作区副本上执行，不回写源目录。系统运行目录和可信 Node/动态库只读，HOME/TMPDIR 为每次调用的私有临时目录。单进程脚本和通过 Host bindings 调用工具的 PTC 可以使用；npm 等需要创建子进程的命令可能被拒绝，应选择 Docker 或 Host。原生后端不提供 Docker 等价的总内存、CPU、PID 或磁盘配额；所需工具不可用、依赖解析失败或平台不支持时失败，不自动退回 Host。

默认配置是 `https://api.deepseek.com`、`deepseek-flash`、thinking 关闭。`--model` / `DEEPSEEK_MODEL` 和 `--endpoint` / `DEEPSEEK_BASE_URL` 可覆盖；`--thinking` 启用 provider 的思考模式。模型名与可用权限以自己的 DeepSeek 账户为准。协议参考 [DeepSeek 工具调用](https://api-docs.deepseek.com/guides/tool_calls/)、[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) 和 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。

直连密钥使用 `DEEPSEEK_API_KEY`，不放入插件配置、Session 或命令参数。CLI 自动读取启动目录（不是 `--workspace` 指定目录）中的 `.env`，仅导入下表中的模型密钥、`GOOGLE_API_KEY` 别名、`DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL` 和 `MINICAH_SANDBOX_IMAGE`；同名环境变量优先。可复制 `examples/environment.example` 为 `.env` 后填写密钥；模板中保持空密钥。`.env` 已被本仓库 Git 忽略。`--help`、`--list-models` 和 `--replay` 不读取环境文件。

## Pi 多模型接入

参考 DSH 的 [dsh-llm-pi-ai](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai)，复用锁定的 [Pi `@earendil-works/pi-ai@1.0.2`](https://github.com/earendil-works/pi/tree/main/packages/ai) 厂商协议实现。Harness 的 Agent Loop、审批、工具和 Session 保持共用。项目新增的是 Pi 与 `ModelService` 之间的适配插件。

```text
Agent Loop → ModelService
               ├─ createDeepSeekPlugin → openai SDK → DeepSeek API
               └─ createPiPlugin → pi-ai → OpenAI / Anthropic / Google / …
```

CLI 默认 `--provider deepseek`。选择 `--provider pi` 时，必须显式传 `--pi-provider` 和 `--model`，不会从 `DEEPSEEK_MODEL` 猜测。先通过 `npm run agent -- --list-models --pi-provider openai` 查看本地目录；省略筛选可列出这 8 个接入厂商。输出包含模型 ID、协议、上下文/输出上限、`reasoning` 和允许的 `reasoningLevels`，无需密钥或网络。

| `--pi-provider` | API key 环境变量 | 目录内示例 |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | `gpt-5.4`、`gpt-4.1` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| `google` | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| `deepseek` | `DEEPSEEK_API_KEY` | 用 `--list-models --pi-provider deepseek` 查询 |
| `openrouter` | `OPENROUTER_API_KEY` | 用 `--list-models --pi-provider openrouter` 查询 |
| `xai` | `XAI_API_KEY` | 用 `--list-models --pi-provider xai` 查询 |
| `groq` | `GROQ_API_KEY` | 用 `--list-models --pi-provider groq` 查询 |
| `mistral` | `MISTRAL_API_KEY` | 用 `--list-models --pi-provider mistral` 查询 |

Google 也接受 `GOOGLE_API_KEY`，优先使用非空的 `GEMINI_API_KEY`。厂商目录随锁定依赖版本保存，不代表账户权限或服务当前可达性。这里只接入文本及工具调用的 API key 流程；Pi 提供的 OAuth、订阅登录、Bedrock/Vertex 等云凭证路径及多模态能力没有自动成为本项目能力。

```sh
export OPENAI_API_KEY='你的本地密钥'
npm run agent -- --provider pi --pi-provider openai --model gpt-5.4 --reasoning high --workspace /path/to/project

export ANTHROPIC_API_KEY='你的本地密钥'
npm run agent -- --provider pi --pi-provider anthropic --model claude-sonnet-4-6 --workspace /path/to/project

export GEMINI_API_KEY='你的本地密钥'
npm run agent -- --provider pi --pi-provider google --model gemini-2.5-flash --workspace /path/to/project
```

Pi 使用 `--reasoning`，默认 `off`；所选级别必须在模型目录的 `reasoningLevels` 内，未列出 `off` 的模型需要显式指定级别。`off` 按 Pi 的各模型协议转换，不保证所有模型都关闭思考；例如 Gemini 2.5 Pro 始终思考，`off` 只使用其最小思考预算。`--thinking` 仅适用于 DeepSeek 直连。

`--context-window` 默认采用 Pi 模型目录值，输出预留默认为 `min(4096, 模型输出上限)`；自定义限制不能超出目录容量。Harness 将实际请求的输出上限约束在本次预留内，避免 Pi 因思考预算自动增加输出上限。启用 Google 思考或 Anthropic 的预算式思考时，输出预留至少为 2048 tokens；思考预算须为可见回复保留空间。Anthropic 的自适应思考由其协议处理。`--endpoint` 可覆盖所选模型的 API 地址，保留该模型的协议与能力定义；未知模型名会被拒绝，不会被当作任意兼容模型发送。

Pi 插件的配置 owner 是 `pi-model`。例如在 Pi 模式启动后，工作区 `.minicah/config.json` 可以设置：

```json
{
  "version": 1,
  "plugins": {
    "pi-model": {
      "config": { "provider": "openai", "model": "gpt-5.4", "reasoning": "high", "maxOutputTokens": 8192 }
    }
  }
}
```

配置变化在下一次 run 生效；切换厂商需要提前设置对应密钥。CLI 启动时只注册选中的一个模型插件；从 DeepSeek 直连分支切换到 Pi 分支需要用新的 `--provider` 重启。SDK 手动组合可注册 `createPiPlugin({ apiKey: () => process.env.OPENAI_API_KEY })`，并在 Runtime 的 `"pi-model"` 配置中指定厂商和模型；该回调适合固定厂商，动态切换厂商时使用默认按厂商取密钥的行为。

同样的选择也接入评测 CLI。例如使用自己的密钥运行：

```sh
npm run eval -- --suite examples/evaluation-smoke.json --provider pi --pi-provider openai --model gpt-4.1 --repetitions 3 --output .minicah/evals-pi
```

评测仍默认 `fixture` 离线模式；只有显式选择 `deepseek` 或 `pi` 才调用模型 API。每个 trial 使用独立 Runtime、Session 和工作区，报告记录具体厂商/模型及配置 hash，provider 错误作为基础设施问题报告。切换到 Pi 不重写历史 DeepSeek 基线，也不沿用旧分数证明新模型质量。

## CLI 内管理会话

在任务输入提示符处直接输入以下命令，无需退出 CLI：

| 命令 | 行为 |
| --- | --- |
| `/history [关键词]` | 按标题或 ID 筛选当前工作区的会话，输入编号切换；直接回车返回 |
| `/resume [ID或唯一前缀]` | 恢复指定会话；不带参数时打开会话列表 |
| `/new` | 切换到新的空会话，保留原会话日志 |
| `/replay` | 展示当前会话的已提交历史与待核对操作，不执行工具 |
| `/status` | 查看当前会话 ID、标题、更新时间、run 数及状态 |
| `/help` | 显示内置命令说明 |
| `/exit` | 关闭 CLI 并释放会话资源 |

例如先输入 `/history 修复`，再输入列表中的编号，就可以在恢复的上下文中继续提出任务。当前会话排在最前，其余按最近事件时间排序；每次最多显示 30 条，可以用关键词缩小范围。标题取第一条用户输入的前 72 个字符；尚无自定义改名、归档、删除、分叉或方向键选择界面。新建后尚未提交任何任务的空会话，只在当前进程中显示；离开后不会进入历史列表。

这些命令由 CLI 直接处理，不请求模型、不产生模型 token 用量。未知的 `/...` 命令也不会被当成任务发送；若任务以绝对路径开头，可先加上“阅读”等任务描述。普通启动仍沿用密钥配置检查；离线查看指定会话可用不需要密钥的 `--replay ID`。

会话切换发生在当前 run 完成之后。正在执行任务时，可先用 `Ctrl-C` 取消，等待清理及提交后再输入命令。切换前先校验目标日志及工作区，并成功打开目标会话，再释放旧会话。目标不存在、被其他写者锁定、前缀不唯一或日志损坏时显示错误，当前会话保持可用。清理失败导致 Runtime 要求重启时，CLI 会退出并报告错误。

历史列表可以只读查看被占用会话的完整日志前缀；列表中的锁标记只作提示，真正恢复时仍须取得写锁。列表读取不截断日志、不抢锁、不启动历史工具。有不确定操作的会话仍可查看历史或切换会话，但继续 Agent 任务须遵守下文的恢复规则。

这里参考 DSH 的 [命令服务](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/interaction/commands/src/index.ts) 与 [会话查询](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/api/session-controller/src/list.ts)：人的命令与模型输入分开，查询历史不需要激活对应 Agent。查阅的 DSH 版本没有直接注册上述 `/history`、`/resume` 命令；这些是本项目新增的 CLI 入口。首版使用固定的内置命令表，没有照搬 DSH 的动态命令注册及 UI 体系。

## 能力插件

| 能力 | 插件/契约 | 行为 |
| --- | --- | --- |
| 模型 | `createDeepSeekPlugin()` 或 `createPiPlugin()` / ModelService v3 | SDK HTTP/SSE、实际请求材料、结构化工具调用、usage、取消、整段流 deadline、输出限额 |
| 上下文管理 | `createCompactionPlugin()` / CompactionService | 每步测量、裁剪长工具结果、摘要历史、提交后切换 Surface |
| Agent Loop | `createAgentLoopPlugin()` / AgentLoopService v2 | Context → 模型 → 并发工具 → 持久结果 → 下一轮，直至完成或退出 |
| Coding 工具 | `createCodingToolsPlugin()` / ToolService | 工作区读写、文字搜索、受审批命令入口 |
| 命令执行 | `createExecutionPlugin()` 或 `createSandboxExecutionPlugin(workspace)` / ExecutionService v2 | 选择宿主进程或共享 sandbox 中的临时工作区 |
| 通用 sandbox | `createDockerSandboxPlugin({ image, workspace })` 或 `createSeatbeltSandboxPlugin({ workspace })` / SandboxService | 按后端策略隔离执行、有界 I/O 与清理确认 |
| PTC | `createPtcPlugin()` / PtcRuntimeService v2 | 使用同一 sandbox、JSON 控制协议、受限工具 bindings、父子调用审计 |
| 会话查询 | `createSessionCatalogPlugin(directory, workspace)` / SessionCatalogService | 只读校验日志并列出会话，不激活历史 Agent |
| CLI 命令 | `createCliCommandsPlugin()` / CliCommandService | 解析内置斜杠命令、生成帮助，与模型任务分流 |
| CLI | `createCliPlugin()` / ApprovalUiService | 任务、临时流、提交后进度、完整绑定审批及会话管理 |

`src/cli/main.ts` 只解析配置并启动 Runtime；CLI 插件拥有 readline 和信号监听器。每个任务从 `session.run()` 获取新的 AgentLoop，跨 run 不保存旧服务引用。一个 Session 同时只允许一个 Coding Agent Loop；不同 Session 可以并行。

手动组合 CLI 时，需同时安装会话查询与命令插件，并以 `cli.start(new CliSessions(runtime, session, workspace), task?)` 启动。`CliSessions` 是 CLI 应用层的导航对象；生命周期切换在 `session.run()` 回调之外执行，避免等待自己的 run。内核没有新增会话列表或终端命令职责。

Coding Agent 的模型适配器必须提供 `limits()`，声明 `contextWindow` 和 `maxOutputTokens`。手动组合插件时须同时注册 `createCompactionPlugin()`。

ModelService 的 `definition()` 返回可保留的模型配置定义；`prepare(messages, tools, maxOutputTokens)` 生成可留存请求材料；`complete(request, { signal, onText })` 通过 SDK 发送它。Pi 材料包含选定模型、Pi Context 和无密钥选项，最终厂商协议序列化交给 Pi；DeepSeek 直连材料对应 Chat Completions 请求。两条路径均关闭 SDK 自动重试，不依赖服务端严格 schema 校验；所有工具参数在 Host 经 Ajv 校验。

模型工具 ID 与 Host callId 分开记录并关联到模型父调用。一个响应中的独立调用通过共享 ToolService 并发执行，仍受用量计量和调度上限约束。错误参数和拒绝结果以结构化工具消息反馈给模型。模型输出截断时不执行其中的工具建议；非正常 finish reason 不当作完成。

系统提示 `coding-agent@1.2.0` 优先遵从用户明确指定的最终回复格式；要求仅 JSON 时，键名及字符串使用双引号，不附加围栏、说明或未要求字段。没有指定格式时，默认用用户语言简短总结。格式要求不改变工具审批、权限或如实报告义务。

模型消息从 Context 的 Surface 顺序生成。一个节点代表用户输入、完整模型/工具批次或历史摘要；摘要作为历史用户材料进入上下文，受保护约束单独保留。管线工具结果只投影 `status`、`dispatched`、`code`、已经脱敏且有界的 `value`，保留 `OUTPUT_TRUNCATED` 等错误/截断标记。完整 `evidence` 和 Host 调用标识仍留在原始事件中，避免把 `value` 与 `evidence.value` 重复发送给模型。

DeepSeek thinking 开启时，provider 的 `reasoning_content` 作为不透明的协议继续字段保存并原样回传，不在 CLI 展示。Pi 的 `providerReplay` 保存带版本和来源校验的原生 assistant 消息，以保留 thinking 签名和工具续传信息；仅在匹配的来源配置下恢复，跨厂商/模型只投影公共文本和工具历史，不转发旧签名。两者均随已提交消息保存并在 Session 恢复后继续使用，临时流只显示普通文本。HTTP、SSE、模型能力和 JSON Schema 算法分别复用厂商、Pi/SDK/Node 与 Ajv，不计为自研实现。

## Coding 工具与审批

| 工具 | 行为 |
| --- | --- |
| `list_files` | 有界遍历，跳过依赖、常见生成目录、凭据和元数据 |
| `read_file` | UTF-8 文件，返回行片段及整个文件的内容 hash |
| `search_text` | 有界文字搜索，使用字面值，不执行用户正则 |
| `write_file` | `expectedHash: null` 只允许新建；覆盖必须提供读取时的 hash |
| `edit_file` | 匹配恰好一次的 `oldText` 并替换，校验文件 hash |
| `run_command` | 命令及 argv 分开传递，`shell: false`，cwd 相对于工作区 |

文件 hash 是 `contentHash(text)`，即 UTF-8 文本作为规范 JSON 字符串的 SHA-256，不是 `sha256sum file`。写入前复查 hash，同进程写入串行提交，以临时文件和 rename/link 替换；不存在“读旧文件后直接覆盖新改动”的默认路径。大文件、二进制、非 UTF-8、越界路径、符号链接、写入硬链接被拒绝。每个文件最多 512 KiB；读取片段、遍历、搜索、工具输入输出均另有限额。

所有写入和命令先完成参数验证及 Host 策略检查，再请求一次性审批，然后记录在途用量并进入调度。CLI 显示完整 binding 和参数，包括 approvalId、callId、参数 hash、workspace、策略版本、工具 generation、schema hash 和过期时间。输入 `y` 只授权本次调用；默认拒绝。非 TTY 不自动批准，也没有 `--yes` 绕过选项。策略变化、参数变化、过期、取消或重复回复均不能复用旧许可。

`run_command` 的执行位置由启动参数选择。默认 Host 模式使用 cwd、argv、进程组清理和环境变量白名单；这些不构成 OS 沙箱，获准程序仍可访问宿主用户本来有权访问的文件和网络。未列入白名单的模型 API key 不会通过环境变量继承。

Docker 模式每次为命令创建新容器：过滤后的项目副本只读挂载到 `/input`，再复制进可写 `/workspace`，cwd 映射到副本内对应目录。可生成构建或测试产物，所有容器内修改随执行结束丢弃，不回写 Host；持久文件变更仍通过审批后的 `write_file` / `edit_file`。这也意味着需要 Git 元数据或跨命令保存安装结果的工作流暂不适用。

快照默认排除 `.git`、`.minicah`、`.env`/`.env.*`、`.ssh`、`.aws`、`.npmrc`、`.netrc` 和常见私钥名，拒绝外部/受保护链接，保留经检查的直接内部相对链接。过滤基于路径名称，不能自动发现普通源码里嵌入的秘密。输入复制上限默认 64 MiB / 20,000 个条目（含目录），超限报错；可写 `/workspace` 默认 128 MiB。容器无网络，依赖须已在可信镜像或副本中；Host 安装的原生依赖还须匹配容器平台。CLI 为 Docker 命令配置 512 MiB 内存，其余默认策略见 [通用 sandbox](tool-pipeline.md#共享的一次性-docker-隔离)。

各执行模式都有单次时间和输出限额。Host 取消先 TERM、后 KILL 并检查进程组；自行脱离进程组的程序不在管理保证内。Docker 取消立即关闭准入，并等待 daemon 确认删除容器及 attach 关闭。Native 终止受管单进程并确认退出，再清理私有副本。清理不能确认则报告 unknown/restart-required，保留待核对资源名并拒绝新命令；原生 `SandboxService.health().details` 提供未清理 `pid` 与 `retainedPaths`。普通命令的结构化结果记录实际执行的 sandbox ID、profile（后端声明的文件、网络和资源策略；Docker 还包含镜像 digest）、诊断和 cleanup，随工具结果持久提交。Host 文件工具继续在宿主执行并服从自己的路径、hash 与审批策略。

手动组合时使用 `createDockerSandboxPlugin({ image, workspace })`、`createSandboxExecutionPlugin(workspace)` 和 `createPtcPlugin()`；macOS 可将底座换为 `createSeatbeltSandboxPlugin({ workspace })`。普通命令与模型程序借用同一 run 固定的服务，PTC 始终声明 `workspace: "none"`，项目材料通过 Host 工具 bindings 获取。旧 `createPtcPlugin(() => new DockerSandbox({ image }))` 仍可使用，但拥有独立底座。关闭插件会取消并等待其活动执行；镜像、工作区和 sandbox 资源策略为静态配置，通过 L2 替换并 drain 旧 run，不在执行中改变。DSH 的对应分层及与 Docker 边界的差别见 [实现参考](tool-pipeline.md)。

## 持久化与恢复

Session 位于工作区 `.minicah/sessions/`，终端显示其 ID。日志文件使用 0600 权限；目录和日志应只供本地用户访问，并从版本控制排除。为可追溯地重建模型请求，日志保留实际输入材料，因此可能含项目源代码或用户输入；工具审计另外使用现有有界脱敏证据。不要将日志视为已经消除一切项目秘密的可公开文件。

```sh
npm run agent -- --workspace /path/to/project --resume SESSION_ID
npm run agent -- --workspace /path/to/project --replay SESSION_ID
```

`--replay` 无需密钥，只重建展示和恢复状态，不请求模型、不执行工具。`--resume` 从已提交的 Context 开始接收新任务。已确认完成的操作不重复；已发出但未确认的工具调用、以及模型响应已提交但尚未进入工具管线的调用，分别显示 uncertain / not-started，并阻止自动续跑这批工具。需先核对外部状态，通过 Session reconciliation 接口明确结算，或新建 Session 并提供核对结果；当前 CLI 不自动判断外部写入是否发生。进程异常退出遗留的 journal lock 需在确认旧进程已结束后由操作者处理，CLI 不自动抢锁。

模型请求、响应、工具执行意图、结果与最终任务状态按 Session 提交协议写入。CLI 默认 fsync；临时 token delta 不逐 token 写日志，且可能在崩溃后消失。只有 `[已持久提交]` 标记对应终态提交完成，不能从可见流判断任务已完成。模型失败另记 `model.failed`，不制造成功响应。

请求可重建材料包含模型和 prompt 定义、工具 schema/generation、配置版本，以及当前内置插件的实际编译源码和依赖 lock 内容。第三方自定义插件应提供对应实现定义，不能仅提供失效路径或 hash。保存这些材料不保证外部模型未来返回相同结果。

## 上下文容量与累计用量

已经移除累计 token、模型调用次数、工具调用次数/尝试次数/成本、整次 run 时长的硬上限。旧 CLI 参数 `--max-tokens`、`--max-steps`、`--timeout` 及对应 run 配置字段不再接受；工具管线/PTC 的 `maxCalls`、管线的 `maxCost` / `maxAttempts` 同样移除。旧日志里的配置、`budget.exited` 和状态仍可重放，不会据此恢复已删除的限制。

模型 usage 继续按请求持久记录，摘要请求也计入 `AgentResult.tokens` 和 `steps`（CLI 显示为 requests）。模型未返回 usage 时，`chargedTokens` 使用输入估算加输出预留；这属于估算用量，不能作为精确账单。失败请求保留意图和失败记录，其未知远端用量不伪造为已确认计费。`ToolService.state().usage` 提供 run 内尝试、在途、已派发次数及 Host 工作单位成本；数值不会触发停机。

保留的容量与资源边界：

| 参数 | 本地默认值 | 作用 |
| --- | --- | --- |
| `--context-window` | DeepSeek 1,000,000；Pi 模型目录值 | 模型单次请求的上下文窗口 W；Pi 覆盖值不能超出目录容量 |
| `--max-output-tokens` | DeepSeek 4096；Pi `min(4096, 目录输出上限)` | 单次输出预留 O，映射到所选协议的输出限制；Pi 实际请求不超过该预留 |
| `--max-request-bytes` | 4 MiB | 单次序列化请求材料的内存/传输边界 |
| `deepseek-model.timeoutMs` / `pi-model.timeoutMs` | 120,000 | 单次模型请求和流读取 deadline |
| 工具/PTC 的并发、队列、输出及 deadline | 见工具文档 | 单次操作与隔离资源限制 |

发送请求前检查 `promptTokens + outputTokens <= contextWindow`。累计已用 tokens 不参与这个计算。压缩后仍装不下当前输入或不可拆分材料时，返回 `CONTEXT_CAPACITY`；字节超限返回 `REQUEST_BYTES`。单次输出被截断时返回 `MODEL_OUTPUT_LIMIT`，不执行该响应里的工具建议。

`weighted-json-v1` 对消息、工具 schema 按字符密度估算，加协议开销和 20% 余量；不是精确 tokenizer。匹配模型定义 hash 和请求 header（工具、输出参数等）时，最近普通请求的 provider prompt usage 可作为 anchor：`anchor prompt usage + 当前输入估算 - anchor 输入估算`。只采纳不低于本地估算的 anchor，避免低报压低基线。anchor 可跨 run 和重启恢复，模型、工具或参数变化则回退本地估算；摘要请求不充当普通请求的 anchor。

`model.requested.budget` 保留兼容字段名，但 `remainingTokens: null` 表示没有累计额度；另记录 `contextWindow`、`promptTokens`、`outputTokens`、`requestBytes`、`anchorCallId`、估算器版本。诊断不附加到实际发送给 provider 的请求体。

## 自动上下文压缩

默认 `context-compaction.auto = true`，CLI 可用 `--no-auto-compact` 关闭。配置经 schema 校验并固定到 run。策略默认：触发阈值 `floor(min(W × 0.8, W - O - 4096))`，近期尾部目标 `floor((W - O) × 0.16)`，单次摘要最多 2048 output tokens（同时受模型输出上限约束），每次压缩最多尝试 2 次。余量和比例均可由 `context-compaction` 配置修改，小窗口须同步减少 headroom。

每个普通模型请求前：测量 → 达到阈值则裁剪工具长文本 → 重测 → 必要时生成历史摘要 → 校验缩小 → fsync 提交替换 → 重测。工具字符串默认超过 8192 字符才裁剪，保留前 4096、后 1024 字符和明确标记；结构、状态、数字及短标识保留。配方 `context.tool-pruned` 进入日志并递增 Surface generation，原始有界审计证据保持不变。

摘要选择连续的完整消息组，保留最新用户输入、独立约束/受保护信息和近期尾部，不拆工具调用/结果。摘要请求无工具 bindings，单独记录 `purpose: compaction` 和实际摘要 prompt 定义；其响应不是普通 assistant 节点。仅接受正常结束、无工具调用、非空且比所选材料更短的摘要。请求期间 Surface/约束改变，或提交前有并发日志变更，则拒绝旧候选。替换和完成事件在一个事务提交，CLI 随后显示 `[上下文摘要已提交]`。

失败/变大的摘要保留旧历史；取消优先停止，持久提交失败不可冒充成功。`context.measured` 和 `context.compaction` 记录压力、来源范围、generation 与尝试结果。摘要仅改变模型可见内容，不删除审计日志、不扣减已发生 usage。初版用本地估算验证长度，不能自动证明摘要语义完整。

仅 provider 在开始流式输出前明确拒绝上下文超限（400/413 的明确代码/消息）时，允许进行压缩恢复。必须已有持久提交的新 generation 且输入估算实际减小，才重试变更后的请求；默认最多 1 次，可配置 `maxOverflowRetries` 为 0 关闭。普通 HTTP 错误、超时、部分流失败和工具副作用不走这条重试路径；不会重跑整段工具程序。

DeepSeek endpoint/model/thinking/限制、Pi provider/model/reasoning/限制，以及 Agent Loop 和工具管线限制支持 Runtime L1 更新，下一次 run 生效；工作区和 read-only 策略通过 L2 插件替换。CLI 参数在进程启动时设置；已注册插件的配置可通过配置文件与 `/reload` 更新。

## 验证

Pi 回归使用本地模拟 API 和假密钥，覆盖 Chat Completions、OpenAI Responses、Anthropic Messages、Google Generative AI 的工具往返与协议续传；CLI 测试覆盖离线目录、参数拒绝、Pi 配置热更新和无密钥重放。评测 CLI 的本地 Google fixture 实际执行读取工具，检查厂商/模型、配置 hash 和日志中无密钥。上述验证不调用外部付费服务，也不构成这些模型的真实质量评测。

`npm test` 包含 SDK 对本地 HTTP/SSE fixture 的集成测试、Agent Loop 多工具与审批写入、错误/取消/上下文容量与压缩、文件冲突、进程清理、Session 重开及 CLI 子进程测试。会话管理测试覆盖历史选择、跨会话隔离、前缀恢复、锁冲突、损坏日志、只读查询和命令不进入模型。fixture 使用假密钥，不访问真实 DeepSeek。通用 sandbox 新增工作区过滤与配额、命令/PTC 共用、取消传播、失败清理、L2 drain 和 CLI 选项测试。设置 `MINICAH_SANDBOX_IMAGE` 启用真实共享底座回归，`MINICAH_PTC_IMAGE` 启用兼容 PTC 回归；macOS 用 `MINICAH_NATIVE_TEST=1` 启用真实原生回归，三者可组合。原生共享底座集成和临时副本内对本项目执行 `tsc --noEmit` 已通过，源工作区未被回写。具体见 [Tool Pipeline 与 PTC](tool-pipeline.md)。生产模型的可达性、账户余额和真实生成质量需要配置本地密钥后另行验证。

模型流结束后工具身份不完整时返回 `MODEL_PROTOCOL`，不派发该调用；空/null 续片不能擦除已经收到的身份。对应最小回归见金种子 H1-03，重复非空身份与所有多调用交错情况不由该种子证明。
