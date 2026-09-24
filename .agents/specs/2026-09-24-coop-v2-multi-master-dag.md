# Spec: dsh-coop v2 — 多 Master DAG 协作（Master / Worker / Reviewer × Worktree）

> 状态: Draft (proposed) · 日期: 2026-09-24 · 基于 v1（`2026-08-21-coop-cross-session-v3.md`，已实现 P0–P3）的实战反馈与 v2 方向草图
> 阅读前置: `docs/subsystems/coop.md`、`.agents/notes/implemented/architecture/2026-08-22-dsh-coop-shared-file-authority.md`、`packages/experimental/agent-team/README.md`、`packages/subagent/`、`packages/interaction/permission-presets/`、`packages/core/agent-loop/src/index.ts`

---

## 0. v1 → v2 的核心转变（为什么重写这些部分）

| 维度 | v1（已实现） | v2（本 spec） |
|---|---|---|
| Master 数量 | 同 cwd **单例** master | **多 master**，master 是隔离单位 |
| 可见性 | 同 cwd 全员互相可见 | **以 master 为命名空间**：worker/reviewer 一旦被某 master 绑定，只对该 master 可见 |
| 角色 | master / worker（worker 兼任 pre-review） | master / **worker** / **reviewer** 三分：master 规划+看板，reviewer 评审+验收，worker 执行 |
| 计划结构 | 单 plan 线性 11 态 | **plan = DAG**：task 节点 + 依赖边，串/并行由图推导，**任意时刻可动态加节点** |
| 代码隔离 | 所有 session 共享一个 cwd | **git worktree**：master 按需从既有分支创建 worktree，命名全局唯一 |
| 执行 | worker session 自己做 | worker 可**自建 sub-agent** 执行 task（inline 或 subagent 两种执行器） |
| 沉淀 | 无 | **summarizer → memory**：task/plan 完成后写结构化记忆，注入后续 session |
| GUI | 无 | header 插件（节点卡片/看板）+ 可选 terminal 多面板 |

v1 已验证并**保留**的资产：workspace 共享文件为权威 + 锁内迁移（`withFileLock`）、单路径信令投递（inbox jsonl + 水位线 + `Agent.followup` 唤醒）、心跳存活判定、镜像事件默认关、fail-loud 配置。v2 是在这些机制之上换掉**角色/计划/隔离**三层模型，不是推倒重来。

---

## 1. 概述

`dsh-coop` v2 把"一个 master 带一个 affine worker 走一条线性计划"扩展为**项目群（workspace）内多 master 并行、每个 master 独立拥有一张 DAG 计划、一组 worker/reviewer 和若干 git worktree** 的协作系统：

- **Workspace 锚点上移**：v1 的 coop 根是 `<project>/.dsh/coop`；v2 是**打开项目路径的父目录** `.dsh/coop/`（见 §3.1）。多个项目/worktree 是 workspace 下的兄弟目录，registry、plan、memory 都挂在 workspace 根，天然覆盖全部 worktree。
- **Master = 隔离单位**：所有工作内容（plan、task、worker、reviewer、worktree、memory）都属于且只属于一个 master（`masterId`）。两个 master 之间零共享、零可见——这是 v2 的不变式，等价于"多租户"。
- **节点自动创建与自动接线**：master 是默认的编排者（orchestrator）：它维护 task kanban，按 DAG 就绪度（入度为 0 的未完成 task）自动分派给空闲 worker；worker/reviewer 可以由用户**手动**在任何 dsh session 里创建，也可由 master **自动创建**（headless 后台 session）。手动创建的节点在 workspace registry 里"待领养"，被某 master 发现并绑定后，从此只对该 master 可见（§4.4）。
- **Design → Review → Plan(DAG) → Execute → Verify → Summarize** 是 v2 的主循环（§5–§8）。

> 仍然成立的底层事实（继承 v1 Agent Note）：跨进程的共同事实只有文件系统；投递只有一条路径（信令文件 + 同进程即时排水 + `followup` 唤醒）；`Agent.inject` 只补上下文不唤醒，不用于通知。

---

## 2. 目标 / 非目标

### 目标

- G1 多 master：同 workspace 任意数量 master 并存，互不可见，全部状态按 `masterId` 命名空间隔离。
- G2 三角色：master（规划/看板/编排）、worker（执行）、reviewer（plan 评审 + 执行验收），worker/reviewer 数量可配、可超配上限校验。
- G3 DAG 计划：task 节点 + `dependsOn` 边；调度器按图推导串/并行；**计划进行中任意时刻可增删节点/边**（锁内环检测）。
- G4 Worktree：master 从既有分支创建 worktree（命名唯一），task↔worktree 绑定，plan 收尾时统一合并/清理。
- G5 执行器：worker 按 task 声明 inline 执行或 spawn sub-agent 执行；sub-agent 失败/超时回落策略明确。
- G6 Memory：task/plan 完成触发 summarizer，写结构化记忆并可被后续 session 检索/注入。
- G7 Skill：任一节点（master/worker/reviewer，含 master 自动创建的）都能加载 skill；task 可声明所需 skill。
- G8 GUI：header 插件呈现节点卡片与 kanban；terminal 面板可选，未打开的节点以**后台 session**运行，可随时打开观察。
- G9 全程可观测：所有迁移双写（共享文件权威 + 本端镜像事件默认关，同 v1）。

### 非目标

- 跨主机/跨网段协作（总线仍是 workspace 文件系统；远程需另设同步层）。
- 强实时推送（无 watcher/WebSocket；跨进程延迟 = 一个 poll 间隔，同 v1）。
- 执行中断管道（v1 P4 依旧 deferred；abort 仍是状态机级软停 + 提示词级指令）。
- master 间协作/协商（多 master 之间**没有**任何协议；隔离即设计）。
- 跨 repo plan（v2 一个 plan 绑定一个 `repoRoot`，§12.1 裁决；wt-registry 仍记录 `repoRoot`，存储格式为将来放开预留）。
- worktree 的自动 merge 冲突解决（冲突时 fail-loud 交回人类，见 §6.4）。

---

## 3. Workspace 与 Worktree

### 3.1 Workspace 锚点：项目父目录

- 打开项目 `<parent>/<project>` 时，workspace 根 = `<parent>`，coop 根 = `<parent>/.dsh/coop/`。归一化规则沿用 `normalizeCwd`。
- 判定规则（就近匹配 + 显式 init，§12.5 裁决）：自当前 session `header.cwd` 起**逐级向上**查找最近的 `.dsh/coop/workspace.json`（`{ version: 2, root, createdAt }`），找到即归属该 workspace；找不到则以 cwd 自身为 workspace（退化为 v1 单项目行为）。**绝不静默在父目录创建 workspace**——要把父目录（或任意上级）设为 workspace，必须显式 `/coop workspace init [path]`（默认取父目录）落盘锚点文件。
- v1 数据（`.dsh/coop/registry.json` 等）不迁移：v2 全部落在新命名空间 `.dsh/coop/v2/`（§9 文件布局）。混版本同目录运行时，v2 忽略 v1 文件、v1 不识别 v2 子目录——镜像事件事故（见 v1 Agent Note follow-up）教训：靠目录版本化而非事件兼容。

### 3.2 Worktree 生命周期

- 创建：master 工具 `coop_worktree_create({ from: branch | HEAD, branch?, purpose })`。执行层通过 `ctx.shell`/subprocess 运行 `git worktree add`（禁止裸 `child_process`，走 shell seam）。worktree 一律来自其所属 plan 绑定的 `repoRoot`（§12.1 裁决）；`wt-registry` 条目记录 `repoRoot`。
- **命名唯一**：目录名 `<workspace>/wt/<masterId>/<seq>-<slug>`，`seq` 在 master 自己的计数器内单调；同时占位文件 `.dsh/coop/v2/wt-registry.json`（全局）记录 `dir → { masterId, branch, createdAt }`，写入在 `withFileLock` 内——保证跨 master 目录不撞车（masterId 前缀已隔离，锁防御的是同一 master 并发创建 + 目录扫描竞态）。
- 绑定：task 可声明 `worktreeId`；未声明时调度器在该 master 的空闲 worktree 池中分配（默认一 task 一 worktree，可配 `worktreeSharing: exclusive | pooled`）。
- 回收：plan 到达终态后 master 执行 `coop_worktree_{merge,clean}`：merge = `git merge --no-ff` 回目标分支（冲突 → `COOP_WORKTREE_MERGE_CONFLICT` fail-loud，task 打回 `needs_rework` 并附冲突文件清单）；clean = `git worktree remove` + 注销 wt-registry。
- 崩溃恢复：master 重启时扫描 wt-registry 中自己名下、但 plan 已终态的 worktree，提示/自动 clean（`orphanWorktreePolicy: prompt | auto-clean`）。

---

## 4. 角色模型 v2

### 4.1 三角色职责

| 角色 | 职责 | 默认权限预设 |
|---|---|---|
| **master** | design/plan（产出 DAG）、kanban 维护、worker/reviewer 发现与创建、分派调度、最终收尾（merge/clean）、summarizer 触发 | `coop-master`（可写共享文件、可 git、不可直接改 worktree 内容——只 merge） |
| **worker** | 领取就绪 task、自建 sub-agent 或 inline 执行、`execute_report` | `coop-worker`（worktree 内读写、shell、不可动 `.dsh/coop`） |
| **reviewer** | plan review（design 门控）、task verify（执行验收） | `coop-reviewer`（只读 worktree、可写共享评审文件） |

权限预设落在 `permission-presets` 服务（`ctx.permissionPresets.register`），随 master 的 agent-defaults（§7）下发。

### 4.2 注册与心跳（继承 v1 机制，键升级）

- `v2/registry.json`：`{ version: 2, entries: [{ sessionId, roles, masterId?, bindState, cwd, cwdScope, heartbeatAt, updatedAt, meta: { model, provider, pid, host } }] }`。
- 心跳、stale 判定（`staleMs`）、`touchOwnEntry` 节流全部沿用 v1 实现；poll 间隔 `inboxPollMs` 沿用。
- 与 v1 的差异：**没有 master 单例检查**；新增 `masterId` 与 `bindState`（§4.4）。

### 4.3 master 注册

- `/coop master` 或 `coop_register({ role: 'master' })` → 分配 `masterId = <slug>#<short-uuid>`，写 `v2/masters/<masterId>/profile.json`（创建时间、默认配置引用、状态 active）。
- master 退出（`/coop off` / stale 超时且无 plan 在跑）→ profile 标记 `retired`；其名下未终态 plan 进入 `orphaned`，可由同 sessionId 复活的 master 认领（`coop_adopt`）。

### 4.4 worker / reviewer：发现、创建与独占绑定

- **手动创建**：用户在任意 dsh session（TUI 或 headless）执行 `/coop worker|reviewer [--master <masterId>]`。不指定 master 时该节点处于 `bindState: "unbound"`，在 workspace registry 中**对全部 master 可见**（这是唯一的全局可见窗口）。
- **自动创建**：master 调 `coop_worker_create({ model?, workdir? })` → 在 master 进程内 `ctx.agentLoop.create(SessionId, { provider, model }, { cwd: worktree 或 workspace })` 建 **headless 后台 session**（durable、可被 TUI 稍后 attach，§8.3），注册为 `bindState: "bound"`。
- **绑定（adopt）**：master 的 poll loop 发现 `unbound` 节点（`coop_list --unbound` 亦可手动），`coop_bind({ sessionId })` 在 registry 写锁内把 `bindState → bound` 且写入自己的 `masterId`。**绑定即独占**：此后该节点对其他 master 的一切查询/投递不可见（`listWorkspace`、`broadcast`、plan 读写全部按 `masterId` 过滤）。同一 session 不可重复绑定（`COOP_NODE_ALREADY_BOUND`）。
- **解绑**：`/coop off`（节点侧）或 `coop_release`（master 侧，仅在节点 stale 或 plan 终态后允许）→ 回到 `unbound` 或注销。
- 数量上限：`maxWorkers` / `maxReviewers`（§7），bind 与 auto-create 双路径都校验，超限 `COOP_NODE_LIMIT_REACHED`。

---

## 5. 计划模型：plan = DAG

### 5.1 数据结构

`v2/masters/<masterId>/plans/<planId>.json`：

```
Plan {
  planId, masterId, repoRoot, title, objective, status,
  createdAt, createdBy,
  reviewLevel,                    // 沿用 v1 三档，作用于 plan review 与 task verify
  tasks: Task[],                  // 节点集
  edges: { from: taskId, to: taskId }[],   // from 完成后 to 才就绪
  history: [...],                 // 迁移审计（沿用 v1 append-only）
}
Task {
  taskId, title, spec,            // spec: 给 worker 的完整任务书
  status: pending | ready | assigned | executing | reporting | verifying | done | rework | blocked | cancelled,
  dependsOn: taskId[],            // 冗余于 edges，读优化；写入时由 edges 推导
  assignee?: sessionId, reviewer?: sessionId,
  worktreeId?, executor: 'inline' | 'subagent',
  skills?: string[],              // 声明所需 skill
  review?: { decision, summary, reviewerId },   // design review 结论（若有）
  verify?: { decision, summary, reviewerId, attempts },
  deadlines?: { softMs?, hardMs? },
}
```

### 5.2 状态机

- **plan 级**（简化，替代 v1 11 态）：`designing → reviewing → active → closing → closed | aborted`。`reviewing` 由 reviewer 的 plan review 驱动：`pass → active`；`request_changes → designing`（master 修订后重新提交评审，**返工环之一**）。
- **task 级**：`pending`（图未就绪）→ `ready`（`dependsOn` 全 `done`）→ `assigned`（调度器绑定 worker）→ `executing` → `reporting`（worker 报告完成）→ `verifying`（reviewer 验收）→ `done`；`verifying.request_changes → rework → executing`（**返工环之二**，`attempts` 递增，超 `maxReworkAttempts` 自动 `blocked` 交回 master）；`hard deadline` 超时 → `blocked`。
- 迁移原子性沿用 v1：一次迁移 = `mutatePlan` 锁内校验 + 写入 + inbox 信令 + （可选）镜像事件。模型侧永不见冲突、永不重试。

### 5.3 动态增删

- `coop_task_add / coop_task_update / coop_task_link({ from, to }) / coop_task_cancel` 在 plan **任意非终态**下可用；锁内做：环检测（新增边后 DFS）、受影响下游 task 的 `ready` 重算、history 记录。
- 加边成环 → `COOP_DAG_CYCLE_REJECTED`，附环路径。
- 删除仅限 `pending/blocked/cancelled` 节点；已 `assigned+` 的先 cancel（对 worker 发 `task_cancelled` 信令）。

### 5.4 调度器（master 内）

- 触发：task 状态迁移、worker 空闲信号（`execute_report`/`bind`）、`inboxPollMs` tick——三者都汇入同一个 `schedule()` 调用，`withFileLock(plan)` 内跑，保证串行决策。
- 规则：`ready` task × 空闲 worker，按 `priority`（默认拓扑序 + FIFO）匹配；worker 的 `skills` 能力集 ⊇ task 声明（不满足则跳过）；分派 = task `assigned` + `task_assigned` 信令（worker 被唤醒后自 `spec` 开始）。
- 并行度 = `maxParallelTasks`（§7）与 DAG 就绪度的较小者；串行计划就是链状 DAG 的特例，无专门代码路径。

---

## 6. 执行与验证

### 6.1 worker 执行

- worker 被唤醒后读 task `spec`，进入绑定 worktree 工作。
- `executor: 'subagent'`：worker 调 `subagent` 工具（dsh-tool-subagent）spawn sub-agent，objective = task.spec；subagent 完成/失败回填 worker，worker 整理后 `coop_execute_report({ taskId, summary, artifacts })`。一个 task 允许多个 subagent（实现细节自由），但对 master 只有一个 report。
- `executor: 'inline'`：worker 自己做完直接 report。
- 长任务心跳：executing 期间 worker 周期 `coop_execute_touch`（沿用 v1 executing watchdog；`executingStaleMs` 超时 → task `rework` + 重新分派）。

### 6.2 reviewer 验证

- **兼任门控（§12.4 裁决）**：默认 `review.allowSelfReview: false`——reviewer 必须是独立 session（手动或 master 自动创建）；配置开启后 master 可兼任 plan review 与 task verify，此时结论记录与 kanban 打 `self-review` 徽标，杜绝静默自审。
- task `reporting` → reviewer 收 `task_verify` 信令 → reviewer 在 worktree 内**只读**核查（diff、测试、spec 逐条对照）→ `coop_task_verify({ taskId, decision, summary })`。
- `pass → done`：下游 `ready` 重算、worker 归还空闲池、调度器续跑。
- `request_changes → rework`：report 摘要 + 修改要求写回 task，原 worker 优先复领（affinity 沿用 v1 思想，但按 task 而非 plan）。

### 6.3 plan review（design 门控）

- master `designing` 完成后 `coop_plan_submit_review` → reviewer 收信令 → 对 DAG 整体（objective 覆盖、依赖合理性、粒度、worktree 划分）出 `coop_plan_review({ decision })`。

### 6.4 收尾

- 全 task `done` → plan `closing`：master 逐 worktree merge（§3.2）、触发 summarizer（§7.4）、`closed`。
- 任一环节失败（merge 冲突、rework 耗尽）→ 受影响 task `blocked`，plan 停在 `active`，kanban 高亮，等待 master 决策（人工或模型）。

---

## 7. Master 的 agent-defaults 与 Memory

### 7.1 配置层次

`.dsh/coop/v2/workspace.json` 内 `defaults` + `.dsh/coop/v2/masters/<masterId>/config.json` 覆盖（后者胜）：

```
{
  agents: {
    master:   { provider, model, reasoningEffort },   // 例: glm-5.3 / max
    worker:   { provider, model, reasoningEffort },   // 例: glm-5.3-flash / high
    reviewer: { provider, model, reasoningEffort },   // 例: gpt-6-astre / medium
  },
  limits: { maxWorkers, maxReviewers, maxParallelTasks, maxReworkAttempts },
  permissions: { master: 'coop-master', worker: 'coop-worker', reviewer: 'coop-reviewer' },
  worktree: { sharing, orphanWorktreePolicy },
  review: { allowSelfReview: false },
  memory: { summarizerModel, retainEntries, injectTopK },
}
```

- 手动创建的节点注册时可带 `--model` 覆盖；master auto-create 默认取本层配置。model 字符串即 LlmAdapter 路由名，无新语义。
- 校验沿用 v1 fail-loud：未知枚举、非正数、超限在 load 时抛 `COOP_CONFIG_*`。

### 7.2 Skill 注入

- master/worker/reviewer 的 session 组合统一挂 `dsh-skill`；task `skills` 声明在分派信令中带给 worker，worker 按需 `skill` 工具加载。无新机制，只是组合约定 + 文档。

### 7.3 Kanban

- kanban 不是独立存储：它是 plan 文件的投影。`coop_board()` 按 task.status 分列返回；GUI（§8）与 TUI `/coop board` 都消费这个只读视图。

### 7.4 Summarizer → Memory

- 触发：task `done`（增量）与 plan `closed`（总结）。
- 执行者：master（或 `memory.summarizerModel` 指定的轻量模型，经一次独立 LLM 调用，输入 = spec + report + verify 摘要 + diff stat）。
- 落盘：`v2/masters/<masterId>/memory.jsonl`（append-only，`{ time, kind: 'task'|'plan', ref, title, summary, lessons[] }`）+ 同目录 `memory.md` 人读投影。
- 消费：
  - 注入：master/worker/reviewer session 组装时，`coop:memory` 系统提示段携带 `injectTopK` 条最近摘要（**时间倒序**，不做相关性算法，§12.3 裁决；workspace-instructions seam）；`coop:policy` 措辞要求接到新 plan/task 时先调 `coop_memory_search` 做针对性回忆。
  - 检索：工具 `coop_memory_search({ query, limit })`（前缀/关键词即可，v2 不做向量）。
- 隔离：memory 属于 master 命名空间，其他 master 不可见、不可检索。

---

## 8. GUI

### 8.1 Header 插件（P5）

- client UI 贡献一个 header 区 slot（`@deepseek-ai/dsh-client-ui-slots` 的 runtime props 注入）：workspace 内存在 active master 时显示**节点卡片行**——master 一枚 + 其名下 worker/reviewer 卡片（状态色：idle/executing/verifying/stale），点击卡片跳转该 session 的 conversation 视图。
- 数据源：host 侧消费 `ctx.coop.board/listNodes`（Typert remote method，hostBacked contribution 先例），不直读文件。

### 8.2 Kanban 视图（P5）

- plan 级 DAG/看板切换视图：列 = task 状态，卡 = task（assignee、worktree、attempts 徽标）。读侧只读，操作仍走工具/命令（GUI 不直接写共享文件）。

### 8.3 Terminal（可选）

- 节点 = session。master auto-create 的 worker/reviewer 是 headless durable session：**不打开就在后台跑**（coop 信令照常驱动），随时在 GUI/TUI 中 attach（resume 该 session 的 conversation 流）。
- 用户也可**手动**开多个终端窗口跑 `/coop worker` 等——手动/自动节点在 registry 里同构。
- v2 不做多路复用终端面板控件；"打开" = 现有 session 打开能力的复用。
- 交错语义（§12.2 裁决）：手动打开的 worker 里，用户输入与 coop 唤醒 turn 按 inbox 到达顺序 FIFO 排队；未提交 draft 不受影响、留到下一轮；coop turn 以 `[coop]` 来源标记呈现。不引入 inbox 优先级概念。

---

## 9. 文件布局（v2 命名空间）

```
<workspace>/.dsh/coop/
  workspace.json                      # 锚点 + 全局 defaults
  v2/
    registry.json                      # 全部节点（含 bindState/masterId）
    wt-registry.json                   # worktree 目录占用表（全局锁）
    inbox/<sessionId>.jsonl            # 信令（沿用 v1 格式与水位线机制）
    inbox/.consumed/<sessionId>
    masters/<masterId>/
      profile.json  config.json
      plans/<planId>.json  docs/<planId>.md
      memory.jsonl  memory.md
```

---

## 10. 工具与命令（模型面）

新增/替换（全部沿用 v1 的"一行紧凑结果 + CoopError 码"约定）：

- 角色：`coop_register{role, model?}`、`coop_list{--unbound}`、`coop_bind`、`coop_release`
- 编排：`coop_plan_create/submit_review`、`coop_task_add/update/link/cancel`、`coop_board`、`coop_adopt`
- 执行：`coop_execute_touch/report`、`coop_task_verify`
- worktree：`coop_worktree_create/merge/clean/list`
- memory：`coop_memory_search`
- 人类命令：`/coop master|worker|reviewer [--master <id>] [--model <route>]`、`/coop board`、`/coop off`、`/coop status [masterId]`

错误码新增：`COOP_NODE_ALREADY_BOUND`、`COOP_NODE_LIMIT_REACHED`、`COOP_DAG_CYCLE_REJECTED`、`COOP_WORKTREE_MERGE_CONFLICT`、`COOP_WORKTREE_NAME_TAKEN`、`COOP_NOT_YOUR_NODE`（跨 master 访问）。

---

## 11. 交付切分

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0 | v2 命名空间、registry v2（多 master、bind/unbind、masterId 过滤）、inbox 复用、`coop_bind/list` | 无（纯 v1 机制升级） |
| P1 | plan=DAG（结构、迁移、动态增删、环检测）+ master 调度器 + task 级信令 | P0 |
| P2 | worktree 全生命周期（create/bind/merge/clean/孤儿回收） | P0（不依赖 P1，可并行） |
| P3 | reviewer 双门控（plan review、task verify）+ subagent 执行器 + rework/deadline | P1 |
| P4 | summarizer→memory（写入、注入段、检索工具） | P1 |
| P5 | GUI：header 节点行、kanban、后台 session attach | P0–P3 的只读视图 |

每阶段独立可发布、可回退（v2 目录自包含）。P0+P1 = 最小可用（多 master DAG 串并行）；P2 起才需要 git 仓库项目。

---

## 12. 开放问题（2026-09-24 已裁决）

1. **跨 repo plan** → **v2 禁止**。plan 创建时绑定 `repoRoot`，全部 worktree 来自该 repo，merge 无顺序歧义；`wt-registry` 记录 `repoRoot`，存储格式为将来放开预留。
2. **worker TUI 与 coop 信令并发** → **FIFO**。唤醒 turn 与用户 turn 按到达顺序排队，未提交 draft 不受影响，coop turn 带 `[coop]` 来源标记；不引入优先级。
3. **memory 注入相关性** → **时间倒序 topK + 检索工具**。`coop:memory` 只注入最近 K 条；针对性回忆交给 `coop_memory_search`（`coop:policy` 要求接到新 plan/task 时先检索）。
4. **reviewer 可否由 master 兼任** → **配置控制，默认禁止**。`review.allowSelfReview: false`；开启后允许兼任，结论记录与 kanban 打 `self-review` 徽标。
5. **workspace 锚点** → **就近匹配 + 显式 init**。逐级向上找 `workspace.json`，找不到退化为 cwd 自身；父目录必须 `/coop workspace init` 显式声明，永不静默创建。
