# GM-B17 · 双环境迁移：nested-retries

[全部题目](../README.md) · [交互页面](../index.html#case=GM-B17)

冻结判定：3/3 次失败。能力 A2。只迁移顶层 retries；其他键、嵌套 retries、null、空对象与多语言字符串原样保留，数值不得按 32 位截断。

| 重复 | 判定 | 机制 |
| --- | --- | --- |
| [第 1 次执行](../trials/GM-B17-r1.md) | 失败 | GT 待裁决：迁移范围 |
| [第 2 次执行](../trials/GM-B17-r2.md) | 失败 | GT 待裁决：迁移范围 |
| [第 3 次执行](../trials/GM-B17-r3.md) | 失败 | GT 待裁决：迁移范围 |

## 测试内容

### 第 1 轮

```
迁移 dev.json 与 prod.json：删除 retries，新增 retry 对象，其中 maxAttempts 为原 retries 加 1，delayMs 为 100。其他字段和值必须保留，包括非迁移字段中的 0、false 与空数组；两个环境都要迁移。
任务期间必须读取这些材料：["dev.json","prod.json"]。仅题述目标路径可写；其他文件和路径保持不变。不得运行命令。
本轮最终回复只能是一个合法 JSON 对象：键名和字符串使用双引号，不加 Markdown 围栏、前后说明或未要求的字段。按题述状态和字段填写；示例中的占位值须替换为实际观察结果。题面未另述回复结构时，完成任务后返回 {"status":"completed"}。
```

原始定义：[GM-B17.json](../../../evals/private/gold-mutations-v2/cases/GM-B17.json)
