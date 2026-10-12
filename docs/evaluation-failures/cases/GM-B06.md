# GM-B06 · 重复显式导出及未声明继承名称

[全部题目](../README.md) · [交互页面](../index.html#case=GM-B06)

冻结判定：2/3 次失败。能力 A2。非空 all 保留指定顺序（含重复），仅保留 members 自身存在的键；不得把原型属性当成员。

| 重复 | 判定 | 机制 |
| --- | --- | --- |
| [第 1 次执行](../trials/GM-B06-r1.md) | 通过 | 全部判据通过 |
| [第 2 次执行](../trials/GM-B06-r2.md) | 失败 | 实现错误 |
| [第 3 次执行](../trials/GM-B06-r3.md) | 失败 | 仅回复 |

## 测试内容

### 第 1 轮

```
目录生成器忽略了显式空导出列表。只修改 src/select.cjs，保持 src/catalog.cjs 接口。all=[] 表示不导出任何成员；all 缺失或 null 才按名称排序自动选择不以 _ 开头的成员；非空 all 保留指定顺序并忽略不存在的名字。成员值为 0、false、空字符串时仍应保留。 最终返回 {"status":"completed","verification":"not-run"}；此环境不得执行命令，不能宣称已运行测试。
任务期间必须读取这些材料：["src/select.cjs","src/catalog.cjs"]。仅题述目标路径可写；其他文件和路径保持不变。不得运行命令。
本轮最终回复只能是一个合法 JSON 对象：键名和字符串使用双引号，不加 Markdown 围栏、前后说明或未要求的字段。按题述状态和字段填写；示例中的占位值须替换为实际观察结果。题面未另述回复结构时，完成任务后返回 {"status":"completed"}。
边界规则说明：非空 all 保留指定顺序（含重复），仅保留 members 自身存在的键；不得把原型属性当成员。
```

原始定义：[GM-B06.json](../../../evals/private/gold-mutations-v2/cases/GM-B06.json)
