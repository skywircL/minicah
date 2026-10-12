# 150 条变体真实模型评测

2026-10-03：真实 API 评测已完成，150 条 / 858 次试验，738 通过、120 失败、0 排除。结果、稳定性、用量及两类契约复核项见 [正式结果](evaluation-expansion-baseline-results.md)。数据与 GT 保持冻结；本轮结果不等于发布批准。

## 冻结范围与环境

数据集为 `gold-mutations-v2@2.0.0`，150 条变体来自 10 个父家族，包括原 20 条和新增 130 条，全部属于已公开审阅的 `gold_dev`。本轮重新运行完整 150 条，旧 108 次试验保留为历史成绩，不与本轮合并。

| 协议 | 配置 |
| --- | --- |
| 普通题 | 48 条，每题 3 次，共 144 次 |
| 高风险题 | 102 条，每题 7 次，共 714 次 |
| 总计 | 858 次完整试验：662 次单轮，196 次多轮 |
| 多轮结构 | 21 条三轮题、7 条四轮题；整段对话计一次试验 |
| 模型 | 官方 `https://api.deepseek.com`，`deepseek-flash` |
| 模型设置 | thinking=false，输出上限 4096，配置上下文窗口 1,000,000 tokens |
| 采样 | temperature、随机种子未显式设置，使用供应商默认值，与旧基线一致 |
| 执行 | 并发 1；题目顺序、同题连续重复；先单轮后多轮 |
| 时限 | 单轮执行加判分 120 秒；多轮每个用户轮次 120 秒；取消宽限 10 秒 |
| 工具 | 题目白名单内的本地文件工具；命令执行不向模型开放 |
| 权限 | 使用题目冻结的允许/拒绝策略；拒绝后行为仍计分 |
| 判分 | 本地确定性 Outcome / Behavior / Response graders，无 LLM judge |
| 重试 | SDK 重试为 0；不通过重跑替换失败；供应商或基础设施失败保留证据后停机 |
| 故障计分 | 必需判据明确失败优先于其他判据 error；仅证据不足时排除 |

每个 trial 新建工作区、Runtime 与日志；执行前逐文件核对初始内容。多轮 trial 内保留同一个 Session，下一 trial 重新创建。固定压缩文本按冻结题目执行，不计为模型自主摘要能力。报告记录 Node、系统、架构、依赖锁、数据、运行时与独立执行驱动的哈希。

逐题落盘保留原始报告、工具轨迹、API 用量和时延。不修改已有 GT、判据、校准、人审 hash 或历史基线。未来用户轮次、隐藏 graders、参考解、反例及人审台账不进入模型上下文。

## 统计口径

1. 报告逐题成功次数/有效次数与 pass@1；分别给出题目宏平均、家族宏平均和各变异类型切片。858 次重复不视为 858 道独立问题。
2. 分开报告 k=3 与 k=7 的观察到的全部通过率、至少一次通过率；使用组合估计计算共同 k=3 的 pass^3，不把两种重复次数混成一个可靠性概率。
3. 逐题给出 95% Wilson 区间，明确条件独立、稳定分布假设；整体按完整父家族重采样 10,000 次，固定随机种子 20261003。只有 10 个有意选取的家族，区间用于描述当前集的敏感性，不代表线上泛化置信保证。
4. 单独报告冻结的文件保护、写入范围、命令尝试、被拒后重试及注入目标尝试判据。安全失败不能被平均成功率抵消；有限场景的零违规不等于完整安全认证。
5. 给出全部 trial 及成功且行为判据通过 trial 的 token、请求数、工具尝试数和 P50/P95 延迟。模型时间使用实际 API 调用耗时；工具墙钟使用轨迹区间并集，避免并发重复计算。剩余耗时包含 harness、启动、判分和本地基础设施，目前不进一步强行归因。
6. 工具选择、路径参数与必需读取的正确性由现有 Behavior 判据报告；本批没有完备的澄清质量或隐私泄漏测试，不报告无分母的“澄清正确率”或泛化隐私保证。API 金额以供应商账单为准，不用 token 数伪造费用。

供应商模型别名可能更新，未设置随机种子，服务端缓存/限流及运行顺序可能引入相关性；本地隔离不能证明所有 trial 严格 IID。

## 工具与证据入口

- [冻结计划](../.minicah/gold-expansion-preflight/v2/plan.json)
- [全部公开输入范围](../.minicah/gold-expansion-preflight/v2/payload-review.json)
- [明确外发授权](../.minicah/gold-expansion-preflight/v2/explicit-egress-authorization.json)
- [独立运行器](../scripts/evaluation/expansion-baseline.mjs)
- [分析器](../scripts/evaluation/analyze-expansion-baseline.mjs)
- [统计工具](../scripts/evaluation/expansion-statistics.mjs)
- [统计及计分测试](../scripts/evaluation/expansion-baseline.test.mjs)
- [150 条本地验收结果](evaluation-expansion-150-results.md)

```sh
node scripts/evaluation/expansion-baseline.mjs --plan
# 下面命令会调用付费 API，应在本轮具体范围获准后执行。
node scripts/evaluation/expansion-baseline.mjs
node scripts/evaluation/analyze-expansion-baseline.mjs <本轮产物目录>/report.json
```

运行前 6 项统计/计分测试已通过，数据 manifest、运行时与执行驱动保持匹配。正式人审台账仍独立保留 pending；模型分数不自动替代人工验收。

环境设计参考[科学评测文章第 2 节](https://brenchcc.github.io/Awesome-LLM-Research-Collections/notes/zh/agents/scientific-agent-evaluation.html#评测环境设置)，重复运行与成本口径参考[冷启动文章第 9 节](https://brenchcc.github.io/Awesome-LLM-Research-Collections/notes/zh/agents/cold-start-agent-evaluation-dataset.html#重复运行才能区分偶尔做对和稳定做对)。公开文章源码已保存到本轮准备目录供复核。
