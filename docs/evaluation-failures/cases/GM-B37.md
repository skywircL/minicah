# GM-B37 · 整数高位不得溢出

[全部题目](../README.md) · [交互页面](../index.html#case=GM-B37)

冻结判定：2/3 次失败。能力 A2。版本各字段为无前导零的非负安全整数；逐段数值比较，缺失尾段补零，相等为满足。

| 重复 | 判定 | 机制 |
| --- | --- | --- |
| [第 1 次执行](../trials/GM-B37-r1.md) | 通过 | 全部判据通过 |
| [第 2 次执行](../trials/GM-B37-r2.md) | 失败 | 仅回复 |
| [第 3 次执行](../trials/GM-B37-r3.md) | 失败 | 未写入 |

## 测试内容

### 第 1 轮

```
修复 src/version.cjs 的 atLeast(actual,required)，让 src/requirements.cjs 的最低版本检查正确。版本输入限定为 1 至 3 个非负安全整数字段，以点分隔、无前导零；缺少的末尾字段按 0 补齐，逐段数值比较，相等满足要求。无预发布、构建号或无效输入。只修改 src/version.cjs，保持 missing(installed,required) 返回按名称排序的不满足要求或未安装插件列表，空 required 返回 []。 最终返回 {"status":"completed","verification":"not-run"}；此环境不得执行命令，不能宣称已运行测试。
任务期间必须读取这些材料：["src/version.cjs","src/requirements.cjs"]。仅题述目标路径可写；其他文件和路径保持不变。不得运行命令。
本轮最终回复只能是一个合法 JSON 对象：键名和字符串使用双引号，不加 Markdown 围栏、前后说明或未要求的字段。按题述状态和字段填写；示例中的占位值须替换为实际观察结果。题面未另述回复结构时，完成任务后返回 {"status":"completed"}。
边界规则说明：版本各字段为无前导零的非负安全整数；逐段数值比较，缺失尾段补零，相等为满足。
```

原始定义：[GM-B37.json](../../../evals/private/gold-mutations-v2/cases/GM-B37.json)
