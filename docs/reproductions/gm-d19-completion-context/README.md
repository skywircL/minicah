# 跨模型复现包：GM-D19 提前回复 completed

本包导出实际请求、完整工具定义、合成文件初态和对照组输入，便于换模型复现。此次导出没有调用 API。`GM-D19` 是 timeout 从 30 改回 10 的主案例；`GM-D04` 是 port 从 4100 改为 0 的交叉验证案例。

## 最快开始

1. 将 `GM-D19/workspace-before-turn-3/` 的三个文件复制到一个独立、可丢弃的工作区。
2. 读取 [GM-D19/model-input.json](GM-D19/model-input.json)。将其中两条 system、两条 user 消息按顺序、按 role 发送，并将 `tools` 作为真正的顶层工具定义注册。把消息中的 `/workspace/gm-d19` 替换为你的实际工作区绝对路径。
3. 使用你选定的模型。原实验 thinking=false、max output tokens=4096、超时=120 秒；temperature、seed、tool_choice、response_format 均未显式设置，SDK 自动重试为 0。其他模型不支持同名参数时记录差异，不要假定供应商默认值相同。
4. 模型返回 tool_calls 时，执行对应工具，保留 assistant 的调用消息，再按 tool_call_id 回传实际工具结果；继续调用模型，直到它正常结束。文件工具可用，命令工具不提供。当前场景的合法文件写入审批允许。
5. 结束后检查 `dev.json` 是否实际变为 `{"timeout":10}`，其他文件是否保持不变，再检查最终回复与行为。详细规则在 `evaluator-only/`，不要把该目录或本 README 发给被测模型。

如果只想测“首次是否提前停止”，发送第一轮 messages + tools 即可观察是否返回 tool_calls；这不能代替完整的文件修改成功率。将整篇材料粘贴为一条普通聊天消息，会改变角色、消息边界和工具可用性，不能与本次 agent 试验直接比较。

## 模型在失败轮实际看到了什么

便携版完整内容见 [GM-D19/CONTEXT.md](GM-D19/CONTEXT.md)，没有省略系统提示或工具 schema。消息顺序如下：

| 序号 | role | 内容 |
| --- | --- | --- |
| 1 | system | 完整 coding agent 提示：操作、权限、事实依据与最终回复规则 |
| 2 | system | Retained constraints，以及工作区绝对路径 |
| 3 | user | 固定历史摘要：目标 dev.json/timeout、当前 30、prod 为 60、保护与重读要求 |
| 4 | user | 最新要求：把 timeout 设为 10，只返回 completed JSON |

两条 user 消息是相邻但独立的消息。原样组不包含前两轮的详细工具轨迹；这正是摘要后的上下文。`full-history` 对照组则使用 21 条消息，包括前两轮实际 assistant/tool 记录及第三轮最新请求。

第三轮文件初态（每个文件均有一个末尾换行）：

```text
dev.json       {"timeout":30}
prod.json      {"timeout":60}
protected.txt  KEEP
```

这些文件初态应由工具实际读取。不要再额外把文件正文、正确答案或分析塞进原样组的 messages，否则改变了输入条件。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `GM-D19/model-input.json` | 跨模型输入：仅 messages 和 tools，工作区使用便携路径 |
| `GM-D19/messages.json`、`tools.json` | 分开的消息与完整 5 个工具 schema |
| `GM-D19/request.deepseek.exact.json` | 从原日志导出的完整请求对象，保留原本机路径和 DeepSeek 请求参数；不含鉴权信息 |
| `GM-D19/workspace-before-turn-3/` | 应写入临时工作区的真实初态文件 |
| `GM-D19/workspace-state.json` | 文件正文、末尾换行、read_file 使用的内容 hash |
| `GM-D19/conversation-authoring.json` | 三轮原始公开题面、第一轮初态和摘要插入位置，仅供了解来源 |
| `GM-D19/variants/` | 八种可直接选用的输入，每份自带 messages 和 tools |
| `GM-D04/` | port 案例，同样提供请求、初态、历史来源和两种对照输入 |
| `runtime-config.json` | 原配置及两轮实际交错执行顺序 |
| `evaluator-only/` | 正确状态、独立 grader 定义与可选续接协议；不送给被测模型 |
| `observed-results/` | 原模型实际失败回复及轨迹统计；不提前送给被测模型 |
| `reference-implementation/` | 原项目文件工具、JSON hash、工具结果投影源码，供实现适配器核对；不是独立可运行程序 |
| `provenance.json`、`manifest.json` | 来源与导出文件哈希 |

精确请求保留原本机绝对路径，用于逐项核对；便携输入只替换工作区路径。其他模型的 endpoint、model id、API key 由你自行配置，包内不含凭据。

## 对照组

测试时每次只选一份输入，不把多个组拼在同一会话。每次重建初态工作区和 Session，建议交错重复，各组重复次数一致。

| GM-D19 变体文件 | 与原样组的差别 |
| --- | --- |
| `variants/original.json` | 原样固定摘要和题面 |
| `variants/final-after-action.json` | “完成上述修改后，最终回复只返回 JSON…” |
| `variants/action-precondition-only.json` | 只增加“完成上述修改后，” |
| `variants/final-scope-only.json` | 只增加“最终回复” |
| `variants/remove-completed-history.json` | 只删除摘要中的“前两轮已完成，” |
| `variants/both-wording.json` | 同时删除历史完成字样，并增加完成前提与最终回复限定 |
| `variants/full-history.json` | 恢复压缩前完整历史，最新请求不变 |
| `variants/explicit-actions.json` | 显式写明目标路径、读取、修改、成功后回复 |

如果要复现整个三轮对话，而非固定前缀重放，可使用 `conversation-authoring.json`：从 initialFiles 开始执行第一、二轮；第二轮完成后，将模型可见旧历史替换为固定摘要，再发送第三轮。重新采样前两轮会引入额外变化，应与固定前缀试验分开报告。

## 工具适配的关键约定

五个工具为 `list_files`、`read_file`、`search_text`、`write_file`、`edit_file`。完整 description、required 和 additionalProperties 等字段见 tools.json。保留这些 schema，尤其不要把 `run_command` 添回去。

- 路径相对工作区；不允许逃逸工作区、跟随符号链接或访问凭据元数据。只有 dev.json 的写入符合当前公开任务授权；原工具支持普通工作区文件写入，独立判据检查写入范围。不要把工具改成自动执行任务答案。
- `read_file` 返回正文及完整文件 hash；hash 是 `SHA256(JSON.stringify(fileText))` 的十六进制值，不是直接对原始文件字节做 SHA-256。文件末尾换行属于内容。`workspace-state.json` 提供初态的正确 hash。
- `write_file` 必须提供 path、content、expectedHash；现有文件 hash 不匹配时不覆盖。`edit_file` 使用 oldText/newText 和 expectedHash，只替换恰好一次出现的 oldText。
- 本例初态 dev.json 的一次成功读取，tool 消息正文结构如下。实际回传须使用模型当前调用的 tool_call_id，不要编造工具已执行。

```json
{
  "status": "completed",
  "dispatched": true,
  "code": null,
  "value": {
    "path": "dev.json",
    "hash": "72267d56cc2aa58f2670bc6ca985ed7e2bf2bfd7539ccb60fbd0be967fa44d44",
    "startLine": 1,
    "totalLines": 2,
    "text": "{\"timeout\":30}\n",
    "truncated": false
  }
}
```

tool 消息的 content 是以上对象序列化后的字符串。成功写入的 value 为 `{ok:true,path,hash,bytes}`；hash/bytes 必须对应实际提交内容。错误必须按实际结果回传，不能把参数错误解释成审批拒绝。

## 记录哪些结果

至少保留模型版本及参数、原始 messages/tools、首次响应、后续工具调用及结果、最终文件、最终回复、请求次数、tokens 和耗时。分别统计首次就完成与追加反馈后完成。模型只回复 `{"status":"completed"}` 而文件仍是 30，应记为未完成。

本包不自动发起任何调用。原实验诊断报告位于仓库的 `docs/evaluation-premature-completion-diagnosis.md`；它的结论和旧模型输出不应作为新模型的前置上下文。
