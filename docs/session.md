# Session 是权威记录，Context 是投影

持久化实现在 `src/session/`，由普通 Session 作用域插件接入，内核不依赖事件存储。`Runtime.openSession(id)` 中的 id 是持久 Session 标识；相同目录和 id 会恢复同一份日志。自动生成的 Session id 和所有 runId 使用 UUID，避免重启后误用旧标识。

## 提交协议

文件日志采用 UTF-8 JSONL。一行包含一个事务的全部事件、起始序号、Session id、格式版本和 SHA-256 校验。单个 `record([...])` 先整体验证状态转换，再排队写入一行；一项验证失败时整批不写入。单 Session 的写入按调用顺序串行执行。

提交过程为：校验并构建候选状态 → 写完整事务及换行符 → 达到指定同步级别 → 发布内存状态 → 通知订阅者。UI 观察者抛错不会把已提交的事务变成失败；直接使用 `SessionLog` 的宿主可以通过 `drainObserverErrors()` 取出观察者错误。

| 级别/API | 完成含义 |
| --- | --- |
| `record(events, "flush")` | 全部字节已通过 `FileHandle.writeFile` 交给操作系统；可被文件读取，但断电或系统崩溃仍可能丢失 |
| `record(events, "fsync")` | 上述写入后，`FileHandle.sync()` 成功返回；默认级别 |
| `flush("flush")` | 等待此前排队提交结束，报告 `flushedThrough` 与 `syncedThrough`；没有隐含 fsync |
| `flush("fsync")` | 等待此前提交并同步文件，推进 `syncedThrough` |
| `close()` | 等待在途受管理工具及提交，然后关闭文件并释放锁；不会把旧的 flush 回执改称 fsync |

首次打开文件会同步文件和其父目录；恢复时也对实际读到的完整前缀进行同步，建立新的同步水位。`fsync` 的保证以 Node、操作系统、文件系统和存储设备的实现为准，不能等同于跨机器复制或任意故障下绝不丢失。需要稳定目录名的场景，应由宿主先准备已持久化的日志目录；本实现不递归同步新建目录的所有祖先。

返回的 `CommitReceipt` 含 `fromSeq`、`toSeq`、`durability`。flush 级别的终态通知表示该终态已经完成 flush 提交，不能显示成“已稳定落盘”。写入或同步失败可能发生在字节已完整写入之后，日志会停止后续提交，调用者必须关闭并重开以确认结果，不能凭一次 Promise 拒绝就认定事务不存在。

## 事件与版本

每个 `SessionEvent` 包含 `schemaVersion`、`sessionId`、`seq`、`timestamp`、`runId`、`callId`、`parentCallId`、`versions`、`tool`、`configHash`、`data`。不适用的关联标识为 null。序号从 1 连续递增；callId 在 Session 内唯一，结果自动沿用调用的 parentCallId。

| 事件 | 记录内容 |
| --- | --- |
| `definition.recorded` | model/prompt/tool/plugin 的 id、版本、内容 hash 和实际定义内容；属于 Session，不属于某个 run |
| `configuration.recorded` | Runtime 配置版本 id、序号、hash、实际配置值及变更层级 |
| `run.started` | 精确版本清单及实际配置；由 Session 插件绑定时，另记录配置版本、插件 generation 和工具 schema 清单 |
| `user.input` | 原始用户输入 |
| `model.requested` | 实际送往模型的完整 JSON 请求材料；附模型/prompt/工具/plugin 版本引用 |
| `model.completed` | 原始结构化响应与供展示使用的最终文本 |
| `model.failed` | 模型请求失败或取消的结构化原因，关闭本地请求记录，不表示远端未产生计费 |
| `tool.planned` | 结构化参数、工具版本、读/幂等写/非幂等写分类、可选幂等键 |
| `permission.decided` | allow/deny 及理由；用户审批附完整 approval 绑定，校验调用、参数 hash、到期时间和可用的工具 generation |
| `tool.started` | 已提交执行意图，外部操作可能开始；不代表操作完成 |
| `tool.completed` | 已知结果、success/error、确认方式及可选证据 |
| `tool.uncertain` | 调用中断或抛错，外部操作可能已经生效 |
| `tool.not-executed` | 外部状态查询等证据确认操作没有执行；重新执行前需要新的允许决定 |
| `tool.cancelled` | 取消尚未开始的调用，形成终态结算记录 |
| `budget.exited` | 兼容旧日志的预算退出；当前内置 Agent/工具管线不再因累计用量产生此事件 |
| `task.status` | 任务 id、当前状态及说明 |
| `protected.recorded` | 任务约束或受保护信息；同一 id 不允许覆盖 |
| `summary.recorded` | 摘要 id、版本、文本及历史覆盖范围 |
| `surface.replaced` | 局部摘要 id/版本、替换范围/来源；可附 expectedSurface 与 expectedThroughSeq 校验候选未过期 |
| `context.tool-pruned` | 已完成工具结果的版本化裁剪配方，只改变模型投影 |
| `context.measured` | 输入压力、窗口/输出预留、阈值、节点成本、anchor、generation；可附溢出重试决定 |
| `context.compaction` | started/completed/failed、触发原因、来源节点、摘要调用或失败代码 |
| `run.finished` | completed/failed/cancelled/budget-exited；成功 run 不得遗留未结算调用 |

`definition(kind, id, version, content)` 构造带内容 hash 的定义，`reference(definition)` 取得引用。定义必须先记录，同一 kind/id/version 不能对应不同内容。hash 使用键排序后的 JSON 计算；不接受 undefined、循环对象、非有限数值等不能可靠写入 JSON 的材料。

`reconstructRequest(callId)` 返回当时的请求材料、实际配置及全部引用定义的内容。替换模型 Provider 后，旧请求仍绑定旧定义。该方法只重建输入，不发送请求；也不承诺模型输出可完全复现。适配器应记录实际发送的消息、prompt、工具 schema 和生成参数，而不是仅记录模板名或散列。模型/插件定义内容也应包含所需的协议、实现说明或实际源内容，不能拿一个无法取得的路径冒充已保留的定义。首版直接内联保留 JSON 内容，不依赖外部 blob 存储。

由内置 Session 插件启动 run 时，`configuration.recorded` 和带 `manifest` 的 `run.started` 在同一事务提交；请求重建也返回该 manifest。Runtime 的配置历史本身是内存管理记录，实际用于 run 的版本通过此事务持久化，不把未提交的管理事件说成已落盘。旧日志允许缺省 manifest，新日志不会凭当前 Provider 补造旧 generation。

服务隔离扩展在 manifest 中记录 `services` 与 `bindings`，以及插件 `definitionId`。插件 `id` 在 manifest 中表示挂载实例；绑定通过隔离 id 指向实际 owner/generation。内存 Symbol 不进入日志，重放验证绑定关系但不重新装配或执行 Provider；旧 manifest 可同时省略 services/bindings。详见 [服务隔离与插件多实例](service-isolation.md)。

## UI 临时流

`subscribeCommitted()` 与 `subscribeDeltas()` 是两个独立通道。`publishDelta({ callId, channel, text })` 只接受已经记录、尚未完成的模型/工具调用，不改变事件序号，不写日志，不进行 fsync。最终输出用 `model.completed` / `tool.completed` 提交；可以将输出与 `run.finished` 合并为一个事务。

恢复不会重新发布旧的提交通知。UI 从 `events()` 或 `state()` 重建展示，避免把历史完成事件当成新操作。临时 delta 丢失不会伪装成已持久化输出。

## 外部操作与恢复

```ts
await session.record([
  { callId, data: { type: "tool.planned", tool: toolRef, input, effect: "non-idempotent-write", idempotencyKey } },
  { callId, data: { type: "permission.decided", decision: "allow", reason: "Policy approved" } },
]);

await session.executeTool(callId, async ({ input, idempotencyKey }) => {
  // 将这里收到的 key 真正传给支持该协议的外部系统。
  const result = await adapter.execute(input, idempotencyKey);
  return { outcome: "success", result };
});
```

`executeTool()` 无论 Session 默认级别为何，都先以 fsync 提交 `tool.started`，然后才调用适配器。成功获得已知结果后再提交 `tool.completed`。异常可能发生在远端已经生效之后，所以抛错会记录为不确定，而不是虚构一个“未执行”的失败结果。明确获得失败响应且能确认执行结果的适配器，可返回 `{ outcome: "error", result }`。

| 恢复状态 | 证据 | 建议动作 |
| --- | --- | --- |
| `confirmed-complete` | 已有结果或未开始调用的取消记录 | 仅展示，不重做 |
| `not-started` | 已计划，但没有开始记录；或有未执行证据 | 按当前权限明确启动 |
| `uncertain` | 有开始/请求记录，尚无结果确认 | 查询外部状态或人工确认；不自动重试非幂等写入 |

`recovery()` 只返回分类和建议，绝不执行工具或模型。即使声明为读操作/幂等写，`retry-safe` 也只是建议，不会触发执行。非幂等写带有 key 时返回 `reconcile-with-key`；存下 key 不等于远端支持幂等，必须由适配器落实。

有外部证据时，可以显式记录 `tool.completed`，使用 `confirmation: "status-query"` 或 `"idempotency-key"` 并附 `evidence`。确认没有执行则记录 `tool.not-executed`，其权限重置为未决定。不确定的原调用不能直接再次传入 `executeTool()`。已关闭 run 允许补录结果确认；若确认未执行，应取消旧调用并在新 run 中重新计划，或在仍运行的原 run 内重新取得权限。

本地事务与外部操作之间没有分布式原子事务。执行意图已提交但进程尚未发起请求，恢复时也会保守地归为不确定；外部成功但本地结果提交失败，同样归为不确定。日志重放本身只运行纯状态转换，不持有任何执行器。

## 压缩规则

`projectContext(sessionId, events)` 仅接收已提交事件，返回带 `throughSeq` 的不可变投影：前缀摘要、约束、受保护信息、最新任务状态、未结算调用、前缀摘要之后的结构化历史，以及 `surface`。离线入口完整校验重放；`ContextService.build()` 复用 Session 已提交的 reducer 状态，同一日志尾部返回同一不可变快照，不在每次模型请求前重放全部版本定义。

原有 `summary.recorded` 仍支持连续前缀 `{ from: 1, to: N }`，旧日志无需改写。覆盖范围不得超出已有事件、不得回退，同一摘要 id/version 不可复用。任何已开始落入覆盖范围的调用都必须存在覆盖范围内的终态记录，包括尚未启动的工具计划和待响应的模型请求。即使调用现在已完成，也不能把覆盖边界切在调用与结果之间。模型响应可声明 `childCallIds`；这些子调用的结果或管线拒绝事件也必须完整落入覆盖范围，避免隐藏“模型响应已提交、工具尚未规划”的间隙。

`surface.nodes` 是按模型可见顺序排列的事件序号，`surface.events` 是对应的不可变事件。用户输入和普通模型响应自动追加节点；`purpose: compaction` 的摘要响应只作为审计记录；每个模型节点连同其工具结果构成一个不可拆分的消息组。结果通过 `childCallIds` 和 Agent 响应中的 provider/Host ID 映射关联，模型侧按原调用顺序排列，因此工具并发完成的先后不改变消息配对。审计事件、权限、预算和 UI 临时 delta 不成为模型节点；约束和受保护信息单独保留。

局部压缩由插件显式提交普通事件：

```ts
await session.record([{ data: {
  type: "surface.replaced",
  id: "inspection-summary", version: "1", text: "已检查的文件和结论……",
  surfaceOp: { op: "replace", startSeq, endSeq },
  sourceEventSeqs: replacedNodeSeqs,
} }], "fsync");
```

起止节点必须存在于当前 Surface 且顺序正确，范围按当前索引位置解释，不按日志数字区间解释；来源必须恰好列出每个被替换节点，不能重复或遗漏。替换可以覆盖先前摘要。待规划、待审批、执行中或结果不确定的模型子调用不能被隐藏，选中历史区间中的其他未结算调用同样阻止替换。首版不允许只替换单个 tool result；必须连同整个模型工具批次替换。前缀摘要不得切入已有局部替换的来源范围，应覆盖该替换事件后再提交。

Surface 与调用状态一起在事务候选中校验，持久提交成功后才发布新索引；校验失败整批撤销，提交确认丢失时旧视图保持不变并要求重开恢复。每次摘要替换和已提交的工具结果裁剪递增 `surface.generation`。UI 重放仍读取原始日志，局部压缩不让已经展示的对话消失。新事件是日志协议的扩展：新版能读取旧日志，旧程序不支持含新增 context 事件的日志。

摘要不会物理删除历史。投影始终单独保留任务约束、受保护信息和最新任务状态，即使摘要文本没有提及它们。约束内容不交由摘要自动裁决是否过时；修改规则需要宿主定义显式事件演进方案。

## 文件恢复与首版边界

- `SessionCatalogService` 为 CLI 提供历史列表与读取。查询只读取文件打开时大小以内的完整事务前缀，校验 checksum、序号和状态转换；不取得写锁、不 fsync、不修复末尾残片，也不激活 Session 或执行器。读取到完整行只说明字节可见，不能据此推断其他写者已完成 fsync。恢复写入仍通过正常 Session 打开流程取得锁并校验。
- 列表从事件推导标题和状态，仅接受与 Session ID 对应的文件名及匹配的工作区；损坏或不匹配文件计入不可用数量，符号链接不作为会话读取。尚无事件的空文件不包含可恢复的 Session ID，因此不进入冷历史列表。目录查询暂时逐份载入并重放日志，没有独立索引或分页存储。
- 每个日志使用排他 `.lock` 文件防止重复写者。正常关闭会释放；崩溃留下的锁不会被自动抢占。宿主需读取锁中的 pid，确认原写者已经停止，再显式移除该锁文件并重开。不要在写者仍存活时移除锁，也不要通过硬链接别名或不支持排他创建语义的共享文件系统绕过单写者约定。
- 打开时校验全部完整事务的 checksum、连续序号、版本内容和状态转换。只有最后一个没有换行提交标记的残留片段会被截去，并通过 `discardedTailBytes` 报告；完整行损坏会拒绝打开，不跳过损坏记录。恢复是同步提交协议的实现，不是电源故障模拟器；测试通过注入 I/O 边界故障验证逻辑。
- Session 日志插件在打开期间持有写锁。默认 `drained` 边界下，同目录候选激活会因重复写者而回滚。宿主可先关闭 Session 再替换，或显式给插件声明 `replacementBoundary: "stop-first"`，先释放旧锁再打开日志；后一方式失败不承诺无损回退。模型、Context 等其他 Provider 不受此文件资源约束影响。
- 会话日志整体载入内存，启动时重放校验，运行时随提交增量维护 Surface；快照复制和替换仍可能随历史长度增长。尚未实现磁盘索引、分页、日志裁剪或任意数据迁移。摘要减少模型 Context 展示，不缩减磁盘日志。
- `retain()`、`start()`、`record()` 和 `executeTool()` 都由能力插件显式调用。内核不会拦截任意外部请求，适配器必须遵守先记录意图、等待提交再执行的协议。

示例见 [examples/demo.ts](../examples/demo.ts)，测试位于 `test/session-*.test.ts`。

## Tool Pipeline / PTC 扩展

第 5 节加入 `pipeline.rejected`、`ptc.started`、`ptc.completed`、`ptc.uncertain`；PTC 是带子调用的独立 call 类型。PTC 终态同样在提交后通知，未知父/子调用不能被摘要覆盖。子调用复用工具状态机，不因程序获准运行而继承工具权限。

工具计划可附原参数 `inputHash`，实际审计输入则已脱敏或截断。审批绑定与该原始 hash 对齐；hash 不恢复内容。若未结算调用的原始参数已不可用，恢复动作是 `restore-input`，`executeTool()` 拒绝用脱敏输入重试。详细事件、隔离与取消边界见 [Tool Pipeline 与 PTC](tool-pipeline.md)。

自动压缩策略由 `createCompactionPlugin()` 实现；Session/Context v4 暴露 `toolPrunings`，重放同一配方可恢复模型投影。策略与计量细节见 [Coding Agent](coding-agent.md#自动上下文压缩)。原始 `model.requested` 保留实际请求、可空的累计剩余额度及摘要 prompt 引用；请求重建同时返回引用内容。
