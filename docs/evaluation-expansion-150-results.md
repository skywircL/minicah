# 150 条受控变体：验收结果

本页记录 gold-mutations-v2@2.0.0 的运行证据，构造协议见 [扩充方案](evaluation-expansion-150.md)。150 条包括原 20 条和新增 130 条，仍是 10 个父家族的公开开发集变体。

**2026-10-03 已完成程序验收：8 项测试通过，450 次校准符合全部预期，当前审计 `candidatePackageReady=true`。** 真实模型已完成 858 次试验（738 通过、120 失败），见 [模型评测结果](evaluation-expansion-baseline-results.md)。人工语义复核和正式逐条人审仍独立保留待完成状态，且真实运行新增两类契约疑点。

## 分布

| 类型 | 数量 |
| --- | ---: |
| boundary | 48 |
| permission | 32 |
| adversarial | 42 |
| dialogue | 28 |

低风险 10 条，中风险 38 条，高风险 102 条。122 条单轮、21 条三轮、7 条四轮。普通场景 3 次、高风险 7 次，完整真实模型协议为 858 次试验；数据扩充与校准阶段不调用模型 API。后续真实评测的环境、统计与执行状态见 [150 条真实模型评测](evaluation-expansion-baseline.md)。

| 能力 | 数量 |
| --- | ---: |
| A1 | 19 |
| A2 | 78 |
| A3 | 24 |
| A4 | 1 |
| A5 | 28 |

上述分布有意增加 A2 代码修复与高风险组合。A6、H/P、真实服务故障和并发冲突未新增覆盖；这些限制保存在机器分布报告中。

## 验证状态

| 检查 | 最终结果 |
| --- | --- |
| 构造与隔离测试 | 8 / 8 通过 |
| 正参考 | 150 / 150 通过 |
| 反例 | 300 / 300 被声明的判据检出；其余判据全部通过 |
| 初始缺陷区分 | 28 种，在父题及同家族见证输入上与父题/同批其他缺陷区分 |
| 新函数见证 | 28 个测试定义，29 个明确输入/期望；保留全部父测试与 v1 边界测试 |
| 规则与语义签名 | 150 条通过；去除 ID/措辞差异后无重复签名 |
| 环境重置 | 450 个独立工作区、450 份独立日志、639 个任务 runId |
| 初态读取 | 1,155 次文件内容哈希匹配 |
| 历史压缩 | 30 次完整试验观察到约定压缩 |
| 清理与判分 | 全部清理确认，无判据 error 或证据不足 |
| 证据审计 | 537 个报告/日志引用校验通过，并从原始结果复核判据及重置证据 |
| 校准阶段模型 API | 0 次；随后真实模型评测另行执行并报告 |

本轮按文章第 6–8 节补齐了可执行的去重、规则、可解性、分布、重置与三层判分检查。自动语义检查是在声明的契约和有限见证输入上进行，不等于完整程序语义证明或独立业务人员复核。

校准期间修复了一处新增审计工具的哈希口径错误：Workspace 返回 JSON 规范化内容哈希，不能与原始文本 SHA-256 混用。已改用真实 Workspace 读取结果进行回归测试。另替换了 3 个与父题原始缺陷行为等价的初态，并增加一个输入来区分两种锚点检查缺陷；最终数据重新冻结后完整执行 450 次校准。早期记录保留，不覆盖成当前成功结果。

- [最终校准报告](../.minicah/gold-expansion-validation/calibration-IHxDLl/report.json)
- [当前审计](../evals/private/gold-mutations-v2/audit-report.json)
- [当前校准指针](../evals/private/gold-mutations-v2/calibration-latest.json)
- [首次哈希口径问题记录](../.minicah/gold-expansion-validation/calibration-gqTY9Z/reset-diagnosis.json)

最终报告 SHA-256：`302ce95724bb7e43025e89f0d601569cad5d7c4819f57ffb2d8f7138c801a632`。

数据 manifest：`e7f067abae4eef075fb43d93ddb1a0b2a95c04dc5fb4878cfa4e0d48153a5233`。

运行时/构造依赖：`d7e19a6d2155127b23b2659810b8077a4b140760c609bd883c422fc62f186aa3`。

原 v1 的 20 条文件逐字保留；v1 manifest、金种子 manifest、两者运行时指纹和已有模型报告均未改写。新增 130 条的内容 hash 绑定最终作者规则、构造工具、构造协议和冻结父版本。后续修改这些依赖时，旧校准/人审不得自动迁移。

## 审阅入口

- [逐条导航](../evals/private/gold-mutations-v2/review-navigation.md)
- [完整审阅包](../evals/private/gold-mutations-v2/review.md)
- [覆盖矩阵](../evals/private/gold-mutations-v2/matrix.json)
- [分布统计](../evals/private/gold-mutations-v2/distribution.json)
- [规则与去重检查](../evals/private/gold-mutations-v2/quality-gates.json)
- [人审台账](../evals/private/gold-mutations-v2/human-reviews.json)

人工语义审查和逐条验收仍为 pending。首批 104/108 的真实模型成绩不能外推到新增 130 条；本地参考执行不计为模型成绩；后续完整真实评测已独立记录，不与校准结果合并。
