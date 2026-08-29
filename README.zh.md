# dsh-plugin-agent-budget

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Agent 树的共享
Token 预算插件。根 Agent、one-shot/continuable subagent 以及 workflow 后代可以共同消耗一份
可持久化预算。

> **状态**：实验性，已验证 DSH `0.1.0-rc.5`。目前尚未发布到 npm，作为 DSH 插件生态的
> 开源贡献持续开发中。

## 亮点

- 把整棵 **Agent 树** 当作一个预算账户（`scope: tree`），也支持每个 Session 独立账户
  （`scope: session`）；
- 账本保存在**插件自有 sidecar 文件**（`~/.dsh/agent-budget/`），不写入 Session 日志，
  卸载插件不会破坏会话；
- 账本仍是 append-only、可重放、可恢复；
- 给模型本身提供只读的 `budget_status` 工具，而不只是人类命令；
- **无 UI / 无外部服务**，可作为普通 bundle 安装；
- 保持范围狭窄：聚焦“Agent 树级、可持久化、可重放、fail-closed 的 Token 记账”。

## 安装

> 目前尚未发布到 npm。下面的命令默认包已存在于 profile workspace 中（例如通过本地
> checkout 使用 `dsh plugin --profile <name> add -w .`，或等仓库公开后从 GitHub bundle 安装）。

作为 bundle 安装到 profile（推荐，发布后可用）：

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
        scope: tree
```

`maxTokens` 必填，且必须是正安全整数。`missingUsage` 默认为 `exhaust`；只有当 provider
明确不返回 usage、并且你能接受预算统计不完整时，才建议设为 `ignore`。
`scope` 默认为 `tree`；`session` 会让每个 Session 独立计费。
`storageDir` 可选，默认是 `~/.dsh/agent-budget/`。

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

- `scope: tree`（默认）下，优先按 DSH 的 **runtime agent ownership** 解析树根；无法解析时
  退回 durable `parentSession` 链；仍无法解析时**退化为独立预算并告警**，不会把多个会话
  错误地锁到同一个账户。
- `scope: session` 下，每个 Session 独立预算，包括 subagent。
- 所有携带 `sessionId` 的 `llm/stream` 调用都会计入，包括普通回复、subagent、workflow、
  compaction 和标题生成。
- 未缓存输入、缓存读取、缓存写入和输出是四个互不重叠的桶；reasoning 已包含在输出中，
  不会重复累加。
- 预算上限在某个 scope 的首个 open 记录时固定。插件热重载不会修改已有预算。
- 已经准入的并发调用可以造成有限超额；已结算用量达到上限后，新调用会在 provider
  执行前以 `TOKEN_BUDGET_EXHAUSTED` 失败。
- 不带 `sessionId` 的直接调用不属于 Agent 树，不纳入预算。

## 存储与卸载

插件把账本存在：

```text
~/.dsh/agent-budget/
  ledger.jsonl         append-only 账本（open/sample/unmetered）
  scope-index.json     sessionId -> scopeKey 索引
```

- 新版本**不再向 Session 日志写入任何 `budget/*` 事件**；
- 卸载插件后，DSH 可以直接打开所有会话；
- 彻底清除预算数据，删除 `~/.dsh/agent-budget/` 即可；
- 同一个 `storageDir` 同一时间只应由一个 DSH 进程使用。若 `headless` 与
  `web` 同时运行，请为不同 profile 配置不同的 `storageDir`，或避免同时写同一账本。

## 旧数据迁移

`0.1.0` 之前（或本仓库早期版本）写入过 Session 日志的 `budget/*` 事件，请在升级使用这些版本的 profile 前执行一次迁移：

```bash
node scripts/migrate-session-log.mjs
```

迁移工具会：

1. 扫描 `~/.dsh/sessions/**/session.jsonl(.zstd)`；
2. 把 `budget/*` 事件转换到 `ledger.jsonl` 和 `scope-index.json`；
3. 从 Session 日志中移除这些事件；
4. 写回前为每个文件创建 `.bak` 备份。

运行迁移前请先停止正在使用相关 profile 的 DSH 进程。

## 已知限制（Known Limitations）

- `agent/request-error` 拦截按 `failure.code === 'TOKEN_BUDGET_EXHAUSTED'` 全局生效，
  任何来源抛出该 code 的错误都会被静默吞掉。当前只有本插件会产生该 code；若未来其他
  插件复用该 code，需要收紧这里的边界。
- `scope: tree` 在极端冷启动且 parent 不可解析时会退化为独立预算，宁可少共享，也不误锁。
- 与 DSH `0.1.0-rc.5` 验证；升级 DSH 时请重点回归：`llm/stream` 钩子签名、
  `agent/request-error` 载荷结构、`ctx.agents` 的 runtime ownership API。
- 并发准入可能造成有限超额，这是设计取舍（README 语义已声明）。
- 计量不完整时默认 fail-closed：明确不返回 usage 的 provider 请配置
  `missingUsage: 'ignore'`。

## 仓库结构

```text
src/index.ts                    插件实现
tests/                          单元 + 集成测试（确定性 mock stream）
cordis.patch.yml                dsh plugin profile 的默认 bundle 层
scripts/                        lint / test / pack / 旧数据迁移
docs/design.md                  设计决策与兼容性说明
.github/workflows/ci.yml        Node.js 22/24 CI
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
