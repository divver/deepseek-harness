# @deepseek-ai/dsh-coop

[English](README.md) | 中文

基于 workspace 共享文件存储的跨 session Master/Worker 计划协作。同一项目目录（归一化后同 `cwd`）下的多个 `dsh` session 注册为 `master` 或 `worker`，按十一个状态的工作流推进共享计划；`.dsh/coop/` 下的文件是权威，每个 session 把自己的动作镜像进各自的会话日志。

## 模型

- **注册表** — `.dsh/coop/registry.json` 保存 `{ sessionId, roles, reviewLevel?, updatedAt, heartbeatAt, cwd, cwdScope }`。每个 workspace 只有一个存活 `master`：单例检查在注册表写锁（`withFileLock`）内完成，两个进程不可能同时成为 master。每个存活 session 都会在轮询周期内触碰心跳（`inboxPollMs`），开着的会话永远可见；过期条目（`heartbeatAt` 超过 `staleMs`）不再阻塞并可被抢占。`cwdScope: "any"` 的条目同时写入全局表（`$DSH_HOME`/`~/.dsh`），从任意 workspace 可见。
- **计划** — `.dsh/coop/plans/<planId>.json` 是权威计划状态；`.dsh/coop/docs/<planId>.md` 承载人类可读轨迹（Objective / Pre-review / Execution / Verify / Abort / Changelog）。每次状态迁移都在单个 plan 锁内完成校验与提交；模型侧调用者永远见不到冲突、也永远不需要重试。
- **投递** — 单一路径。通知追加一行信令到 `.dsh/coop/inbox/<sessionId>.jsonl`（单调 `seq`）；接收 session 把水位（`.dsh/coop/inbox/.consumed/<sessionId>`）之上的每一行经 `Agent.followup` 投给自己的 agent——唤醒 driver，并作为真实 turn 落入 transcript。同进程对端立即 drain；每个存活 session 还会按 `inboxPollMs`（默认 1 秒）轮询自己的 inbox，因此开着的空闲 worker 最迟一个轮询周期内就会收到通知，并在它的 TUI 里实时流式渲染出该 turn。追加与水位写的是不同文件，因此既不会丢消息也不会重复投递。
- **镜像** — `coop/registry`、`coop/plan-change`、`coop/review`、`coop/execution` 追加到执行方 session 的日志，用于审计与回放折叠。它们只是观察记录；任何分歧以共享文件为准。

## 工作流

```
create → draft → notify → pending_pre_review → pre_review(pass) → ready_to_execute
       → execute_begin → executing → execute_report → pending_verify
       → verify(pass) → done → closed
pre_review(request_changes) → needs_plan_revision → (master updates, re-notify)
verify(request_changes)     → needs_rework → execute_begin …
abort (any non-terminal)    → aborting → abort_ack → aborted
                            → ack timeout → aborted (master closes)
executing heartbeat timeout → needs_rework (worker may re-begin)
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
| `mode` | `v1` | `v2` 启用多 master 节点注册表（见下） |
| `maxWorkers` | `4` | v2 单 master 的 worker 容量上限（bind 与注册时校验） |
| `maxReviewers` | `2` | v2 单 master 的 reviewer 容量上限（bind 与注册时校验） |
| `maxParallelTasks` | `3` | v2 单 master 跨 plan 同时 assigned+executing 的任务上限 |
| `maxReworkAttempts` | `3` | v2 返工轮数耗尽后任务升级为 blocked |
| `memoryInjectTopK` | `8` | v2 注入 coop:memory 提示段的最新记忆条数（§12.3 时间倒序 top-K） |
| `memoryRetainEntries` | `256` | v2 单 master 记忆保留预算；追加时丢弃最旧记录 |
| `spawn` | `auto` | v2 节点自动创建通道：可达时用 `herdr` 窗格，否则进程内 `headless`，`auto` 自动选择 |
| `spawnCommand` | `dsh --cwd {cwd}` | v2 在新建 herdr 窗格里运行的命令模板；`{cwd}` 会被替换 |
| `spawnReadyRegex` | _（空）_ | v2 新窗格输出必须匹配的正则，匹配后才发送注册行 |
| `allowSelfReview` | `false` | v2 无 reviewer 时允许 master 自验自己的任务（§12.4） |
| `roleLlm` | _（空）_ | v2 按角色固定 LLM 路由 `{ master\|worker\|reviewer: { provider, model, reasoningEffort? } }`；注册为该角色的会话其每个请求都改走此路由（provider+model 成对，effort 档位由目标 adapter 解释） |
| `spawnRegisterTimeoutMs` | `30000` | v2 等待新窗格注册落入注册表的窗口；期间每约 4 秒重发注册行，超时 fail-loud 并给出手动注册行 |
| `spawnLayout` | `columns` | v2 自动建窗格的排布：`columns` —— master 一列，worker 一列（上下堆叠），reviewer 一列（上下堆叠，在 worker 列右侧）；`right` —— 旧行为，全部切在 master 右侧 |

## v2 模式（已交付 P0）

设置 `mode: "v2"` 切换到多 master 节点注册表（[spec](../../../.agents/specs/2026-09-24-coop-v2-multi-master-dag.md)）。P0 交付注册表层；plan/DAG、worktree、reviewer 门控与 memory 随后续阶段交付。

- **角色** —— `master` / `worker` / `reviewer` 注册到 `.dsh/coop/v2/registry.json`。master 铸造 `masterId`（`<slug>#<uuid>`）；worker/reviewer 以 `unbound` 落地。
- **独占绑定** —— `coop_bind` 在注册表写锁内领养 unbound 节点；绑定后该节点仅对该 master 可见（隔离靠可见性实现）。`coop_release` 将其退回 unbound 池；容量遵循 `maxWorkers` / `maxReviewers`。
- **Workspace 锚点** —— 节点自 session cwd 逐级向上找最近的 `.dsh/coop/workspace.json`，找不到则以 cwd 自身为 workspace。父目录只有通过 `/coop workspace init [path]` 才会成为 workspace —— 绝不静默创建。
- **命令** —— `/coop master|worker|reviewer [--master <id>] [--model <route>] [--any-cwd]`、`/coop list [--unbound]`、`/coop bind|release <sessionId>`、`/coop status`、`/coop off`、`/coop workspace init [path]`。
- **工具** —— `coop_register`、`coop_list`、`coop_bind`、`coop_release`、`coop_status`；v2 模式下不注册 v1 的十一个工具。
- **Worktree（P2）** —— `coop_worktree_create` 把 plan 的 `repoRoot` 通过 shell seam（git 一律走 `ctx.shell`，禁止裸 `child_process`）分支到 `<workspace>/wt/<masterId>/<seq>-<slug>`；目录名在全局 `wt-registry.json` 锁内占位，master 之间绝不撞车。调度器给被分派任务分配空闲 worktree（独占），并在唤醒信令里指名。`coop_worktree_merge` 用 `git merge --no-ff` 合回（base 移动或冲突 → `COOP_WORKTREE_MERGE_CONFLICT` fail-loud，绝不自动解冲突，§6.4）；`coop_plan_close` 先自动合并全部活跃 worktree；`coop_worktree_clean` 移除（`force` 丢弃改动）。
- **Reviewer 门控与升级（P3）** —— 激活现在经由评审：`coop_plan_submit_review`（designing → reviewing，唤醒被绑 reviewer）与 `coop_plan_review`（pass → active 并调度；request_changes → 回到 designing；与任务验证同构的 reviewer/allowSelfReview 门）。任务携带执行心跳（`coop_execute_touch`），静默超过 `executingStaleMs` 回落 rework；`hardDeadlineMs` 自首次分派计时，到期任务 blocked；`maxReworkAttempts` 耗尽的 `request_changes` 判定同样 blocked，并同时通知 worker 与 master。subagent 执行型任务会在分派信令中指示 worker 把任务 spec 委托给 sub-agent。
- **Herdr TUI 集成（P5a）** —— `coop_worker_create`（及 `/coop spawn worker|reviewer [--model <route>] [--workdir <dir> | --worktree <dir|branch>]`）自动创建节点：herdr 可达且 master 位于 herdr 窗格内时，新窗格按默认列布局切分（`spawnLayout: columns`：同角色窗格向本列底部堆叠；某角色首个窗格从 master 右侧插入一整列，列序跟随 spawn 顺序；布局由实时几何 + 各节点自报 pane id 归纳得出，无需持久状态），以 `--cwd` 锚定在节点的落点目录（worktree > workdir > workspace 根）并运行 `spawnCommand`，随后收到它的 `/coop <role> --master <id>` 注册行；coop 会轮询注册表直到该节点真实落地（期间每约 4 秒重发注册行，窗口 `spawnRegisterTimeoutMs`，超时 fail-loud 给出手动注册行），注册行携带 masterId 即预绑定，master 无需再发起 `coop_bind`。否则创建进程内 headless 会话并直接预绑定。每个 poll tick 把节点状态镜像进 herdr（`pane report-agent`/`report-metadata`，仅变化时调用），herdr 侧栏即节点卡片行。看板是独立的 `coop-board` Ratatui 插件（[herdr/coop-board](../../../herdr/coop-board/README.zh.md)）：`herdr plugin link <repo>/herdr/coop-board` 后 `herdr plugin pane open --plugin coop.board --entrypoint board` 打开 overlay（q/Esc 关闭，`d` 切换 DAG 视图）；窗格命令从插件根目录运行，请指向带 `/coop workspace init` 锚点的 workspace 或传显式根路径 —— 详见插件 README 的发现章节。
- **按角色固定 LLM 路由（roleLlm）** —— 配置 `roleLlm: { master|worker|reviewer: { provider, model, reasoningEffort? } }` 后，注册为对应角色的会话其每个 LLM 请求都改走该路由：本进程的 `agent/request` 监听器重写 provider/model/effort。`/coop master`、`/coop worker|reviewer` 注册即生效；`/coop spawn` 切出的 herdr 窗格收到注册行后同样生效（每个进程套用同一份部署配置），headless 节点还会在创建时直接带上该 provider/model。注册表 meta.model 记录生效路由；`/coop off` 解除。
- **Summarizer → memory（P4）** —— 每个通过验证的 task 与关闭的 plan 都会被确定性汇总进 master 的记忆轨 `v2/masters/<masterId>/memory.jsonl`（report 文本 + verify 结论作为 lessons），并镜像人读的 `memory.md`；追加按 `memoryRetainEntries` 压缩。`coop:memory` 提示段为该 master 的每个成员注入最新 `memoryInjectTopK` 条（仅时间倒序，§12.3）；针对性回忆用 `coop_memory_search`（关键词，按 master 隔离）。可选的 summarizer-model LLM 通道已延后 —— 确定性汇总对 report/verify 文本保持无损。
- **Plan 即 task DAG（P1）** —— `coop_plan_create`（绑定单一 `repoRoot`，§12.1）→ `coop_task_add`/`coop_task_link`/`coop_task_cancel`（plan 锁内环检测）→ `coop_plan_activate`。就绪度由 DAG 推导；调度器把 ready 任务分派给空闲的被绑定 worker（skill 需求 ⊆ 声明技能，`maxParallelTasks`），并用 `task assigned` 信令唤醒。worker 执行 `coop_execute_begin` → `coop_execute_report`；被绑定的 reviewer 用 `coop_task_verify` 验收（`pass` → done 且下游转 ready；`request_changes` → 同一 worker 返工）。`coop_board` 是看板投影；`coop_plan_close` 要求全部任务 done/cancelled；`coop_plan_abort` 取消开放任务并通知执行中的 assignee。Worktree、plan 评审门控、subagent 执行器与 memory 随 P2–P4 交付。

## 按角色固定模型（roleLlm）的完整配置

`roleLlm` 让 master / worker / reviewer 各自固定 provider + model + reasoningEffort。生效分两层，两层都要配：

**第一层：coop 的 `roleLlm`（请求层钉定，任何部署都生效）**

注册为某角色的会话，其每个 LLM 请求都被本进程的 `agent/request` 监听器重写到该路由；headless 节点创建时直接带上该 provider/model；生效路由记录在注册表 `meta.model`（看板/`/coop list` 可见）；`/coop off` 解除。校验 fail-loud：provider+model 必须成对非空、角色键只能是 master|worker|reviewer、effort 为非空字符串且档位由目标 provider 的 adapter 解释（非法档位回落 adapter 默认）。

**第二层：宿主 TUI 的启动路由对（让 dsh-tui 窗格“启动即”显示并使用角色模型）**

dsh-tui 新会话的启动路由解析为：配置里完整的 provider+model 对 > `~/.dsh-tui/model.json`（`/model` 拾取器的全局持久选择）> 内置默认。只配 `roleLlm` 时，新窗格状态栏会先显示 `/model` 选过的模型，第一条请求后才真正走角色路由。想让窗格从启动起就正确，在 profile patch 里给 `dsh-tui` 条目加一对**环境变量驱动的完整路由**：coop spawn 切窗格时会按 roleLlm 自动注入 `DSH_COOP_PROVIDER` / `DSH_COOP_MODEL` / `DSH_COOP_EFFORT`（经 `herdr pane split --env`），未注入的窗格（master/普通窗格）落在兜底值上。

完整的 `~/.dsh/profiles/<name>/cordis.patch.yml` 示例：

```yaml
- id: dsh-tui
  config:
    # A complete pair wins over the /model picker; panes without coop env
    # boot on the fallback (the master's default route).
    provider: !!js process.env.DSH_COOP_PROVIDER ?? 'zai-coding-cn'
    model: !!js process.env.DSH_COOP_MODEL ?? 'glm-5.3'
    effort: !!js process.env.DSH_COOP_EFFORT ?? 'max'
- insert:
  - id: coop
    name: '@deepseek-ai/dsh-coop'
    config:
      mode: v2
      spawn: auto
      spawnCommand: dsh --profile <name>
      roleLlm:
        master:   { provider: zai-coding-cn, model: glm-5.3, reasoningEffort: max }
        worker:   { provider: zai-coding-cn, model: glm-5.3-flash, reasoningEffort: high }
        reviewer: { provider: zai-coding-cn, model: glm-5.3, reasoningEffort: max }
```

行为说明：

- 前提是 provider 路由已存在（如 pi-ai 的 `llm-pi-ai.providers.<id>` 设置或对应 adapter）；模型 id 必须是该 provider 真实服务的 id。
- 钉了完整路由对之后，**新**会话不再跟随 `/model` 拾取器启动（会话内 `/model` 切换仍然有效）；roleLlm 在请求层始终是权威覆盖。
- 显式 `--model <route>`（spawn/注册参数）只写注册表 meta 并影响 headless 启动，不改 roleLlm 的钉定。
- 非 TUI 部署（web/headless）只需第一层；若宿主装配了 session-controller，注册时还会提交一次可见的模型选择并追加 `model/selection` 持久事件。

## 人类命令

`/coop role <master|worker> [--level L] [--any-cwd]`、`/coop role list [--all]`、`/coop role off`、`/coop plan notify <planId> [--worker <sessionId>]`、`/coop abort <planId> [--reason <text>]`。

## Model Experience

### Tool schema

#### 模型看到什么

模型看到生成的 [`coop_*` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-coop)：`coop_register`、`coop_list`、`coop_plan_create`、`coop_plan_notify`、`coop_pre_review`、`coop_execute_begin`、`coop_execute_report`、`coop_verify`、`coop_abort`、`coop_abort_ack`、`coop_status`。

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
- **跨进程投递基于轮询** — 信令在 session 启动时和每 1 秒的 inbox 轮询中被拾取；不引入推送通道或 fs watcher（v1 非目标），最坏情况为一个轮询周期的延迟。
