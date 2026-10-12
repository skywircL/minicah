# 服务隔离与插件多实例

服务绑定域决定某个消费者使用哪个 Provider。资源生命周期仍只有 Runtime 与 Session；同一绑定域可包含这两种生命周期的插件，但 Runtime 插件仍不能依赖 Session Provider。

实现参考 DSH 使用的 Cordis 隔离机制：Context 对服务名维护隔离键，服务实现按键存储。minicah 保留自己的 run 快照、严格预校验和等待边界，没有引入 Cordis 依赖、动态 Context proxy 或 ESM 热更新。参考版本为 DSH `4878cdabd87d4041bdaff61d04c966883b9fd07a` 的 [Context.isolate](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/vendor/cordis/src/context.ts) 与 [服务解析](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/vendor/cordis/src/reflect.ts)。

## API

```ts
const root = new ServiceScope();
const plannerKey = createIsolationKey("planner");
const planner = root
  .isolate(modelService, plannerKey)
  .isolate(agentService, plannerKey);

const plugins = [
  planner.mount(modelPlugin, "planner.model"),
  planner.mount(agentPlugin, "planner.agent"),
];
// runtime = await Runtime.create({ plugins, config: { "planner.model": ... } });
// await session.run(run => run.services.get(agentService).run(...), planner);
```

可直接运行的完整示例：[service-isolation.ts](../examples/service-isolation.ts)。示例使用本地确定性服务，不调用真实模型。

`isolate(token, key?)` 返回新的不可变绑定域；指定服务使用新 key，未指定的服务保留原绑定。省略 key 时生成独立身份及 UUID 审计 id。派生子域不会改变父域；后续再次派生父域也不会修改已经存在的子域。

共享绑定要传入**同一个 key 对象**。同一个 key 可用于多个服务，内部仍为每个服务名生成不同 Symbol，避免它们互相覆盖。`createIsolationKey("planner")` 调用两次会产生两个不同对象：同一计划或 run 中出现相同审计 id、不同对象时拒绝加载，防止日志把两个不同绑定误认为一个。

绑定域中的独立槽没有 Provider 时，必需依赖在 setup 前失败；宿主直接查询时报 `MISSING_SERVICE`。不会自动使用父域或根域的同名 Provider。共享其他全局服务由继承的绑定显式决定。

`scope.mount(plugin, instanceId)` 返回附加了绑定域与实例标识的插件描述。`Plugin.id` 保留定义身份，`instanceId` 标识某次挂载。省略实例标识时沿用已有 `instanceId` 或定义 `id`，重复挂载必须提供不同实例标识。手动装配也可直接设置可选字段 `instanceId`、`serviceScope`。

Provider 与 consumer 都要挂载到所需绑定域。`session.run(callback, scope)` 只决定宿主回调如何解析服务；被调用服务的工厂及工具处理器使用它们自己的挂载绑定，不会被调用者的域重新绑定。该规则保证一个 Provider 的依赖不会随调用者悄悄改变。

## 存储与验证

```text
消费者挂载的 ServiceScope
  → 服务名对应的 IsolationKey（未覆盖时使用根绑定）
  → 该 key 与服务名对应的 Symbol
  → 当前 run 的 ServiceRegistration
  → 按相同 Symbol 缓存的服务实例
```

计划阶段按完整绑定检查重复 Provider、缺失依赖、精确接口版本、Runtime → Session 非法依赖以及依赖环。不同域可以提供同名服务，甚至不同接口版本；同一槽只允许一个 Provider，不提供 semver 推断或按版本回退。插件的 `requires` / `provides` 仍限定工厂可以访问的契约。

注册元数据包含 `isolation`（根绑定为 null）、接口版本、owner、generation、资源 scope 和 sessionId。`runtime.inspect()` 展示注册的隔离 id；`run.services.list()` 只列出当前上下文可解析且声明允许的服务。宿主可查看整个 `run.manifest` 的审计材料；这不是隐藏秘密的机制。

`instanceId` 同时用于配置项键、依赖图节点、工厂上下文缓存、资源所有者和 generation 计数器。同一个定义的多个实例会分别执行 setup，拥有独立闭包和受管理资源。插件自行捕获的模块全局状态或外部共享对象不会被自动复制；资源需要通过 setup 和 `ctx.resource()` 分别创建。

动态配置使用 `run.configuration.values[ctx.owner]`。内置模型、AgentLoop、压缩、执行、权限、工具管线及 PTC 已使用挂载身份读取配置。自定义插件如果把定义 id 写死在配置读取中，需要改用 `ctx.owner` 才能支持多实例。

## 替换与持久化

`updateConfig({ [instanceId]: value })`、`disablePlugin(instanceId)` 和 `enablePlugin(instanceId)` 均定位挂载实例；`replacePlugin(scope.mount(nextDefinition, instanceId), config?)` 替换这一实例。其他挂载的 generation 和资源保持不变。重新绑定消费者也通过替换其挂载描述完成；若新绑定尚无 Provider，预校验会拒绝切换。

每次 run 固定服务槽、Provider generation 与实例缓存。替换仍使用**全 Runtime drain 屏障**，尚未实现仅等待受影响域。失败候选撤销自己的注册和受管理资源；排他资源及清理失败继续遵循 `stop-first` / `restart-required` 的原有规则。

当 SessionService.start 提交 run 时，manifest 新增：

- `plugins[].id`：挂载身份；`definitionId`：插件定义身份。
- `services[]`：服务契约、可序列化隔离 id、实际 owner / generation / 生命周期。
- `bindings[]`：消费者实例（null 表示宿主入口）、服务名、接口版本与隔离 id；通过 services 可定位实际 Provider。

Symbol、工厂函数和服务对象仅保存在内存。日志保留逻辑绑定 id；重启由应用重新装配 key 和插件，日志重放只恢复历史事实。重放校验重复服务槽、Provider owner/generation、消费者绑定和生命周期方向。旧日志没有上述扩展字段时仍可读取，不会用当前注册表补造旧绑定。

## 当前边界

服务隔离不自动隔离工具目录、命令、事件和权限。工具、命令和 Skill 的贡献可独立使用 `RegistryScope`，详见[注册目录作用域](scoped-registries.md)。同一注册层内名字唯一，子层可覆盖祖先；`session.run(callback, { serviceScope, registryScope })` 可同时选择服务绑定和贡献视图。`listen()` 仍监听调用方传入的 EventTarget。

本机制用于可信同进程插件装配，不是 OS 沙箱。已经交出的普通 JS 对象也没有自动撤销代理；消费者仍须遵守不跨 run 长期持有服务引用的契约。

CLI 默认装配沿用根域，现有启动参数与会话管理命令不变。此阶段提供内核与程序化装配 API，没有增加 CLI 多 Agent profile 选择界面。
