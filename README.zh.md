# dsh-plugin-agent-budget

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Agent 树的共享
Token 预算插件。根 Agent、one-shot/continuable subagent 以及 workflow 后代共同消耗一份
可持久化预算。

> **状态**：实验性，已验证 DSH `0.1.0-rc.5`。目前尚未发布到 npm，作为 DSH 插件生态的
> 开源贡献持续开发中。

## 为什么还需要一个预算插件？

本插件设计时，DSH 生态里还没有一个轻量、自包含的 Token 预算插件能同时做到：

- 把整棵 **Agent 树** 当作一个预算账户；
- 把预算账本 **持久化进 Session 日志**，可重放、可恢复；
- 给模型本身提供只读的 `budget_status` 工具，而不只是人类命令；
- **无 UI / 无外部服务**，可作为普通 bundle 安装。

现在 DSH 生态已经出现了若干预算/成本插件。本项目刻意保持轻量：聚焦“Agent 树级、
可持久化、可重放、fail-closed 的 Token 记账”，把成本面板、碳足迹、per-turn 限制等交给
更专门的插件。

## 安装

作为 bundle 安装到 profile（推荐）：

```bash
dsh plugin --profile <name> add dsh-plugin-agent-budget
```

也可以通过 npm/pnpm 直接安装：

```bash
pnpm add dsh-plugin-agent-budget
```

从 git 安装时，包会通过 `prepare` 脚本在安装期构建。pnpm ≥10 默认阻止 git 依赖的
构建脚本，首次 `add` 会失败；请把 pnpm 打印的包名键加入 profile 的
`pnpm-workspace.yaml` 后重试：

```yaml
allowBuilds:
  dsh-plugin-agent-budget: true
```

本包声明 `dsh.bundle`，安装后由 `dsh plugin` 自动加入 profile 的
`dsh.profile.bundles`，`--dump-config` 中可见 `# == dsh-plugin-agent-budget` 层。
配置层由包根 `cordis.patch.yml` 提供：

```yaml
- insert:
    - id: agent-budget
      name: dsh-plugin-agent-budget
      config:
        maxTokens: 200000
        missingUsage: exhaust
```

`maxTokens` 必填，且必须是正安全整数。`missingUsage` 默认为 `exhaust`；只有当 provider
明确不返回 usage、并且你能接受预算统计不完整时，才建议设为 `ignore`。

## 导出面（Export shape）

插件导出四个命名成员，**没有默认导出**：

- `name: 'agent-budget'`
- `inject: ['llm', 'sessions', 'tools']`
- `apply(ctx, config)` — 函数插件入口
- `Config` — loader 配置 schema

## 模型体验（Model Experience）

模型可以调用只读工具 `budget_status`，查看上限、已用量、剩余量、耗尽状态、四类
usage、`meteringComplete` 和 `unmeteredCalls`。工具不能修改预算。

## 行为

- 只有 `origin: subagent` 的祖先链共享预算；普通 Session 和普通 fork 各自独立。
- 所有携带 `sessionId` 的 `llm/stream` 调用都会计入，包括普通回复、subagent、workflow、
  compaction 和标题生成。
- 未缓存输入、缓存读取、缓存写入和输出是四个互不重叠的桶；reasoning 已包含在输出中，
  不会重复累加。
- 根 Session 的首个 `budget/open` 事件固定预算上限。插件热重载不会修改已有预算。
- 已经准入的并发调用可以造成有限超额；已结算用量达到上限后，新调用会在 provider
  执行前以 `TOKEN_BUDGET_EXHAUSTED` 失败。
- 不带 `sessionId` 的直接调用不属于 Agent 树，不纳入预算。

## 持久化兼容性

DSH `0.1.0-rc.5` 支持通过类型合并增加 Session 事件，但 `Session.append()` 尚未暴露事件
信封的 `ignorable` 标志。插件会把三个预算事件注册到运行时导出的已知事件集合，因此在
插件已加载时可以正常 resume。请在打开包含预算账本的 Session 之前加载插件。未安装插件的
DSH reader 会拒绝这些 Session，而不是静默丢弃预算状态。等 DSH 提供正式的自定义事件注册
或 ignorable append API 后，可以移除这层兼容逻辑。

## 已知限制（Known Limitations）

- `agent/request-error` 拦截按 `failure.code === 'TOKEN_BUDGET_EXHAUSTED'` 全局生效，
  任何来源抛出该 code 的错误都会被静默吞掉。当前只有本插件会产生该 code；若未来其他
  插件复用该 code，需要收紧这里的边界。
- 必须加载插件后才打开包含预算账本的 Session，否则 DSH reader 会拒绝这些 Session。
- 与 DSH `0.1.0-rc.5` 验证；升级 DSH 时请重点回归：session 事件注册、`llm/stream`
  钩子签名、`agent/request-error` 载荷结构。
- 并发准入可能造成有限超额，这是设计取舍（README 语义已声明）。
- 计量不完整时默认 fail-closed：明确不返回 usage 的 provider 请配置
  `missingUsage: 'ignore'`。

## 相关项目

- [vibeinging/dsh-agent-budget](https://github.com/vibeinging/dsh-agent-budget) —
  Agent 树级原生 Token 预算，带并发安全 reservation 和 `/budget` 命令。
- [PerryLink/dsh-budget](https://github.com/PerryLink/dsh-budget) — 更完整的成本治理：
  USD/碳/延迟计量、预算上限、告警和 Settings 面板。
- [dsh-token-budget](https://www.npmjs.com/package/dsh-token-budget) — 累计 token 用量、
  缓存命中率、按模型/时段估算成本。
- [dsh-turn-budget](https://www.npmjs.com/package/dsh-turn-budget) — per-turn 的
  step/tool-call/provider token 预算。

本项目刻意保持范围狭窄：**可持久化的 Agent 树 Token 预算 + 模型可见的只读状态工具，
不需要 UI。**

## 仓库结构

```text
src/index.ts            插件实现
tests/                  单元 + 集成测试（确定性 mock stream）
cordis.patch.yml        dsh plugin profile 的默认 bundle 层
scripts/                lint / test / pack 校验脚本
docs/design.md          设计决策与兼容性说明
.github/workflows/ci.yml Node.js 22/24 CI
```

发布历史见 [CHANGELOG.md](CHANGELOG.md)。

## 开发

```bash
pnpm install
pnpm check
```

默认测试使用确定性的 mock stream。存在 `DEEPSEEK_API_KEY` 时，`pnpm test:smoke` 会执行
一次很小的真实 DeepSeek 请求；没有 Key 时自动跳过。CI 覆盖 Node.js 22 和 24。

贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

MIT
