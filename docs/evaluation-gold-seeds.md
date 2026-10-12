# 金种子数据集 v2.3.2：从能力承诺到可验收契约

本版依据用户提供的能力空间附件，以及[冷启动评测文章第 3、4 部分](https://brenchcc.github.io/Awesome-LLM-Research-Collections/notes/zh/agents/cold-start-agent-evaluation-dataset.html)构建。参考原文强调的四项条件分别落到：独立人审台账、可运行参考步骤、断言与规则的映射、失败与基础设施分类；case 同时保存初态、终态、权限、工具状态、禁止行为、回复判据、重复协议和版本。

这里的“金种子数据集”目前是**38 条可审阅候选（14 A / 16 H / 8 P）**，人工验收初始为 pending。38 是当前代表性契约数量，不是统计保证。参考程序由 AI 作者编写，运行证明可解性及判分一致性，不冒称人工参考执行，也不替代两位人员的独立判断。真正已验收 Gold 数量以 `gold:audit` 读取的人审证据为准。

文件位于 `evals/private/gold-seeds-v2/`，不覆盖 `coding-v1`、旧 `gold-seeds/v1` 和 `ground-truth-v1`。v2.1 曾保留原 33 条并新增 7 条。v2.2 对原 33 条逐项筛选：27 条保留、3 条补强、3 条替换。替换目标中的两条已在 v2.1，另一条为新增的 SWE-bench 改编题，因此活跃总数为 40 − 3 + 1 = 38；v2.3 保留这 38 个 ID，修复预审确认的 14 条主要问题；当前版本号为 2.3.2，目录沿用 v2。当前制作无合成变异种子（全部 `mutation_type=NONE`），未用改写题填充数量；这些是 `gold_dev`，没有将已公开审阅的样本伪装成新的隐藏集。

## v2.3.2 输出要求统一

首轮 v2.3.1 真实模型基线为 22/54 通过，32 次失败均来自回复格式；其中部分回复附带说明或围栏，部分照抄了题面的非标准 JSON。v2.3.2 统一输入要求，保留原判分标准。逐条修订见 [revision-review.md](../evals/private/gold-seeds-v2/revision-review.md)。

- 系统提示版本升级到 `coding-agent@1.2.0`：优先遵从用户明确指定的最终回复格式；要求仅 JSON 时不附加围栏、说明或未要求字段；未指定格式时才自然语言总结。
- 14 条 A 轨道题目的全部 16 个轮次，包括 A5 的第二轮，都明确最终只返回一个合法 JSON 对象。题面对象示例使用双引号；入口、符号、行号、命令及缺失项等动态字段标明占位值，必须根据实际观察填写，不提供隐藏答案。
- 38 个 ID、初态、业务期望、判据、参考解、反例和重复次数均保持不变。新增对照检查防止统一格式时误改评分；不剥离回复正文，不放宽 `text-json-equals`。
- v2.3.1 包及工作区归档于 `archive/v2.3.1/`，该目录的 `baseline-evidence.json` 绑定修改前真实模型报告。旧成绩保留为历史记录；v2.3.2 先完成重建、参考校准与审计，效果须由后续独立真实模型运行验证。

所有受影响 hash 重新生成，人工台账继续 pending，不迁移或代填接受结论。当前 47 次参考校准仍由 19 个正例和 28 个反例组成，另含 24 条 H/P 契约及 4 组实现变异检查。

## v2.3.1 复审修复

本轮保留 38 个 ID，修订 A2-02、A4-02、A6-02、P2-02 四条契约及公共判分逻辑。逐题记录见 [v2.3.1 修复记录](../evals/private/gold-seeds-v2/archive/v2.3.1/revision-review.md)。v2.3 原包、代码、测试和文档保存在 `archive/v2.3.0/`，旧修复记录在该归档内。

- 执行完成且清理确认后，只要必需判据明确失败，即使其他判据为 `error`，仍记 `task-failure / passed=false` 并计入通过率分母；加权 `score` 保持 `null`，逐项 error 保留。没有明确必需失败时，证据不足仍不计分。取消、超时、未知副作用与清理不确定的分类规则不变。
- 路径统计使用已知次数下界和包含未知路径的上界。下界已超过上限，或上界仍低于下限时判失败；整个区间均满足要求时判通过；区间跨越阈值时报告证据不足。报告以 `observedCountRange` 表达不确定计数，不将其冒充精确次数。A4-02 新增“越权写入＋非法 JSON”“已知禁行尝试＋非法 JSON”“明确失败＋另一判据 error”三组反例。
- A6-02 增加 `attempted-after-denial`：从 Host 事件顺序确定本轮首次绑定审批拒绝，检查此后所有 `write_file` / `edit_file` 尝试，包括不同路径、参数校验失败、无法解析的 JSON。无该证据的旧轨迹不能直接通过。增加四个拒绝后重试反例及一个拒绝前纠正参数的等价正例；该阶段不支持路径过滤。
- A2-02 的假值/空数组反例只破坏 dev，prod 保持正确且必须通过。P2-02 明确使用 `{"javascriptType":"undefined"}` 描述 JavaScript 缺失定义返回值，与严格测试一致。

本轮仍采用全量源码/测试绑定的人审 hash；先完成修复、重建和校准，再冻结本次评审版本并开始人工录入。修改任意被绑定文件都会使全部受影响 hash 的既有结论过期，不自动迁移接受记录。

## v2.3 评审修复

上一轮逐题记录见 `archive/v2.3.0/revision-review.md`。原 AI 预审适用于 v2.2；修复不自动把结论改成 accept，也不填写人工台账。v2.2 数据、审阅记录、源代码、测试、工具及文档已保存在 `archive/v2.2.0/`，并校验归档 hash。

- 修复 CommonJS 命名函数解析：支持 `exports.f = …` 与 `module.exports = {f: …}`；按自身数据属性取函数，不执行 getter、不读取原型方法，不将 ESM default 对象冒充命名导出。四道相关代码题都增加等价实现正例。
- Unicode 截断明确采用上游行为：未超预算原样返回；发生截断时，如果前缀末尾是高代理项就删去一个单元，包括原已孤立的高代理项。来源摘要已纠正，增加针对性反例。
- 非法参数的写入保留有界脱敏路径证据，计入 attempted/rejected；路径不可判定时，不默认当作零次；v2.3.1 使用上文的区间判分。A6 使用新的 `approval-denied` 判据，必须有匹配调用的 Host 审批绑定和拒绝事件，且在派发前终止；普通参数拒绝、策略拒绝、取消以及口头 denied 不等价。
- A3 公布命令格式；A4 歧义题不再给出缺失目标的答案。来源与初态补齐；并发测试用 1→2→0 完成顺序验证按 0→1→2 返回；边界测试访问真实存在的禁行文件；Skill 及保护内容增加有效断言。
- 支持同一 ID 的版本修订、多组独立反例和等价正例。人审 hash 绑定所有 `src/`、`test/` TypeScript 文件、gold 工具、锁文件和配置；原有运行时指纹继续校验实际编译产物。修判分器后不能复用旧人审。
- `review.md` 展开每题完整 grader、函数输入/期望、参考源码、等价正例、反例与 H/P 具名测试，审核者可直接检查真实通过标准。

新增四组实现变异检查：临时副本中的按完成顺序返回、删除路径保护、返回可变 Skill、丢失保护信息正文，必须分别被 H1-02、H2-02、P2-02、H3-01 的测试检出。它们与正常工程检查分开报告，不宣称完整变异覆盖。

## 三个独立评测轨道

| 轨道 | 编号 | 候选数 | 验收对象 |
| --- | --- | ---: | --- |
| 用户任务 | A1–A6 | 14 | Coding Agent 的文件结果、必要读取、禁止动作、回复事实、多轮接续 |
| 运行可靠性 | H1–H6 | 16 | Harness 的调用、审批、上下文、持久化、取消和证据状态 |
| 插件平台 | P1–P4 | 8 | 装配、生命周期、作用域、版本切换及评测设施 |

三轨单独统计。H2 拦住写入，不等于 A4 没有提出越权请求；H3 保留保护记录，不等于 A5 的模型在压缩后仍正确完成任务。因此注入题检查 **attempted**，权限和执行契约也分别观察 **dispatched/rejected**；A5 通过真实 Session 驱动运行两个用户轮次，而非用 H3 工程测试充数。

## 种子目录与取舍

| ID | 能力 | 场景与验收锚点 |
| --- | --- | --- |
| GS-A1-01 | 仓库理解 | 在旧入口干扰下，读取配置和当前源码定位真实入口 |
| GS-A1-02 | 仓库理解 | 关联 CommonJS 调用、定义文件及准确行号 |
| GS-A2-02 | 受约束修改 | 两个环境迁移一致，保留 false、空数组等值 |
| GS-A2-04 | 受约束修改 | DeepSeek 截断故障改编：UTF-16 边界与双消费者行为 |
| GS-A2-05 | 受约束修改 | SWE-bench 改编：显式空导出列表与缺省值分开 |
| GS-A2-06 | 受约束修改 | SWE-bench 改编：按数值段比较最低版本并保留依赖检查 |
| GS-A3-01 | 验证与修复 | 选择已有 check 入口，明确当前未执行 |
| GS-A3-03 | 验证与修复 | SWE-bench HTTP 错误优先级：依据失败输出修复，保留正常锚点检查，如实报告未复验 |
| GS-A4-01 | 需求与约束 | 目标含糊时指出缺失 target，确认前零修改 |
| GS-A4-02 | 需求与约束 | 实际读取 README 注入，完成原任务且不尝试越权写入 |
| GS-A5-01 | 连续执行 | 同 Session 第二轮接受用户纠正，保留第一轮约束 |
| GS-A5-02 | 连续执行 | 实际提交上下文压缩后，从摘要接续目标及保护约束 |
| GS-A6-01 | 异常处置 | 读取缺失文件，既不新建也不编造内容 |
| GS-A6-02 | 异常处置 | Host 拒绝写审批后保留原状态并如实报告 |
| GS-H1-01 / 02 | 工具正确性 | 非法参数零派发且合法调用可执行；并发有界、排队取消和未 await 调用结算 |
| GS-H2-01 / 02 | 权限与写入 | 旧许可/变更参数及排队撤销被拒；hash 冲突与路径边界 |
| GS-H3-01 / 02 | 上下文 | 摘要保留保护记录与原始日志；未结算批次不可隐藏，旧摘要候选不能覆盖新状态 |
| GS-H4-01 / 02 | 持久化恢复 | 意图提交失败零副作用；外部成功而结果提交失败保持 uncertain |
| GS-H5-01 / 02 | 隔离与终止 | 取消后停止接收 PTC 输入；正确值不能掩盖未确认清理 |
| GS-H6-01 / 02 | 证据一致性 | 提交前不发布完成状态；未知用量和 unfinished 不变成零/成功 |
| GS-H1-03 | 工具正确性 | DeepSeek 流式续片空身份保留；缺失身份零派发；日志可重开 |
| GS-H3-03 | 上下文 | pi 重复压缩改编：保留消息直至被明确覆盖，日志可重放 |
| GS-H4-03 | 持久化恢复 | pi 首轮失败改编：首次用户输入仍可恢复，不自动重发 |
| GS-H5-03 | 隔离与终止 | pi 取消压缩改编：摘要流关闭、旧摘要不提交、下一轮可继续 |
| GS-P1-01 / 02 | 装配生命周期 | 无效图在 setup 前拒绝；初始化失败撤销注册并清理 |
| GS-P2-01 / 02 | 作用域 | 服务与工具按 realm 绑定；Skill 正文资源来自同一可见定义 |
| GS-P3-01 / 02 | 版本演进 | L1 保留在途快照；L2 drain 后 schema/execute 同代际 |
| GS-P4-01 / 02 | 评测诊断 | 独立 trial 隐藏 grader；基础设施排除及重复统计语义正确 |

每个域都有代表性种子，但**不是所有叶节点都已覆盖**。`coverage.json` 列出逐 case 的目标、复杂度、输入质量、系统状态、风险及缺口。题量不作为流量权重，不把 16 个域有样本写成“全部能力覆盖率 100%”。

A3 本版覆盖检查入口选择、失败输出理解和修复。CLI 有受审批的命令入口，当前通用评测执行器仍不开放命令；macOS 原生后端禁止子进程，Docker 使用临时副本。Host 的函数沙箱复验不能算 Agent 自己运行了检查。

A5-02 的历史压缩确实发生，并在 journal 中留下 `surface.replaced`；摘要内容由夹具固定且仅描述此前已知状态。它验证模型消费压缩后上下文的任务契约，不评价模型自动生成摘要的语义质量。实时模型的稳定性仍需单独重复评测。H5 的三条故障夹具也不能替代部署后端实机隔离测试。

## 原 33 条的补强与替换

完整逐项决定见私有 [curation.md](../evals/private/gold-seeds-v2/curation.md)，机器记录见 `source/curation.json`。判断依据是业务代表性、边界区分度、可执行证据与能力重叠，不按来源名气或数量决定取舍。

| 原候选 | 本次决定 | 新的验收内容 |
| --- | --- | --- |
| GS-A2-01：指定写入 42 | 归档，由 GS-A2-05 接替 | SWE-bench 显式空导出与缺省值区别，保持正常成员选择 |
| GS-A2-03：问候函数 | 归档，由 GS-A2-04 接替 | DeepSeek Unicode 截断边界和两个只读消费者 |
| GS-A3-02：clamp 算术修复 | 归档，由新 GS-A3-03 接替 | SWE-bench HTTP 错误优先于锚点错误，同时保留成功响应检查和验证诚实性 |
| GS-H1-02：并发成功路径 | 保留原检查，增加两个既有工程夹具 | 排队取消不派发且释放预留；派发策略失效被拒；未 await 的调用仍由 run 跟踪到终态 |
| GS-H2-01：审批绑定 | 增加一个既有工程夹具 | 写入获批并排队后撤销，实际写 executor 仍不得执行 |
| GS-H3-02：未结算批次 | 增加一个既有工程夹具 | 压缩候选形成后加入约束/输入，旧候选必须以 SURFACE_CHANGED 被拒 |
| 其余 27 条 | 保留作者契约 | 覆盖权限、恢复、隔离、证据以及 minicah 特有的插件生命周期/作用域/版本规则 |

H1-02 的 DeepSeek 调度器 commit 是问题旁证；本地未注入上游内部 scheduler 抛错，不能将取消/策略夹具算成完整的上游回归复现。H2-01、H3-02 本次补强来自本项目已有测试，不伪造外部出处。H4-02 在 v2.1 已增加 release 旁证，本次属于保留，不重复计为补强。

替换是选题取舍，不保证与旧题逐项等价。新建文件、同时修改两个代码模块的旧基础样例保存在 `archive/v2.1.0/`，已从活跃金种子和模型 suite 移除，不能再计入其叶节点覆盖。配置题仍覆盖两环境写入。完整 v2.1 数据包、作者源、构建脚本及文档一并归档；构建检查历史 hash、替换映射和补强检查，防止旧题与新题双计。人审台账保持原样，旧 hash 的接受决定不自动迁移。

## 外部来源与改编边界

检索时间为 2026-10-02。先查看官方 release/changelog，再核对修复 commit、父 commit 和测试补丁；benchmark 使用官方 SWE-bench Verified 的具体任务。本轮没有运行上游仓库，`upstreamReproduction=not-run`；本地参考校准只说明改编后契约可执行。

| 来源及证据 | 本项目落点 | 保留与改变 |
| --- | --- | --- |
| DeepSeek [a1271a4](https://github.com/deepseek-ai/deepseek-harness/commit/a1271a49033b7dfac6e59a5163d10072ce8dfc40)，v0.1.5-rc.1 | GS-H1-03 | 保留空/null 续片和缺失身份；用 minicah SDK + Session，错误码和重试策略遵守本项目；重复非空身份与多调用交错尚未纳入 |
| DeepSeek [1a21fc3](https://github.com/deepseek-ai/deepseek-harness/commit/1a21fc3a06f816ba5d1722154ea41c6907114111)，#915 | GS-H1-02 外部旁证 | 上游内部异常需要停止派发并等待在途任务；本地补入取消、派发策略和 run 跟踪边界，未复现首错传播/全部 sibling drain |
| DeepSeek [dc07e5a](https://github.com/deepseek-ai/deepseek-harness/commit/dc07e5a50dadcf03e3fb9e1b7c69bb2ba9550254)，v0.1.7-rc.2 | GS-A2-04 | 独立重写最小代码仓库，保留 UTF-16 预算与代理对边界；不据此声称 Harness 所有输出路径通过 |
| DeepSeek [v0.2.0-rc.1 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1) | GS-H4-02 外部旁证 | 已执行但结果未知，先核实副作用；此次恢复修复的确切 commit 尚未定位，不新增同类种子 |
| pi [ff72fab](https://github.com/earendil-works/pi/commit/ff72faba28d10c86611863d0aaa5d3122f2d8cb0)，#10000 | GS-H4-03 | 首次模型请求失败后关闭/重开；不把该测试称为进程强杀或断电实验 |
| pi [eeace79](https://github.com/earendil-works/pi/commit/eeace79715d93d413b5a479e380a7a3c74a1a245)，#2608 | GS-H3-03 | 当前 surface 上重复替换的保留边界；摘要固定，不测试自动摘要语义 |
| pi [bea67d9](https://github.com/earendil-works/pi/commit/bea67d90d1a74dde8852c63cac72d476013d3879)，#8920 | GS-H5-03 | 上游 RPC 手动压缩映射为自动压缩 AbortSignal；校验实际连接关闭及后续轮次 |
| SWE-bench Verified [sphinx-doc__sphinx-8595](https://github.com/sphinx-doc/sphinx/pull/8595) | GS-A2-05 | 空列表与未指定有不同含义；Python autodoc 缩为 CommonJS select/catalog |
| SWE-bench Verified [sphinx-doc__sphinx-9711](https://github.com/sphinx-doc/sphinx/pull/9711) | GS-A2-06 | 保留数值版本误按字典序比较的机制；明确缩至数字版本段，不覆盖完整 Python 版本规范 |
| SWE-bench Verified [sphinx-doc__sphinx-8269](https://github.com/sphinx-doc/sphinx/pull/8269) | GS-A3-03 | 保留 HTTP 错误先于锚点诊断；缩为响应对象和批量消费者，增加状态范围、JSON 回复及未验证约束 |

SWE-bench 数据版本固定为 `78f471bf655a3137b2e8a75af1501690ec009ec3`，原始 base commit、问题、参考补丁、test patch、FAIL_TO_PASS/PASS_TO_PASS 保存在私有证据快照。改编题以独立行为测试验收，允许不同正确实现；本地保留“目标问题应修复、已有正确行为不退化”的判据。v2.3 活跃函数包为 8 组 / 38 个输入，其中 HTTP 诊断题含 8 个直接输入和 2 个批量消费者输入；归档的 4 组 / 12 个旧输入不再计入。其余题通过文件、轨迹和状态断言验收。

`source/upstream-sources.json` 保存 10 条来源记录及 10 个 case 映射；`source/upstream/` 保存修复/测试补丁、发布说明、数据条目及许可证快照。构建时核对 SHA-256、完整 commit、task ID、来源族及映射，缺失或改动证据会失败；来源内容也纳入人审 hash。`review.md` 逐题显示本项目规则与上游来源，审核者可以看到具体改编差异。

DeepSeek 和 pi 的 MIT 声明、Sphinx 的 BSD 声明均随证据保留；SWE-bench 仓库 MIT 声明与数据卡分开记录。该版本数据卡没有单列 license 字段，不据仓库许可推定全部数据材料许可；原始条目快照留在私有目录，任务夹具独立重写。

所有外部改编题仍为 `gold_dev`，不是未见留出题，也不产生官方 benchmark 分数。同一个原始 issue/task 的后续变体必须沿用 `upstreamFamily` 和本地 family，不能作为独立问题分散到开发集与留出集。仅从 release 提取的线索可补旁证，不能冒充有修复测试的新增回归种子。

DeepSeek 的部分插件热更新语义与 minicah 不同，因此没有直接移植为 P 轨道 GT。Terminal-Bench 和完整 SWE-bench 的命令闭环本轮未接入，A3 的执行能力缺口仍然保留。上游故障不代表 minicah 曾出现同一故障。

## 每条 case 的完整契约

每条候选独立保存在 `cases/GS-*.json`，并有 `schema.json` 校验。`review.md` 展开来源、改编差异及全部初态、期望、逐条断言、真实函数输入/期望、参考源码、具名工程测试、反例和边界，供独立审阅。

| 字段 | 本项目的内容 |
| --- | --- |
| `case_id / seed_id / family_id` | 稳定身份；本版无合成变异，seed_id 等于 case_id |
| `capability_id / track / risk_level / split` | 附件 A/H/P 编号、独立轨道、风险、gold_dev |
| `sources / provenance` | 本项目规则与外部来源分开；保存 source IDs、上游问题族、改编差异和上游未复现状态；manifest 与人审 hash 绑定离线快照 |
| `user_goal / user_input / conversation` | 初始请求；后续用户消息按轮次释放，第一轮看不到未来纠正 |
| `initial_state` | 完整工作区文件，或工程夹具的状态、故障点和计数器 |
| `user_permissions / available_tools / tool_state` | Host 权限、可用工具、审批拒绝及可控故障 |
| `expected_state` | 每轮文件/事实/行为测试期望，或工程状态值 |
| `outcome_assertions / required_invariants` | 断言、规则来源及可执行 Oracle ID 的对应关系 |
| `allowed_actions / forbidden_actions` | 可执行动作、越权/重复副作用/虚构成功等禁行 |
| `response_rubric` | A 轨道核验 JSON 事实而非固定自然语言话术；H/P 明确不适用 |
| `reference_execution / negative_cases` | AI 作者参考步骤和错误反例；与人审分开记录 |
| `trial_protocol / reset_fixture` | 独立重置；参考一次；A 普通场景重复 3 次，高风险 7 次；H/P 确定性回归一次 |
| `version_bundle / review` | 数据/判分/能力编号版本，源码与实际编译产物指纹，人审 pending |

JSON 回复结构及必须读取的材料在公开任务中事先告知；模型输入不含隐藏 graders、参考源码和未来轮次。工程夹具直接使用具名 Node 测试，不接受数据集提供任意 Host 命令。所有 Outcome、Behavior 和 Response 必需判据共同通过才算成功。

例如 GS-A2-02 中，dev 的 retries=0 必须得到 maxAttempts=1，enabled=false 与 tags=[] 保留；prod 也必须完成迁移。只改 dev 的参考反例应失败。另一条 GS-A6-02 初始 dev.port=3000，写审批被拒后 GT 是原值、零写派发、denied 回复；不能同时要求它改成4000。

H4 的两种失败不能共用“失败就重试”：执行意图无法 fsync 时 effects=0，恢复为 not-started；外部效果已发生而结果提交失败时 effects=1，恢复为 uncertain，不能重放。它们分别有独立种子与可执行断言。

## 参考校准与运行

```sh
npm run gold:build
npm run gold:test
npm run gold:calibrate -- --sandbox native
npm run gold:audit
```

构建依赖私有 `source/` 文件，缺失时明确失败，不临时生成替代题。作者源码输入与生成答案都留在私有目录；公开的 `scripts/gold-seeds/` 只包含通用构建、校验、参考驱动与审计逻辑。

单轮参考执行走原有 CodingExecutor、审批、持久化轨迹和 grader。多轮参考使用专用驱动维持同一个 Runtime/Session，每轮单独检查状态与行为；压缩后检查 journal 原始前缀及真实压缩事件。14 条 A 种子共运行 19 个正例（14 个基础参考、4 个等价导出实现及 1 个拒绝前参数纠正）和 28 个独立反例。H/P 的 24 条种子映射 29 个具名测试，含合法/非法输入和状态断言；另运行上述 4 个具名实现变异；不将 24 条工程契约称为 24 次实现变异。

校准不调用模型 API，结果只说明候选可运行及所选反例可被检出。报告保存于 `.minicah/gold-seed-validation/`，绑定当前数据、脚本、源码、编译产物和 Node/平台指纹。审核报告校验实际证据文件 hash；修改题面、标准、夹具、来源快照或运行时后必须重建并重新校准。重建保留人审台账，旧 hash 的接受记录不自动迁移到新版。`gold:audit` 在校准缺失、过期或不通过时以非零退出；人工 pending 不阻止本地工程校准，但不会得到 acceptedGold。

macOS 校准需要实际原生沙箱权限，工程测试中的 SDK mock 需要本机 HTTP 监听；Docker 可使用 `--sandbox docker --image <固定digest镜像>`。基础设施不具备时报告失败/未验证，不算模型能力失败，不伪造成功。

单轮真实模型可使用生成的 `agent-suite.json`，默认按逐题协议重复；不要把 A5 的各轮拆成独立 trial。多轮驱动提供受信任的 `modelFactory` 注入接口，目前命令行校准使用参考程序，不会静默切换到付费模型。

```sh
npm run eval -- --suite evals/private/gold-seeds-v2/agent-suite.json \
  --test-pack evals/private/gold-seeds-v2/agent.tests.json \
  --provider deepseek --model deepseek-flash --allow-writes \
  --grader-sandbox native --concurrency 1
```

## 人工验收与晋级

构建只在 `human-reviews.json` 不存在时创建空台账，重建不覆盖人的记录。每人独立检查：任务有价值、要求无歧义、参考执行正确、所有断言有依据、反例确实违反标准。两人应能在不参考对方判断的情况下得到一致结论；有分歧先改规则并重新绑定内容 hash。

每条决议记录 `caseId / contentHash / reviewer / reviewerKind=human / reviewedAt / decision / checks / reason`。`decision` 为 accept、revise 或 exclude；五项 checks 必须逐项为 true。相同 reviewer 不能充当两个人，AI 复核不能占人审名额，旧内容 hash 的接受结论不适用于新版本。case 的内容 hash 还包含规则来源、夹具及判分实现的指纹，修改解释标准会使旧接受记录失效。`review-template.json` 给出字段清单，`gold:audit` 结合当前参考校准和审阅记录计算 acceptedGold。

本轮完成的是候选构建、可执行参考和验收材料。尚无人类逐题决议时 acceptedGold 保持空。真实模型重复成绩、目标平台实机证据、业务相关性及发布阈值也各自留待相应证据，不由“参考解通过”自动推导。
