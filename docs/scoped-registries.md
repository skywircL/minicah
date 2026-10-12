# 注册目录的局部作用域

`RegistryScope` 决定同一个目录中哪些贡献对一次 run 可见。`ServiceScope` 决定取得哪个服务 Provider；`Plugin.scope` 的 Runtime / Session 决定资源寿命。这三个维度可以独立组合。

分层存储参考 DSH `4878cdabd87d4041bdaff61d04c966883b9fd07a` 的 [ScopedLayers](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/core/scope/src/store.ts)。minicah 实现自己的注册事务、不可变 run 快照及审计，没有引入 Cordis。DSH 的工具 restrictions/guards、Skill provider 排序和动态发现不在本次实现范围。

## 组合和查询

```ts
const preset = new RegistryScope("coding");
const reviewer = preset.child("reviewer");
const writer = preset.child("writer");

const plugins = [
  preset.mount(commonTools, "common-tools"),
  reviewer.mount(reviewTools, "review-tools"),
];
const runtime = await Runtime.create({ plugins });
const session = await runtime.openSession();
await session.run(run => run.tools.invoke("read_file", { path: "README.md" }), {
  registryScope: reviewer,
  // serviceScope: someServiceBindings,
});
```

规则：全局 → 最远祖先 → 当前层；最近层覆盖同名条目。同层同名拒绝注册，兄弟互不可见，父级看不到子级。没有传 `registryScope` 的 run 只看全局，不会猜测 AgentLoop Provider 所在的层。没有“排除全局继承”的开关。

Scope 按对象身份区分，`id` 仅用于审计。父链创建后不可变，计划和 run 入口拒绝不同对象使用相同审计 id。`mount` 返回新描述符，可与 `ServiceScope.mount()` 叠加；挂载身份仍控制配置、owner、generation、启停和替换。

局部层不是第三种资源寿命：某局部层中的 Runtime 贡献由 Runtime 插件所有，Session 贡献只进入所属 Session 的目录。同一层内 Session 不能覆盖 Runtime 的同名项；显式子层可以覆盖祖先。同一个 Session 插件在不同 Session 中的注册彼此独立。

## 通用底座与能力接口

- `NamedEntries<T>`：同层名称唯一，返回幂等移除函数。
- `AnonymousEntries<T>`：独立累加贡献，相同值也拥有各自的移除函数。
- `ScopedLayers<L>`：全局层、按需创建的局部层、父链遍历、命名表合并及 `effect` 清理。`L.isEmpty()` 判断整层是否可回收；读取不创建层。`effect` 的 action 必须同步、原子地注册并返回 undo，不能把任意外部副作用当作可回滚事务。
- `registryToken<T>(id, validate, version?)`：声明一个命名贡献目录。所有贡献者和消费者导入同一个 token；同 id 不同 token 拒绝混用，版本是正整数接口代次。`validate` 是纯同步校验/规范化函数。
- `ctx.register(token, name, definition)`：仅 setup 内开放，归属调用插件的 scope、owner、generation 和注册事务。
- `run.registries.get(token).list()/get(name)`：读取本次 run 固定的有效条目，返回 `{ info, value }`。

当前通用目录只统一命名贡献的覆盖规则。工具校验/执行、命令解析和 Skill 读取由各能力模块实现。需要匿名累加或自定义策略的 registry 可以组合 `ScopedLayers`，不必把业务算法放进内核。

注册时复制、冻结普通数据及嵌套对象，保留回调函数引用；不接收循环结构、Map 或任意类实例。回调闭包和服务业务状态仍由插件负责，不能把冻结定义等同于冻结所有程序状态。

### 工具

原来的 `ctx.registerTool()` 继续工作，内部等价于向 `toolRegistry` 注册。`tools` 是保留的目录 id。模型 schema、Tool Pipeline、Native 和 PTC 子调用都来自同一份 run 工具目录，局部不可见的工具不能通过只知道名字来调用。

本次 run 的所有服务工厂和工具处理器共享这份调用方目录，包括全局注册的 AgentLoop 和 ToolService。工具处理器解析服务依赖时仍使用自身插件的 `ServiceScope` 和 `requires`。不提供 run 中途切换目录或任意跨域查询接口。

### 命令

```ts
ctx.register(commandRegistry, "review", {
  usage: "<file>", description: "审查文件",
  parse: file => ({ kind: "prompt", text: `Review ${file}` }),
});
```

`createCliCommandsPlugin()` 注册 `/history`、`/resume` 等默认命令并提供 `CliCommandService`。帮助、列表和解析使用相同目录。扩展命令返回既有 `CliAction`，可以转成 Agent 输入，不提供直接绕过工具权限的 CLI 执行入口。

程序化 CLI 组合可使用 `createCliPlugin({ runOptions: { registryScope: reviewer } })`；会话切换后仍沿用该配置。默认 CLI 继续使用全局目录，尚无交互式 Agent profile 切换界面。

### Skill

```ts
ctx.register(skillRegistry, "review", {
  version: "1", description: "审查代码",
  content: "检查正确性和测试覆盖。",
  resources: { "checklist.txt": "检查边界条件。" },
});
```

组合 `createSkillRegistryPlugin()` 后，用 `run.services.get(skillRegistryService)` 的 `list()`、`get(name)`、`readResource(name, resource)` 读取。列表只暴露摘要，正文和附属文本从同一固定条目读取，覆盖正文不会意外落回祖先的附属资源。本版同层 Skill 重名直接拒绝，不复制 DSH runtime skill 的 first-wins 行为。

这里是显式注册的内存 Skill Registry；尚未接入文件系统 `SKILL.md` 自动发现、动态 provider、模型自动选择/加载 Skill。资源值为注册时固定的文本，不自动读取宿主路径或发起 URL 请求。

## 快照、替换与持久化

run 入口合并当前 Runtime 和当前 Session 的已提交目录，固定可见定义、owner、generation、作用域链。候选插件的注册保存在独立事务中，切换仍等待整个 Runtime 的 run 排空。失败候选只撤销自身注册；禁用局部覆盖后，下一次 run 恢复看到祖先项。

Session 的 `run.manifest` 记录 `registryView.chain` 和所有可见命名贡献的元数据，`plugins[].registryScope` 记录注册层。工具 manifest 保留可见 schema，工具定义版本加入 owner 身份，避免同一 Session 切换作用域后同名工具版本相撞。重放校验作用域可见性、owner/generation、目录接口版本、重复条目和工具 manifest 一致性；缺少新字段的旧日志仍可读取。

`registryView` 是元数据审计，不序列化回调，也不替代完整定义内容的留存。Skill 或其他贡献实际进入模型请求后，应依赖 Session 的实际请求材料记录；外部插件实现与额外 artifact 的可追溯留存仍由相应插件负责。重放不会执行注册项或工具副作用。

事件监听器仍按显式 EventTarget 管理，本次没有新增事件作用域路由。分层目录适用于可信同进程插件组合，不是 OS 沙箱或同进程访问控制边界。

完整示例：`npm run build && node dist/examples/scoped-registries.js`。验证覆盖继承、覆盖、兄弟隔离、清理、失败回滚、run 固定、Native/PTC、CLI、Skill 资源以及日志重放。
