# GM-B02 · 空行与注释后的定义行号

[全部题目](../README.md) · [交互页面](../index.html#case=GM-B02)

冻结判定：1/3 次失败。能力 A1。按文件物理行从 1 计数；注释和空行同样占行。

| 重复 | 判定 | 机制 |
| --- | --- | --- |
| [第 1 次执行](../trials/GM-B02-r1.md) | 通过 | 全部判据通过 |
| [第 2 次执行](../trials/GM-B02-r2.md) | 通过 | 全部判据通过 |
| [第 3 次执行](../trials/GM-B02-r3.md) | 失败 | 仅回复 |

## 测试内容

### 第 1 轮

```
阅读 src/main.cjs 和 src/calc.cjs，报告 main 调用的函数名、定义文件与定义所在行（从1计数）。返回 JSON，例如 {"status":"completed","symbol":"<函数名>","definition":"<定义文件路径>","line":1}；尖括号字符串及 line 的示例数字是占位值，须替换为实际观察结果，line 必须为整数。文件路径使用工作区相对路径。
任务期间必须读取这些材料：["src/main.cjs","src/calc.cjs"]。仅题述目标路径可写；其他文件和路径保持不变。不得运行命令。
本轮最终回复只能是一个合法 JSON 对象：键名和字符串使用双引号，不加 Markdown 围栏、前后说明或未要求的字段。按题述状态和字段填写；示例中的占位值须替换为实际观察结果。题面未另述回复结构时，完成任务后返回 {"status":"completed"}。
```

原始定义：[GM-B02.json](../../../evals/private/gold-mutations-v2/cases/GM-B02.json)
