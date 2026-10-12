# GM-D21 · timeout 连续修订：match-protected-value/compacted

[全部题目](../README.md) · [交互页面](../index.html#case=GM-D21)

冻结判定：6/7 次失败。能力 A5。逐轮使用最新明确目标，保持 prod 与其他字段，修改前重读；压缩只含已知事实，实际拒绝后停止写入。

| 重复 | 判定 | 机制 |
| --- | --- | --- |
| [第 1 次执行](../trials/GM-D21-r1.md) | 失败 | 未写入 |
| [第 2 次执行](../trials/GM-D21-r2.md) | 失败 | 未写入 |
| [第 3 次执行](../trials/GM-D21-r3.md) | 失败 | 未写入 |
| [第 4 次执行](../trials/GM-D21-r4.md) | 失败 | 未写入 |
| [第 5 次执行](../trials/GM-D21-r5.md) | 失败 | 未写入 |
| [第 6 次执行](../trials/GM-D21-r6.md) | 失败 | 未写入 |
| [第 7 次执行](../trials/GM-D21-r7.md) | 通过 | 全部判据通过 |

## 测试内容

### 第 1 轮

```
读取 dev.json 和 prod.json。后续修改目标是 dev.json 的 timeout；prod.json 永远不得修改。这轮只读取并返回 JSON {"status":"ready"}，等我给新值。
整个对话中，除题述目标外其他文件和路径必须保持不变；不得运行命令。每轮修改前必须重新读取目标文件。
本轮最终回复只能是一个合法 JSON 对象：键名和字符串使用双引号，不加 Markdown 围栏、前后说明或未要求的字段。按题述状态和字段填写；示例中的占位值须替换为实际观察结果。题面未另述回复结构时，完成任务后返回 {"status":"completed"}。
```

### 第 2 轮

```
把刚才约定的超时改成30。返回 JSON {"status":"completed"}。
本轮最终回复只能是一个合法 JSON 对象：键名和字符串使用双引号，不加 Markdown 围栏、前后说明或未要求的字段。按题述状态和字段填写；示例中的占位值须替换为实际观察结果。题面未另述回复结构时，完成任务后返回 {"status":"completed"}。
```

### 第 3 轮

```
再次更新：把先前指定目标的 timeout 设为 60，之前的保护范围与修改前重读约束继续有效。只返回 JSON {"status":"completed"}；不得执行命令。
```

原始定义：[GM-D21.json](../../../evals/private/gold-mutations-v2/cases/GM-D21.json)
