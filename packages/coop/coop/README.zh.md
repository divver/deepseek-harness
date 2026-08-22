# @deepseek-ai/dsh-coop

[English](README.md) | 中文

基于 workspace 共享文件存储的跨 session Master/Worker 计划协作。同一项目目录（归一化后同 `cwd`）下的多个 `dsh` session 注册为 `master` 或 `worker`，按十一个状态的工作流推进共享计划；`.dsh/coop/` 下的文件是权威，每个 session 把自己的动作镜像进各自的会话日志。

## 模型

- **注册表** — `.dsh/coop/registry.json` 保存 `{ sessionId, roles, reviewLevel?, updatedAt, heartbeatAt, cwd, cwdScope }`。每个 workspace 只有一个存活 `master`：单例检查在注册表写锁（`withFileLock`）内完成，两个进程不可能同时成为 master。过期条目（`heartbeatAt` 超过 `staleMs`）不再阻塞并可被抢占。`cwdScope: "any"` 的条目同时写入全局表（`$DSH_HOME`/`~/.dsh`），从任意 workspace 可见。
- **计划** — `.dsh/coop/plans/<planId>.json` 是权威计划状态；`.dsh/coop/docs/<planId>.md` 承载人类可读轨迹（Objective / Pre-review / Execution / Verify / Abort / Changelog）。每次状态迁移都在单个 plan 锁内完成校验与提交；模型侧调用者永远见不到冲突、也永远不需要重试。
- **投递** — 单一路径。通知追加一行信令到 `.dsh/coop/inbox/<sessionId>.jsonl`（单调 `seq`）；接收 session 把水位（`.dsh/coop/inbox/.consumed/<sessionId>`）之上的每一行经 `Agent.followup` 投给自己的 agent——唤醒 driver，并作为真实 turn 落入 transcript。同进程对端立即 drain；跨进程对端在下一次激活（`agent/session-start`）时 drain。追加与水位写的是不同文件，因此既不会丢消息也不会重复投递。
- **镜像** — `coop/registry`、`coop/plan-change`、`coop/review`、`coop/execution` 追加到执行方 session 的日志，用于审计与回放折叠。它们只是观察记录；任何分歧以共享文件为准。

## 工作流

```
create → draft → notify → pending_pre_review → pre_review(pass) → ready_to_execute
       → execute_begin → executing → execute_report → pending_verify
       → verify(pass) → done → closed
pre_review(request_changes) → needs_plan_revision → (master updates, re-notify)
verify(request_changes)     → needs_rework → execute_begin …
abort (any non-terminal)    → aborting → abort_ack → aborted
                            → ack 超时 → aborted（master 闭环）
executing 心跳超时           → needs_rework（worker 可重新 begin）
```

只有创建计划的 master 能 verify 或 abort；只有亲和 worker（首 notify 时绑定）能 pre-review、执行或确认停止。

## 配置

全部字段可选；枚举与正数规则在加载时 fail loud。

| 键 | 默认 | 含义 |
|---|---|---|
| `mirrorEvents` | `false` | 把四个 `coop/*` 镜像事件写入各 session 日志 |
| `defaultReviewLevel` |
| `docRoot` | `.dsh/coop` | workspace 相对的存储根 |
| `allowNoWorker` | `false` | 无可见 worker 时允许 master 自指派 |
| `staleMs` | `300000` | 注册表心跳窗口；同时决定 master 抢占 |
| `executingStaleMs` | `600000` | executing 心跳超时转 needs_rework 的窗口 |
| `abortAckTimeoutMs` | `120000` | ack 超时后 master 闭环为 aborted |
| `workerSelector` | `earliest` | 首 notify 绑定策略：`earliest` 或 `round-robin` |
| `inboxCompactThreshold` | `256` | 已投递信令行数达到阈值后压缩 |
| `allowAnyCwdRoles` | `[master, worker]` | 允许声明 `cwdScope: "any"` 的角色 |

## 人类命令

`/coop role <master|worker> [--level L] [--any-cwd]`、`/coop role list [--all]`、`/coop role off`、`/coop plan notify <planId> [--worker <sessionId>]`、`/coop abort <planId> [--reason <text>]`。

## Model Experience

### Tool schema

#### 模型看到什么

模型看到生成的 [`coop_*` schema](../../../docs/tool-catalog.md#deepseek-aidsh-coop)：`coop_register`、`coop_list`、`coop_plan_create`、`coop_plan_notify`、`coop_pre_review`、`coop_execute_begin`、`coop_execute_report`、`coop_verify`、`coop_abort`、`coop_abort_ack`、`coop_status`。

#### Token 影响

可见时为固定 schema 开销；注入的 `coop:policy` 系统提示段增加一段描述状态机与"被唤醒即行动"规则的固定文本。

#### KV Cache 影响

插件可见性不变时前缀稳定。

### Tool-call 历史与结果

#### 模型看到什么

每个工具回答一行紧凑文本，含计划 id 与结果状态。稳定失败在消息中携带 `CoopError` 代码：`COOP_MASTER_ALREADY_EXISTS`、`COOP_NO_WORKER`、`COOP_NOT_ASSIGNED_WORKER`、`COOP_NOT_PLAN_OWNER`、`COOP_INVALID_TRANSITION`、`COOP_REGISTRY_MISSING`、`COOP_PLAN_NOT_FOUND`、`COOP_DOC_PATH_OUTSIDE_WORKSPACE`。跨 session 通知以 `[coop] …` 的 user turn 到达，source 为 notice 形态的 `plugin: coop`。

#### Token 影响

计划历史增长在共享文件里而非任何 transcript；各 session 日志只增加自己的镜像事件与收到的通知 turn。

#### KV Cache 影响

通知只做追加，跟随可复用前缀，不会使既有 KV-cache 失效。

## Known Limitations and Deferred Work

- **执行中断推迟** — abort 目前是 policy 层软停止（状态机 + 提示指令）。覆盖 shell/subprocess/workflow 的 plan→AbortController 执行中断管线是 spec 的独立 P4，本包没有相关代码。
- **`autoDrive` 配置直接拒绝而非实现** — 确定性的服务驱动执行会让跨 cwd 通知绕过模型触发工具；在执行中断管线存在之前，Loader 对该配置键 fail loud。
- **镜像事件默认关闭** — `Session.append` 无法给事件信封打 ignorable 标记，携带 `coop/*` 镜像的日志在任何词汇表更旧的构建上都无法 resume。仅当所有读取方构建都认识该词汇时才设 `mirrorEvents: true`；没有镜像时共享文件依然是权威。
- **存活判定仅用心跳** — spec 提到的持久 header 存在性检查（`ctx.sessionPersistence.list()`）已推迟；当前由 `staleMs` 单独决定新鲜度与抢占。
- **跨进程投递等待激活** — 挂起的 worker 进程只会在下一次 session 启动时得知信令；v1 非目标，不引入 watcher 或推送通道。
