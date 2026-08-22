# Spec: 跨 Session 双角色协作插件 — dsh-coop (Master / Worker) v3

> 状态: Draft (proposed) · 作者: Muse Spark · 日期: 2026-08-21 v3
> 前置: v2 `2026-08-21-coop-master-worker-spec.md`（单 session 模型）→ 本版改为**同项目多 session**（用户实际用法：session-A 注册 master，session-B 注册 worker，同 cwd）
> 阅读前置: `docs/architecture.md`, `docs/subsystems/session.md`, `packages/core/session/src/index.ts`, `packages/core/agent/src/index.ts`

---

## 1. 概述 — 从 Session 作用域到 Workspace 作用域

`dsh-coop`（`@deepseek-ai/dsh-coop`，`packages/coop/coop`）提供**同项目（同 `cwd`）多 session 间的 Master/Worker 协作，且强制同 `cwd` 隔离**：同一 `cwd` 下的 master/worker 才能互信与通信，跨 `cwd` 的 session 即使同机也彼此不可见（见 §4.3 同目录约束）：

- **注册**：任意 session 通过 `/coop role master|worker` 或工具 `coop_register` 把**当前 session**注册为公共角色。角色不再是“本 session 日志里的快照”，而是**workspace 共享注册表** ` .dsh/coop/registry.json` 中的一条记录（`{ sessionId, roles, reviewLevel, updatedAt, heartbeatAt }`），同时双写一条 `coop/registry` 到**本 session 的 log**以满足可重放审计。`ctx.coop.listWorkspace()` 返回该项目全部存活 session 的角色集合。
- **计划与文档**：计划（`planId`）与 Markdown 文档是**workspace 共享实体**，落盘于 `.dsh/coop/plans/<planId>.json` + `.dsh/coop/docs/<planId>.md`，由 `CoopService` 原子写入（registry/plan 的读改写持 `withFileLock`，见 §7.2）。每个参与的 session 同时在自己 log 中追加对应的 `coop/plan-change|review|execution` 镜像事件，便于各自回放与 `sessionProjections` 观察，但**权威状态是共享文件**。
- **通知**：`Master → Worker` 与 `Worker → Master` 的通知是**跨 session**的，分两条路径。**快路径（同进程）**：对端 `Agent` 存活于 `ctx.agents` 时执行 `agent.followup(userMessage)`——`followup` 排队新 turn 并**唤醒 driver**（注意：`inject` 不唤醒，只适合补充上下文，不用于通知）。**慢路径（跨进程/离线）**：写文件信令 `.dsh/coop/inbox/<targetSessionId>.jsonl`（单调 `seq`），对端在 `agent/pre-step`、`session/created` 或 `/coop role` 注册时由 `CoopService` 消费水位之上的条目并转投**本端原生 Agent inbox**（`followup`）；投递与去重的回放事实落在原生 `agent/inbox/*` 事件链上，Coop 不自建第二套投递语义。两条路径都保证对端模型的下一条 `user/message` 可重建（`Model-visible ⟺ logged` 由原生 inbox 机制在对端 session 上成立）。被 `followup` 唤醒的 turn 是对端 transcript 中的真实一轮，`coop:policy` 措辞按“被唤醒后立即行动”设计。
- **角色职责**：`master = plan + verify`，`worker = pre-review + execute`，状态机 7 态不变，但状态迁移的**判定依据是共享文件**，不是单 session 日志折叠。

> 为什么需要共享文件：`SessionEvent` 是 per-session 追加日志，`session-A` 的 `coop/registry` 对 `session-B` 不可见；`ctx.sessions` 与 `ctx.agents` 仅在同进程内可枚举。若用户在两个终端各开一个 `dsh` 进程，内存广播失效，唯一共同事实是文件系统（项目 `cwd`）。

---

## 2. 目标 / 非目标

### 目标

- G1 同项目多 session 分别注册 `master`/`worker`，`registry.json` 为权威，`foldCoopRegistry` + 共享文件双重可重放。
- G2 Master 在 session-A `coop_plan_create` → 共享文件 + 本端 log，`coop_plan_notify` 跨 session 通知 session-B 的 Worker（快/慢双路径）。
- G3 Worker 在 session-B `coop_pre_review`（受 `reviewLevel` 约束）→ 更新共享状态 + 双端通知；`request_changes` 打回 Master。
- G4 Worker 执行后 `coop_execute_report` → `PENDING_VERIFY` + 通知 Master。
- G5 Master `coop_verify` → `DONE/CLOSED` 或 `NEEDS_REWORK` 通知 Worker；结论均追加到共享 md。
- G6 全流程经 `session/event`（各端镜像）与共享文件可观测，Web 侧可聚合 Conversation Node。
- G7 无人值守：唤醒后可自动驱动 `pre_review → execute → verify` 闭环（§6.2），无需人工介入。

### 非目标

- 跨项目/跨主机协作（仅同 `cwd` 共享 FS；跨机需另设同步层）。
- 强实时推送（首版不引入 WebSocket/RPC，总线就是 FS 信令 + 同进程 `followup`）。
- 多 plan 依赖图（首版多 plan 仅通过 `planId` 隔离）。

---

## 3. 术语

| 词 | 定义 |
|---|---|
| **Workspace** | 项目根 `cwd`，共享文件 `.dsh/coop/` 的锚点；所有 coop 状态以此为命名空间 |
| **Role** | `master \| worker`，可叠加；注册项为 `{ sessionId, roles, reviewLevel }` |
| **Master Session** | 注册了 `master` 的 session，owner 为 plan |
| **Worker Session** | 注册了 `worker` 的 session，执行方与第一道门控 |
| **SharedState** | `.dsh/coop/` 下 `plans/*.json` + `docs/*.md` + `registry.json` + `inbox/` 构成的 workspace 权威 |
| **Inbox（文件信令）** | `.dsh/coop/inbox/<sessionId>.jsonl`（单调 `seq`）+ `.consumed/<sessionId>`（消费水位）；仅作跨进程待投递事实，投递语义复用原生 Agent inbox |
| **Pre-review** | Worker 对 Master 计划的门控评审 |
| **Verify** | Master 对 Worker 执行结果的验收 |

---

## 4. 角色模型（Workspace 作用域）

### 4.1 注册语义（双写）与 Master 单例

- **权威**：`{cwd}/.dsh/coop/registry.json`，结构 ` { version:1, entries: { sessionId, roles:[], reviewLevel?, updatedAt, heartbeatAt, cwd, cwdScope }[] }`。读改写（注册/注销/心跳/单例检查）一律在 `withFileLock(registry.json)` 内完成——单例检查与写入必须同锁，否则跨进程 TOCTOU 可产生双 master。`cwdScope` 详见 §4.3。
- **镜像**：每次 `setRoles` 同时 `session.append('coop/registry', { roles, reviewLevel, updatedAt })` 到**本 session**，用于审计与 `foldCoopRegistry` 单测；跨 session 查询不读它，读共享文件。
- **发现**：`ctx.coop.listWorkspace(cwd)` 读共享文件（本地 + 全局 `any` 表）；`ctx.coop.getRoles(session)` 读共享文件中该 `sessionId` 的条目。共享 registry 文件缺失时抛 `COOP_REGISTRY_MISSING`（fail-loud）——静默回退本地折叠会让协作语义在 `.dsh/coop/` 被清理后悄悄退化，不可接受。
- **Master 单例**：同一 `cwd`（归一化后）**仅允许一个 `master` 角色**（含 `cwdScope==="any"` 的全局 master 也计入该 `cwd` 的单例检查）。`setRoles(..., {roles:["master"]})` 时若该 `cwd` 已存在另一 `sessionId` 的 `master` 且未过期/未注销，抛 `COOP_MASTER_ALREADY_EXISTS`（fail-loud），提示先 `/coop role off` 或等待过期。`worker` 不限数量。
- **生命周期**：`session/disposed` 时不自动删除条目（避免误判）。存活判定（两条件皆否才过滤）：条目 `heartbeatAt` 超过 `CoopConfig.staleMs` 未被持有端触碰；且 `sessionId` 不存在于 `ctx.sessionPersistence.list()` 返回的持久 header 集合中（跨进程枚举，live-preferred 合并先例见 subagent 列表实现）。提供 `/coop role off` 显式注销；master 崩溃后的抢占路径 = stale 判定成立后允许新 master 注册并替换该条目。v2 草案中的 `state.json` 过滤条件作废——该文件在仓库中不存在，存活事实以持久化 header 为准。
- **单人自检**：同一 session 可 `master+worker`（此为单例 master 的合法特例），共享文件中为同一 `sessionId` 同时含两角色，通知快路径退化为本 session 内 `followup`。

### 4.2 查询

- `ctx.coop.getRoles(session)` / `getReviewLevel(session)`：读共享文件（缺失抛 `COOP_REGISTRY_MISSING`，见 §4.1）。
- `ctx.coop.listWorkspaceRoles(): Map<SessionId, Role[]>`：供 `notify` 校验对端存在。

### 4.3 同目录约束（新增）与跨目录白名单

- **默认约束**：`master` 与 `worker` 仅在**同一 `cwd`（`session.header.cwd` 归一化后的绝对路径）**下可通信。`notify/broadcast` 时 `CoopService` 过滤 `registry.json` 条目，仅保留 `entry.cwd === caller.cwd` 的对端；跨 `cwd` 的 session 即使同机、工具参数合法，也**静默不可见**（`listWorkspace` 不返回，`broadcast` 不投递，`plan` 读写因 `docPath` 不在 `cwd` 内而被 `COOP_DOC_PATH_OUTSIDE_WORKSPACE` 拒绝）。
- **白名单注册**：任一端在注册时显式指定**不限目录**（`scope: any` / `allowAnyCwd: true`）即可与任意 `cwd` 的对端通信。需满足“至少一端为 `any`”即可跨目录（或收紧为“发起端为 `any`”——实现时以本节“至少一端”为准，若需更严可在 PR 中收紧并记录 Agent Note）。
  - 命令：`/coop role master --any-cwd` / `/coop role worker --any-cwd`（`--any-cwd` 为可选 flag，无则默认 `scope=cwd`）。
  - 工具：`coop_register({ roles, cwdScope: "any" | "cwd" })`（默认 `"cwd"`），鉴权后写入注册表。
  - 存储：`registry.json` 条目新增 `cwdScope: "cwd" | "any"`（默认 `"cwd"`）与 `cwd` 字段；`any` 条目写入**全局注册表** `${harnessHome}/coop/registry.json` 的同时仍写入本地 `{cwd}/.dsh/coop/registry.json` 以便离线回放；`listWorkspace(cwd)` 合并本地 + 全局表中 `cwdScope==="any"` 的条目。
  - 匹配规则：`canCommunicate(a,b) = normalize(a.cwd)===normalize(b.cwd) || a.cwdScope==="any" || b.cwdScope==="any"`。`broadcastToRole` 按此规则筛选目标 `sessionId`。
- **Plan 隔离**：跨目录通信时 `docPath` 仍需可被两端访问——`any` 模式下 `docPath` 解析为**发起端 `cwd` 下的绝对路径**，对端通过同一绝对路径读写（要求共享文件系统；网络盘属跨机场景，见非目标）。containment 由 `CoopService` 用 fs-local 的 `contains()` 自查（`ctx.fs` 不内建 workspace 检查）；`any` 模式无对称校验——创建时记录绝对路径与 `createdCwd`，对端打开时仅校验前缀属于 `createdCwd`。
- **安全**：`--any-cwd` 为显式 opt-in，默认不开启；`allowAnyCwd` 的注册需经 `tools/pre-execute` 权限校验（可选由 deployment 配置 `allowAnyCwdRoles: Role[]` 限制仅 master 或特定角色可声明全局）。

---

## 5. 命令与工具（语法不变，语义跨 session）

### 5.1 人类命令

| 命令 | 语义变化 |
|---|---|
| `/coop role <master\|worker> [--level ...] [--any-cwd]` | 写共享 `registry.json`（`cwdScope`）+ 本端 `coop/registry`；`--any-cwd` 声明跨目录可见（默认同目录）；`master` 受单例约束，已有 master 时抛 `COOP_MASTER_ALREADY_EXISTS` |
| `/coop role list [--all]` | 读共享注册表，列出可见的 master/worker sessions（默认仅同 `cwd`；`--all` 包含 `any` 条目） |
| `/coop role off ...` | 从共享表删除 + 追加本端注销镜像 |
| `/coop plan create ...` | Master（单例）写共享 `plans/<planId>.json` + `docs/<planId>.md` + 本端 `coop/plan-change{op:create}`；`plan` 含 `assignedWorkerSessionId` 亲和性见 §7.2 |
| `/coop plan notify <planId> [--worker <sessionId>]` | 校验共享表存在对端角色 → 绑定亲和 worker（首通知确定，后续沿用）→ 更新共享 plan `status→pending_pre_review` → **定向通知该 worker**（非广播，见 §6） |
| `/coop abort <planId> [--reason <text>]` | **Master 叫停**：更新共享 plan `status→aborting/aborted` → 定向通知已绑定 worker 立即停止（见 §6.2） |

### 5.2 模型工具（6+1，新增 cross-session 查询）

| 工具 | 跨 session 变化 |
|---|---|
| `coop_register` | 同上，双写；新增 `cwdScope?: "cwd"\|"any"`（默认 `"cwd"`），`any` 时跨目录可见；`master` 受单例约束 |
| `coop_list` | 读共享表（按 §4.3 过滤） |
| `coop_plan_create` | Master 单例写共享 plan+doc；生成 `assignedWorkerSessionId` 为空，`notify` 时绑定 |
| `coop_plan_notify` | 定向通知**已绑定 worker**（首通知可选 `--worker` 指定，否则自动选一，见 §6） |
| `coop_pre_review` | **仅已绑定的 worker**可执行；更新共享 plan，定向通知 Master |
| `coop_execute_report` | 仅已绑定 worker 可执行；同上 |
| `coop_verify` | 仅创建该 plan 的 Master 可执行；定向通知已绑定 worker |
| `coop_abort` | **仅创建者 Master 可执行**：`{ planId, reason?: string }` → `aborting→aborted`，定向叫停 worker |
| `coop_abort_ack` | **仅已绑定 worker 可执行**：确认已停止，`aborting→aborted` 闭环（如 worker 已自行感知可直接到 `aborted`） |
| `coop_status` | 读共享 `plans/<planId>.json`（含 `assignedWorker`） |

> 所有工具仍 `assertLive(agent)`，但状态校验读**共享文件**，`session.append` 仅作镜像；状态迁移失败抛 `COOP_INVALID_TRANSITION`。

---

## 6. 跨 Session 通知机制（快/慢双路径）

```
Master session-A                     Shared FS (.dsh/coop/)                Worker session-B (assigned)
   | coop_plan_notify(planId)  -->  plans/<planId>.json {status: pending_pre_review, assignedWorker: w1}
   | append coop/plan-change   -->  inbox/w1.jsonl {seq:N, kind:"notify", planId, docPath}   (慢路径信令，总是写)
   |--- w1 Agent 在 ctx.agents? --+
   |     是: agent.followup(msg) --->  唤醒 driver，新 turn 进入 w1 transcript（快路径）
   |     否: 信令留存，等对端活动
   |                                     on agent/pre-step | session/created | /coop role:
   |                                     CoopService.drainInbox(w1): 读 seq > 水位 → followup → 推进 .consumed/w1
```

- **投递语义复用原生机制**：`followup` 的消息经 `Agent` 的 durable inbox 落为对端 `agent/inbox/*` 事件，回放天然成立；Coop 只拥有“文件信令 → followup”这一步，不自建去重/回放协议。
- **水位竞态说明**：`inbox/<id>.jsonl` 只被投递端 append；`.consumed/<id>` 只被消费端原子重写推进。两者不相交，无丢消息窗口。消费后文件不删，超过 `CoopInboxCompactThreshold` 条且水位已越过时整体 compact 重写。

### 6.1 Worker 亲和性与定向通知

- **Worker 亲和性（新增约束）**：同一 `planId` **全生命周期绑定单一 worker**（`assignedWorkerSessionId`）。首 `coop_plan_notify` 时若 `plan.assignedWorker` 为空，则按 `workerSelector` 选定一个 worker 并持久化；后续所有 `pre_review / execute_report / verify` 的通知**仅定向该 worker**（与 Master 定向），不对其他 worker 广播。若项目注册了多个 worker，并发需 Master **拆分 plan**（创建多个 `planId` 各自绑定不同 worker），而非同一 `plan` 广播给多 worker。
  - 选择策略（首通知）：若 `--worker <sessionId>` 显式指定则用之（需校验该 session 为 worker 且满足 §4.3）；否则按 `CoopConfig.workerSelector`（`"earliest" | "round-robin"`，默认 `"earliest"`）由 `CoopService.pickWorker(cwd)` 选定。“负载最低”不做——首版没有跨进程的负载事实源。选定即持久化到 `assignedWorkerSessionId`。多 worker 并发模型不变：单 plan 单亲和 worker，并发靠 Master 拆 plan。
  - 校验：非已绑定 worker 调用 `coop_pre_review / coop_execute_report` 抛 `COOP_NOT_ASSIGNED_WORKER`；非创建该 plan 的 Master 调用 `coop_verify` 抛 `COOP_NOT_PLAN_OWNER`。
  - 重绑定：仅当已绑定 worker 已注销/过期且 plan 仍在 `NEEDS_*` 时，Master 可 `--reassign` 触发重新 `pickWorker`。
- **快路径**：`CoopService.notifyAssignedWorker(planId, text)` 仅对 `assignedWorker` 的 live Agent 执行 `agent.followup(...)`（唤醒，新 turn）；`Worker→Master` 通知同理仅对单例 Master 定向。
- **慢路径**：`fs.appendFile(inbox/<assignedWorker>.jsonl, {seq, ...})` 定向写入信令；跨进程/离线时由对端 `drainInbox` 消费水位之上的条目转投 `followup`。快慢路径共用同一信令行，投递成功与否以 `.consumed` 水位为准，不会重复注入。
- **幂等**：`planId + status` 去重，已处于 `pending_pre_review` 的重复 `notify` 为 `noop`（不切换 worker）。
- **离线校验**：首 `notify` 时若无可用 worker 抛 `COOP_NO_WORKER`；后续定向目标离线则仅留信令，不抛错（`allowNoWorker=true` 时允许自检，即 `assignedWorker` 为自身）。

### 6.2 Master 叫停 Worker

- **触发**：Master（仅创建者）执行 `coop_abort({planId, reason})` 或 `/coop abort <planId>`。允许状态：`pending_pre_review | ready_to_execute | executing | pending_verify | needs_rework`（即未 `done/closed/aborted` 时均可叫停）；终态抛 `COOP_INVALID_TRANSITION`。
- **迁移**：共享 `CoopPlanFile` 立即 `status→aborting`（持 plan 锁），追加 `history{op:"abort", reason}` 与 `coop/plan-change{op:"abort"}` 镜像；随后定向通知已绑定 worker：
  - 快路径：`agent.followup("[coop] ABORT plan <planId> reason:<reason> —— 请立即停止当前执行，清理现场并调用 coop_abort_ack")`，唤醒 worker 新 turn；
  - 慢路径：信令行 `{kind:"abort", reason}` 已随迁移写入，等对端 drain。
- **首版为 LLM 软停止**：中断手段只有 policy 提示 + 状态机。worker 的 LLM 收到 abort 消息后按 `coop:policy` 停止该 plan 的后续工具调用并 `coop_abort_ack`。plan→AbortController 的执行中断管线（对 executing 中的 shell/subprocess/workflow 按 planId 发 signal）需要新增 execution-registry 组件与能力层透传，推迟到 P4（见 §13），不阻塞协作主链。
- **Worker 响应**：调用 `coop_abort_ack({planId})` 将状态 `aborting→aborted`，追加 md `## Abort` 段与 `coop/review{phase:"abort"}` 镜像，并定向通知 Master。
- **超时闭环**：`aborting` 停留超过 `CoopConfig.abortAckTimeoutMs`（默认 120_000）后，Master 可单方面 `aborted`（幂等，重复 abort 直接闭环）——不依赖 worker ack 是否到达。

### 6.3 无人值守：唤醒 ≠ 自动执行

- **结论**：**只有唤醒不够**。`followup` 已保证对端被唤醒并看到通知（新 turn 进入 transcript），但**该 turn 是否会立刻调用 `coop_pre_review / coop_execute / coop_verify` 取决于模型的自主性**（受 `systemPrompt` 引导）。要达到**终态无人值守**，需在唤醒之上叠加**强引导或确定性的自动驱动**。
- **模式 A — LLM 驱动的无人值守（唤醒 + 强引导，首选）**：`CoopService` 经 `ctx.systemPrompt.section()` 注册 `coop:policy` 段（order 取与相邻插件一致的空闲值，无固定约定），内容为状态机与“被 coop 通知唤醒的 turn 必须立即调用对应工具”的强制指令。此时**唤醒即自动执行**，无需额外代码。优点零额外组件，缺点依赖模型遵从度。policy 措辞按 D8 语义写：对端看到的是 transcript 中一个被唤醒的新 turn，不是后台回调。
- **模式 B — 服务驱动的确定性自动执行（无人值守加固）**：新增配置 `autoDrive: { preReview: "llm"|"rule", execute: "tool"|"workflow", verify: "llm"|"auto" }`。当 `autoDrive.execute==="tool"` 时，`CoopService` 在 `PENDING_PRE_REVIEW` 被置为 `pass` 后**不等待 LLM**，直接通过 `ctx.tools`/`ctx.workflow` 调度执行（复用 `shell`/`code-runtime` 能力），完成后自动 `reportExecution` 并 `notifyMaster`；`verify` 同理可配为 `auto`（严格 `reviewLevel` 规则校验即过）。此模式下 LLM 仅负责 `pre_review/verify` 的判断，执行本身是确定性的。
- **推荐**：首版实现 **A（唤醒 + `coop:policy`）** 即可满足无人值守；若在 e2e 中发现模型不跟随，增量叠加 **B 的 `autoDrive.execute`**，二者在 `CoopConfig` 中正交。

---

## 7. 数据模型

### 7.1 SessionEventMap（per-session 镜像，4 种不变）

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'coop/registry': { roles: Role[]; reviewLevel?: ReviewLevel; updatedAt: number }
    'coop/plan-change': CoopPlanChange
    'coop/review': CoopReviewEvent
    'coop/execution': CoopExecutionEvent
  }
}
// 四个镜像事件追加时一律携带信封 ignorable: true（观察性事件，权威在共享文件）。
// 否则旧构建读到含 coop/* 的日志会按 required-on-read 拒绝重建整个 session，形成隐性全仓 lockstep 升级。
type Role = 'master' | 'worker'
type ReviewLevel = 'strict' | 'standard' | 'lenient'
type PlanStatus = 'draft' | 'pending_pre_review' | 'needs_plan_revision' | 'ready_to_execute' | 'executing' | 'pending_verify' | 'needs_rework' | 'done' | 'closed' | 'aborting' | 'aborted' // 7 态 + abort
```

### 7.2 Workspace 共享文件 Schema（权威）

```ts
// .dsh/coop/registry.json（per-cwd） + ${harnessHome}/coop/registry.json（global，存 any 条目）
interface CoopRegistryFile { version: 1; entries: { sessionId: string; roles: Role[]; reviewLevel?: ReviewLevel; updatedAt: number; heartbeatAt: number; cwd: string; cwdScope: "cwd" | "any" }[] }
// cwdScope 默认 "cwd"；"any" 表示该 session 愿与任意 cwd 通信，条目会在全局表与本地表双写

// .dsh/coop/plans/<planId>.json
interface CoopPlanFile {
  version: 1
  planId: string // Branded plan-<uuid>
  docPath: string // 绝对路径，指向 .dsh/coop/docs/<planId>.md
  title: string
  objective: string
  status: PlanStatus // 7 态 + aborting/aborted
  createdBy: string // master sessionId（单例校验：仅该 master 可 verify/abort/close）
  assignedWorkerSessionId?: string // 亲和 worker（首 notify 绑定，后续沿用；多 worker 时 master 需拆 plan）
  cwd: string // 归一化 cwd，用于同目录校验
  reviewLevel: ReviewLevel
  history: { time:number; sessionId:string; op:string; status:PlanStatus; summary?:string }[]
  execution?: { startedAt: number; heartbeatAt: number } // EXECUTING 心跳，供 executingStaleMs watchdog（§8）
  // 最新评审/执行摘要（冗余，便于 list）
  lastReview?: CoopReviewEvent
  lastExecution?: CoopExecutionEvent
}

// .dsh/coop/inbox/<sessionId>.jsonl  每行一条；seq 由投递端单调递增
interface CoopInboxEntry { seq:number; time:number; from:string; planId:string; kind:'notify'|'pre_review'|'verify'|'execution'|'abort'; summary:string; docPath:string; reason?:string }
// .dsh/coop/inbox/.consumed/<sessionId>  消费水位（已投递的最大 seq），仅消费端原子重写
```

- **文件 IO 分工**：plan/registry 读写走 `ctx.fs.writeText`（fs-local 内建原子发布）或 `writeFileAtomic`；inbox 追加与 md 追加显式走 `node:fs`——`FileSystem` seam 无 append 语义，Coop 是 workspace 私有文件，不需要 sandbox policy，不为追加扩 seam。docPath containment 由 `CoopService` 用 fs-local `contains()` 自查，不声称 ctx.fs 内建。
- **并发**：registry 与 plan 的读改写一律经 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` 在 Service 方法内部持锁完成“校验+迁移+落盘”；模型可见的工具调用永不收到“重试”指令。v2 草案的“rename 锁 + COOP_CONFLICT 重试”作废：原子 rename 下读者只见旧值或新值，rename 不是锁；把重试推给 LLM 是非确定循环。

---

## 8. 工作流状态机（共享状态驱动，7 态不变）

```
Master(单例, session-A)                     Worker(亲和, session-B=w1, 多 worker 需拆 plan)
  --coop_plan_create--> DRAFT (共享文件, assignedWorker=∅)
  --coop_plan_notify--> PENDING_PRE_REVIEW --定向 w1-->  w1 收到 user/message
                                    PENDING_PRE_REVIEW --coop_pre_review(pass, 仅 w1)--> READY_TO_EXECUTE
                                    PENDING_PRE_REVIEW --coop_pre_review(request_changes, 仅 w1)--> NEEDS_PLAN_REVISION --定向 Master--> Master
  NEEDS_PLAN_REVISION --coop_plan_create(update)--> DRAFT (Master 修改共享 md+plan, 仍绑定 w1)
  READY_TO_EXECUTE --(仅 w1 执行)--> EXECUTING --coop_execute_report(仅 w1)--> PENDING_VERIFY --定向 Master--> Master
  PENDING_VERIFY --coop_verify(pass, 仅创建者 Master)--> DONE→CLOSED
  PENDING_VERIFY --coop_verify(request_changes)--> NEEDS_REWORK --定向 w1--> w1
  -- 任意态(除 done/closed/aborted) --coop_abort(Master)→ ABORTING --定向 w1→ w1 abort_ack→ ABORTED
                                                          ABORTING --(ack 超 abortAckTimeoutMs, Master 幂等闭环)→ ABORTED
  EXECUTING --(execution.heartbeatAt 超 executingStaleMs, Master 触发)→ NEEDS_REWORK (可 reassign)
```

- watchdog 迁移由 Master 端在任意 coop 读操作时惰性检查（无后台定时器）；两个超时均为 `CoopConfig` 字段，非硬编码。worker 在 `EXECUTING` 中崩溃或 `ABORTING` 中失联都有确定性出路。

- 时序与 v2 一致，但**单 Master**（同一 `cwd` 仅一 master）+ **单 plan 绑定单 worker**（`assignedWorkerSessionId` 亲和性）；多 worker 并发需 Master 拆分为多 `planId` 各自绑定不同 worker。
- 每步的**状态判定读共享 `CoopPlanFile.status`**，`session.append` 仅作镜像，不作为下一次校验的依据。

---

## 9. 服务 API (`ctx.coop`)

```ts
interface CoopConfig {
  defaultReviewLevel?: ReviewLevel // 'standard'
  docRoot?: string                 // '.dsh/coop'
  allowNoWorker?: boolean          // false
  inboxPollMs?: number             // 1000, 供 fs.watch 降级轮询
  staleMs?: number                 // 默认 300_000；registry 条目存活窗口，超期且持久 header 无此 sessionId 才过滤/可抢占
  executingStaleMs?: number        // 默认 600_000；EXECUTING 心跳超时 → NEEDS_REWORK
  abortAckTimeoutMs?: number       // 默认 120_000；ABORTING ack 超时 → Master 幂等闭环 ABORTED
  workerSelector?: "earliest" | "round-robin" // pickWorker 策略，默认 "earliest"
  inboxCompactThreshold?: number   // 默认 256；水位越过后的信令文件 compact 阈值
  allowAnyCwdRoles?: Role[]        // 允许声明 any 的角色，默认 ["master","worker"]；设为空则禁止跨目录
  /** 无人值守自动驱动（§6.3）：未配置则为纯 LLM 驱动（A），配置后叠加确定性执行（B） */
  autoDrive?: {
    preReview?: "llm" | "rule" // 默认 "llm"（模型判断），"rule" 为按 reviewLevel 规则自动判定
    execute?: "tool" | "workflow" // 配置即启用服务侧自动执行；此时异 cwd 来源的 notify 一律拒绝投递（见 §12）
    verify?: "llm" | "auto" // 默认 "llm"
  }
}
class CoopService extends Service {
  static inject = ['agents','sessions','fs','sessionPersistence']
  // 角色（workspace + cwdScope + 单例）
  getRoles(session: Session): Role[]
  setRoles(agent: Agent, ops: {add?:Role[],remove?:Role[]}|{set:Role[]}, opts?: { cwdScope?: "cwd"|"any" }): Role[] // master 单例：重复注册抛 COOP_MASTER_ALREADY_EXISTS
  listWorkspace(cwd?: string): { sessionId: SessionId; roles: Role[]; cwd: string; cwdScope: "cwd"|"any" }[]
  canCommunicate(a: {cwd:string; cwdScope:"cwd"|"any"}, b: {cwd:string; cwdScope:"cwd"|"any"}): boolean // §4.3
  pickWorker(cwd: string): SessionId | undefined // 按 CoopConfig.workerSelector（earliest | round-robin）
  // 计划（共享 + 亲和性）
  createPlan(agent: Agent, req: CreatePlanRequest): CoopPlanFile // 仅单例 master 可创建
  notifyWorkers(agent: Agent, planId: string, opts?: { workerSessionId?: SessionId; reassign?: boolean; summary?: string }): void // 首通知绑定 worker，后续沿用；reassign 仅当原 worker 过期
  notifyMaster(agent: Agent, planId: string, summary?: string): void
  submitPreReview(agent: Agent, req: PreReviewRequest): CoopPlanFile // 仅 assignedWorker
  reportExecution(agent: Agent, req: ExecutionReportRequest): CoopPlanFile // 仅 assignedWorker
  verify(agent: Agent, req: VerifyRequest): CoopPlanFile // 仅创建者 master
  abortPlan(agent: Agent, req: { planId: string; reason?: string }): CoopPlanFile // §6.2 仅创建者 master，任意非终态 → aborting
  abortAck(agent: Agent, req: { planId: string }): CoopPlanFile // 仅 assignedWorker，aborting → aborted
  getPlan(planId: string): CoopPlanFile | undefined
  listPlans(cwd?: string): CoopPlanFile[]
  // 通知（定向）
  private notifyAssignedWorker(planId: string, text: string, kind?: CoopInboxEntry["kind"]): void
  private notifyMaster(planId: string, text: string, kind?: CoopInboxEntry["kind"]): void
  /** 读消费水位之上的信令条目，逐条 agent.followup 后原子推进 .consumed 水位；触发点见 §6 */
  private drainInbox(session: Session): void
}
```

---

## 10. 文档与共享文件关联

- `docPath` 默认 `.dsh/coop/docs/<planId>.md`，由 `CoopService` 统一管理；传入自定义路径需在**发起端 `cwd` 内**（`contains()` 自查），否则 `COOP_DOC_PATH_OUTSIDE_WORKSPACE`。`any` 模式下对端通过同一绝对路径访问（要求共享 FS），校验规则见 §4.3 Plan 隔离。
- 顺序：`writeFile(doc) → writeFile(plan.json) → append 本端 event → broadcast（按 §4.3 同目录规则筛选）`。
- md 锚点与 v2 一致（Objective/Plan/Pre-review/Execution/Verify/Changelog）。

---

## 11. 配置

```yaml
- id: coop
  name: '@deepseek-ai/dsh-coop'
  config:
    defaultReviewLevel: standard
    docRoot: .dsh/coop
    allowNoWorker: false
    inboxPollMs: 1000
    allowAnyCwdRoles: [master, worker] # 为 [] 则禁止任何 --any-cwd 注册
```

> **VCS 隔离**：`.dsh/coop/` 是机器本地的跨 session 共享状态（registry/inbox/plan 运行时状态），不应进入项目 VCS——随仓库提交会把一个环境的会话角色与待投递通知带给所有克隆者。`CoopService` 首次创建 `.dsh/coop/` 时确保项目 `.gitignore` 含 `.dsh/coop/` 条目（已含则跳过）；`docs/<planId>.md` 若用户希望版本化，由用户显式移出 `docRoot`（`docPath` 自定义路径本就支持）。

---

## 12. 边界与失败（新增跨 session 项）

- 无对端：`notify` 无可用 worker/master 且 `allowNoWorker=false` → `COOP_NO_WORKER`（筛选已含 §4.3 同目录 + 亲和性）。
- 单 Master：同一 `cwd` 已有 master 时再注册 master → `COOP_MASTER_ALREADY_EXISTS`；需先 `off` 或等待过期。
- 亲和性：非已绑定 worker 调用 `pre_review/execute_report/abort_ack` → `COOP_NOT_ASSIGNED_WORKER`；非创建者 master 调用 `verify/abort` → `COOP_NOT_PLAN_OWNER`；同 `planId` 不会同时分发给多 worker，并发需拆 plan。
- 叫停：已 `done/closed/aborted` 的 plan 再 `abort` → `COOP_INVALID_TRANSITION`；`aborting` 仅 worker 可 `abort_ack`，master 重复 `abort` 幂等；ack 超 `abortAckTimeoutMs` 后 Master 单方面闭环。
- 同目录隔离：跨 `cwd` 且双方均为 `cwdScope==="cwd"` 时，`listWorkspace` 与定向通知静默无匹配，`notify` 按“无对端”处理；`any` 方可见跨目录对端。
- 远程驱动隔离：`autoDrive.execute` 已配置时，依赖任一端 `cwdScope==="any"` 建立的跨 cwd notify **拒绝投递**并抛 `COOP_REMOTE_DRIVE_FORBIDDEN`——确定性自动执行不接受异项目触发（否则 any-cwd + autoDrive 组合构成远程代码执行原语）。纯 LLM 驱动（模式 A）下跨 cwd 通知仍允许。
- 跨进程：同 `cwd` 但不同 `dsh` 进程，快路径无 live Agent，信令留存；worker 下次活动 drain 后以新 turn 收到，属预期延迟。
- 并发：registry/plan 读改写在 `withFileLock` 内完成，模型侧无冲突态；锁等待超时抛 `COOP_LOCK_TIMEOUT`（不要求模型重试）。
- 离线：已绑定 worker 长时间离线，信令按 `seq` 水位消费、天然去重；EXECUTING 心跳超 `executingStaleMs` → NEEDS_REWORK，Master 可 `--reassign`。若 worker 已注销，同样走 reassign。
- registry 缺失：`.dsh/coop/registry.json` 不存在而调用任何 coop 查询/工具 → `COOP_REGISTRY_MISSING`（fail-loud，不回退本地折叠）。
- 权限：`cwdScope==="any"` 被 `allowAnyCwdRoles` 禁止时，`coop_register` 抛 `COOP_ANY_CWD_FORBIDDEN`。

---

## 13. 实现分步

| 步 | 内容 | 验证门 |
|---|---|---|
| P0 | registry + `withFileLock` + TOCTOU 安全的单例注册 + `/coop role` + `coop_register` + 双写 `coop/registry`（ignorable） | 单测：双进程并发注册 master 仅一成功；旧事件词汇构建可重建含 coop 事件的日志（ignorable 生效）；registry 缺失抛 `COOP_REGISTRY_MISSING` |
| P1 | Plan & Notify：`coop_plan_create/notify` + 共享 PlanFile + followup 快路径 + seq/水位慢路径 | keyless snapshot：examples/coop 双 session 完整 transcript（唤醒 turn 可见） |
| P2 | Worker gate+Execute：`coop_pre_review` + `coop_execute_report` + `reviewLevel` + md 追加 | snapshot 含非绑定 worker 被拒（`COOP_NOT_ASSIGNED_WORKER`）的 transcript |
| P3 | Master verify + abort 软停止 + watchdog + 投影：`coop_verify/abort/abort_ack`、两个超时闭环、`sessionProjections` | 单测：ABORTING ack 超时闭环；EXECUTING 心跳超时 → NEEDS_REWORK；snapshot 含 abort 全程 |
| P4（可选，独立 PR） | 执行中断管线：planId→AbortController execution-registry + tools/workflow signal 透传 + `autoDrive.execute` | e2e（需 key）：executing 中 abort 实际中断工具执行 |

每步同 PR 附 Agent Note；P1–P3 的 snapshot fixture 须在 macOS/Linux 可回放。

---

## 14. 迁移

- v2 单 session 模型可视为本版特例（同一 sessionId 既 master 又 worker，共享文件仅被本 session 读写，快路径即本端 `followup`）。
```
