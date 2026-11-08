# Spec: dsh-coop v2 — 质量门控（P0/P1/P2）与技能随包打包（bundled skills）

> 状态: Implemented（fb_coop_v2 · 2026-11-07，含三处实现偏差见 §9） · 日期: 2026-11-07 · 基于 coop v2 spec（`2026-09-24-coop-v2-multi-master-dag.md`，P0–P5a 已交付）与六步工作流需求
> 用户裁决（2026-11-07）: ① 质量门控做成**配置**（例 `P0=0, P1=0, P2<2`）；② master 终审**暂不加**；③ 所需技能**复制进 coop 包内 `skills/`**，随 tarball 分发。

---

## 0. 背景：六步工作流与现状映射

目标工作流：

```
1 建 worktree → herdr 打开 → 使用 coop
2 建 master + worker(+reviewer 可选)
3 master 分析需求→设计文档 → reviewer 审查 ⇄ master 修订（循环至无 P0）
4 master 建 plan(DAG) → 任务按 workflow 并发下发 worker
5 worker 执行 → reviewer 审查 ⇄ worker 返工（循环至无 P0）
6 修复完成后 master 核实（裁决：暂不实现，见 §2）
```

| 步骤 | coop v2 现状 | 结论 |
|---|---|---|
| 1 | `coop_worktree_create`、`coop_worker_create`（herdr 切 pane、`--cwd` 锚定落点）、coop-board 看板 | ✅ 已交付 |
| 2 | `/coop master`、`coop_worker_create role=worker\|reviewer`（注册行预绑定；`maxWorkers=4 / maxReviewers=2`；无 reviewer 时 master 自审为内建回退） | ✅ 已交付 |
| 3 | `coop_plan_create`（自带 markdown 轨迹）→ `coop_plan_submit_review` ⇄ `coop_plan_review` 循环 | ⚠️ 缺 **P0 分级与清零判据** → §1 |
| 4 | `coop_task_add(dependsOn, skills, assigneeSessionId)` + DAG 就绪度调度 + `maxParallelTasks` + skill 需求匹配（strict/fallback/off） | ✅ 已交付 |
| 5 | `coop_execute_report` → `coop_task_verify` ⇄ rework（`maxReworkAttempts` 耗尽 blocked） | ⚠️ 同 §1 |
| 6 | reviewer `pass` 直接 → done | ❌ 裁决暂不做 → §2 |

技能侧现状：节点可声明 `skills[]`（`/coop spawn --skills`、`coop_register`）、任务可声明 `skills[]` 需求、调度器匹配已实现；但三库技能（pstack / superpowers / matt-skills）需要用户自行安装，coop 包内不携带。→ §3 随包打包。

---

## 1. 质量门控：`qualityGate` 配置

### 1.1 配置形态

```yaml
- id: coop
  config:
    qualityGate:
      plan: { p0: 0, p1: 0, p2: 1 }   # plan 评审门（designing⇄reviewing 循环）
      task: { p0: 0 }                  # task 验收门（rework 循环）；缺省 { p0: 0 }
```

- 语义：**各档计数 ≤ 阈值才允许 `pass`**。`P2<2` 即 `p2: 1`。
- 每档键可省略 = 不设限（等价 `Infinity`）。`plan` 档缺省沿用 `task` 档值；两档都缺省 `{ p0: 0 }`（仅 P0 清零才过）。
- 校验 fail-loud：非负整数，非法键拒绝（沿用 `resolveCoopConfig` 风格）。

### 1.2 数据面与工具参数

- `coop_plan_review` / `coop_task_verify` 新增可选参数 `severityCounts: { p0: number, p1: number, p2: number }`（各档非负整数，缺省 0）。
- 结果落盘：`CoopV2Task.verify` 与 plan 的 `lastReview` 增可选字段 `severityCounts` 与 `gate`（当时门控快照），向后兼容。

### 1.3 门控判定（service 层，plan/task 写锁内）

`decision = 'pass'` 时：

1. 任一**受控档**（门控中为有限值的档）`counts > 阈值` → 抛 `COOP_GATE_EXCEEDED`，消息逐档列出对照（例 `quality gate exceeded: P0=1>0, P2=2>1`）。
2. 受控档**未提供** `severityCounts` → 抛 `COOP_GATE_COUNTS_REQUIRED`（迫使评审节点显式清点，防"没数就过"；缺省计 0 仅对未受控档合法）。

`decision = 'request_changes'` 永不受门控限制。`maxReworkAttempts` 耗尽 → blocked 升级 master 裁决（现状不变）。

新增错误码：`COOP_GATE_EXCEEDED`、`COOP_GATE_COUNTS_REQUIRED`。

### 1.4 分级定义与 policy 增补（`COOP_V2_POLICY_TEXT`）

- **P0** — 正确性 / 安全 / 数据丢失 / 与任务 spec 或计划 objective 背离；**P0>0 ⇒ 必须 `request_changes`**（与缺省门一致，即使部署放宽配置也写进 policy 作为模型侧纪律）。
- **P1** — 合并前应修（边界条件、缺测试覆盖、接口不一致）。
- **P2** — 次要（命名、注释、微小重复）。
- 增补句：评审/验收结论必须**逐条分级并清点**，`pass` 必须附 `severityCounts`；每条 finding 一行 `P<n>: <问题> → <要求>`。

### 1.5 非目标

- 不从 summary 自由文本解析计数（结构化参数已足够）。
- 不做 per-plan / per-task 门控覆盖（需要时再加）。
- master 终审不是门控的一部分（§2）。

---

## 2. master 终审 — 裁决：暂不实现

保持现状：reviewer `pass` → task `done` / plan `active`；无 reviewer 时 master 自审自验（v1 回退）。`allowSelfReview: true` 仍可用作人工兜底。未来若要加，方向存档：`V2TaskStatus` 增 `master_verifying`（reviewer pass → master 终审 → done），本 spec 不实现。

---

## 3. 技能随包打包：`packages/coop/coop/skills/`

### 3.1 目录与来源

- 位置：`packages/coop/coop/skills/<name>/SKILL.md`（技能同目录的 `references/`、`scripts/` 一并复制；skill-filesystem 只扫根顶层 `<name>/SKILL.md`，平铺无嵌套）。
- 来源三库均 MIT；新建 `skills/SOURCES.md` 记录每个技能的来源 repo / 路径 / 本仓是否有改动；pstack 上游为 `backnotprop/pstack`（cursor/plugins/pstack 镜像）。
- 新写一个自研技能 `coop-flow`（§4.3）。

### 3.2 装配（插件内挂隔离 provider）

插件启动时**若 `ctx.skills` 可用**：

```ts
ctx.plugin(SkillFileSystem, {
  providerName: 'coop',
  includeDefaultRoots: false,          // 隔离 provider：只见自己的根
  bundledSkillDir: join(pkgRoot, 'skills'),
  watch: false,                        // 随包内容不可变
})
```

- rank 600（bundled）、`trustedHost: true`；项目级(100)/用户级(400) 同名技能**胜出**——用户可整体覆盖 coop 自带副本（文档写明该覆盖关系）。
- `ctx.skills` 不可用 → 跳过注册并 log 一条，coop 核心功能不依赖技能（fail-soft）。
- 依赖：peerDependencies 增 `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-skill-filesystem`（标 optional，装配期探测）。

### 3.3 打包

`package.json` `files` 数组追加 `"skills"`；tarball 即携带全部技能，部署只装一个包。

### 3.4 复制清单（pstack 为主体）

| 角色 | 技能 | 来源 | 用途 | 触发方式 |
|---|---|---|---|---|
| master | `architect` | pstack | 跨边界改动先定 caller/类型/模块形状 | 手动 / policy 提示 |
| master | `how` / `why` | pstack | 子系统走查 / 决策考古（worker 也可用） | 手动 / policy 提示 |
| master | `sharpen` | pstack | 下发前把任务 prompt 写深 | 手动 |
| master | `ketchup` / `recall` | pstack | 向用户补课 / 续接上下文 | 手动 |
| master | `brainstorming` | superpowers | 需求澄清 + 设计期疑难（**用户手动选**，见 §4.1/§4.2） | 手动 |
| master | `grilling` | matt | 需求/设计面试（同上） | 手动 |
| worker | `tdd` | pstack | 开发任务主动 TDD | policy 提示 + 任务 `skills:['tdd']` |
| worker | `typescript-best-practices` | pstack | TS 类型纪律 | policy 提示 |
| worker | `figure-it-out` | pstack | 无 playbook 适配时的自查方法 | policy 提示 |
| worker | `no-comments` | pstack | 注释纪律（reviewer 共用） | policy 提示 |
| worker | `blast-radius` | pstack | 小改动波及面自查 | 手动 |
| worker | `diagnosing-bugs` | matt | 调试纪律（**唯一主动加载**的调试技能） | policy 提示（model-invoked） |
| worker | `systematic-debugging` | superpowers | 4 阶段根因（备用，**手动**） | 手动 |
| reviewer | `interrogate` | pstack | 对抗审查，结论须由运行证明 | policy 提示 |
| reviewer | `unslop` | pstack | 产出清洁 | policy 提示 |
| reviewer | `benchmark-checklist` | pstack | 数字审查 | 手动 |
| 全角色 | `handoff` | matt | 上下文硬限时写交接文档（`coop_handoff` 已引用） | coop 内建提示 |
| 全角色 | `reflect` | pstack | 任务/plan 后沉淀 | 手动 |
| 全角色 | `coop-flow` | 自研（新写） | 六步循环操作手册（§4.3） | policy 指定（唤醒即载） |
| 全角色 | `coop-help` | 自研（新写） | 技能路由器：按用户输入推荐该用哪个技能、该哪个角色加载（poteto-help 式，§4.5） | 手动（user-invoked） |

**排除**（及理由）：`poteto-mode` / `poteto-help`（单 agent 全路由模式，与角色划分模型冲突——其 playbook 思想进 `coop-flow`，help 式路由进 `coop-help`）；`arena` / `swarm`（并行改由角色节点 + DAG 承担，仅多 reviewer 时以"角色级并行"替代，见 §4.4）；`make-bot-ui` / `ketchup-video` / `statechart` / 形式验证系列（场景无关或依赖重，用户级自装）；matt 的 `tdd` / `teach`（与 pstack 重名，取 pstack 版）。

---

## 4. 角色 × 技能使用矩阵（pstack 在各角色合理可用）

### 4.1 触发方式三档

1. **手动** — 用户在对应 pane 里点名（`/skill load brainstorming`，或消息里说"用 grilling 过一遍需求"）。`brainstorming` / `grilling` 属此类：两者是交互式技能、需要人回答，而 master 是唤醒驱动的节点——`coop-flow` 写明暂停点：新 plan 需求澄清 → 停，等用户点名技能再继续。
2. **policy 提示** — `COOP_V2_POLICY_TEXT` 在对应时机点名：调试 → `diagnosing-bugs`（唯一主动加载；`systematic-debugging` 手动备用）；实现 → `tdd` / `typescript-best-practices`；验收 → `interrogate` / `unslop` / `no-comments`。
3. **任务声明** — `coop_task_add(skills:['tdd', …])` + 节点注册 `--skills tdd,…`，调度器 strict 匹配（现状机制，不改）。

### 4.2 矩阵速览

| 时机 | master | worker | reviewer |
|---|---|---|---|
| 需求澄清 | brainstorming / grilling（手动） | — | — |
| 设计 | architect / how / why；brainstorming / grilling（手动，设计期同样适用，含 request_changes 回炉后的疑难收敛） | — | how（对照实现） |
| 实现 | sharpen（下发前） | tdd / typescript-best-practices / figure-it-out | — |
| 调试 | — | diagnosing-bugs（主动）/ systematic-debugging（手动） | — |
| 审查/验收 | how / why（核实用） | no-comments（自查） | interrogate / unslop / no-comments / benchmark-checklist |
| 收尾 | ketchup / recall / reflect | reflect | reflect |
| 上下文硬限 | handoff | handoff（coop 内建提示） | handoff |

### 4.3 `coop-flow` / `coop-help`（自研，仅有的两个新写技能）

pstack playbook 风格的 master 操作手册，sections 按角色，装 `skills/coop-flow/`：

```
需求澄清（停：等用户点名 brainstorming|grilling）→ 设计文档写入 plan 轨迹
→ coop_plan_submit_review（severityCounts 逐档清点；P0>0 ⇒ request_changes 循环）
→ active → coop_task_add(DAG + skills + assignee) → 调度器并发分派
→ worker: execute_begin → TDD → execute_report
→ reviewer: coop_task_verify（门控判定，循环至过门）
→ coop_plan_close（自动合并 worktree）
```

worker/reviewer 段各一屏：被唤醒即做什么、加载哪个技能、counts 怎么报。

### 4.4 subagent 规则（用户设想 ①② 的落地）

- pstack 原"单 skill 多 subagent 并行"**整体角色化**：并行由多 worker 节点（DAG + `maxParallelTasks`）与多 reviewer 节点承担，不再是单节点内部 spawn 一队 subagent。
- **单 reviewer**：单线评审，不得再 spawn 评审 subagent（policy 明文）。
- **多 reviewer**（≤ `maxReviewers=2`）：角色级并行即"pstack 式并行"——两人各自审同一产出（可各持不同模型路由），master 汇总；先到的 `request_changes` 生效回炉，两人都过门才视为通过（以注册表内 review 记录去重，实现细节随门控一起落）。
- **worker 节点内部** subagent 仅限任务实现细节（`executor:'subagent'` 声明式，现状已支持），不用于评审。

### 4.5 `coop-help`（自研，手动路由器）

poteto-help 式：仅用户键入触发（`disable-model-invocation: true`）。按用户描述的目标，从 bundled 清单 + 角色矩阵（§3.4 / §4.2）里推荐：该用哪个技能、该由哪个角色加载，并给出一行可直接输入的提示；不执行任务本身。它是「手动选技能」的统一入口（含 brainstorming / grilling / systematic-debugging 的手动路径），也是新手上手指引。与 `coop-flow` 分工：路由 vs 流程手册。

---

## 5. Runbook（技能已随包，无需手工安装）

```bash
cd <proj> && git worktree add ../<proj>.coop -b coop-demo
cd ../<proj>.coop && herdr          # master pane 运行 dsh（profile: mode v2 + roleLlm）
```

```
/coop workspace init .
/coop master
coop_worker_create role=reviewer --skills interrogate,unslop,benchmark-checklist
coop_worker_create role=worker   --skills tdd,diagnosing-bugs,typescript-best-practices
```

六步循环由 `coop-flow` 驱动；看板 `herdr plugin pane open --plugin coop.board --entrypoint board`（`d` 出 DAG）。

---

## 6. 实现改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/service.ts` | Config/Schema 增 `qualityGate`（plan/task 两档）；`reviewPlanV2` / `verifyTaskV2` 门控判定；counts+gate 快照落盘；新错误码 |
| 2 | `src/tools.ts` | `coop_plan_review` / `coop_task_verify` 增 `severityCounts` 参数；门控错误文案 |
| 3 | `src/policy.ts` | V2 文本增补：P0/P1/P2 定义、清点义务、技能点名（§4.1 第 2 档）、单 reviewer 禁评审 subagent |
| 4 | `src/index.ts`（插件装配） | `ctx.skills` 可用时挂 `SkillFileSystem` 隔离 provider（§3.2） |
| 5 | `skills/` | 按清单复制 + `SOURCES.md` + 新写 `coop-flow` / `coop-help` |
| 6 | `package.json` | `files` += `"skills"`；peerDeps += dsh-skill(-filesystem) optional |
| 7 | `README.md` / `README.zh.md` | 配置表 + 覆盖关系 + 角色矩阵 |
| 8 | `tests/v2.spec.ts` | 门控用例（§7） |

## 7. 验收标准

- 门控 `{p0:0,p1:0,p2:1}`：`pass`+`p2=2` → `COOP_GATE_EXCEEDED`；`pass` 无 counts → `COOP_GATE_COUNTS_REQUIRED`；`p0=1` → 拒；`request_changes` 恒过；plan 门与 task 门独立生效。
- 全新 profile 仅装 coop tarball：`/skill` 列表可见全部 bundled 技能；用户级同名技能可覆盖。
- 六步 runbook 人工走通（含多 reviewer 并行审查一轮）。

## 8. 开放问题

- 多 reviewer "都过门才算过"的汇总语义（§4.4）随门控实现细化，可能需要 plan/task 增 per-reviewer 记录。
- `coop-flow` 是否按角色拆三份（先合一，读时分段）；`coop-help` 与其分工：路由 vs 流程手册。
- severityCounts 是否镜像到 coop-board 展示（暂缓）。

## 9. 实现偏差（交付时裁决）

1. **qualityGate 缺省档语义细化**（§1.1）：整体未配置时两门均为 `{ p0: 0 }`；任一门显式给出后，该门未列出的档 = 不设限（`Infinity`），但 `plan` 门未列出的档**沿用 task 门解析值**。落盘的 gate 快照只含受控档（避免 `Infinity` 序列化）。
2. **bundled 装配不走 SkillFileSystem**（§3.2）：改为包内自带轻量 provider（`src/bundled-skills.ts`，解析 frontmatter + `ctx.skills.registerProvider`），依赖面更小 —— 只新增 optional peer `@deepseek-ai/dsh-skill` + 直接依赖 `yaml`。**挂载点为 `ctx.root`**：cordis 里从插件构造器 `ctx.inject` 注册会落进本插件 fiber 的 scope 层，兄弟会话不可见；挂到组合根（非 scoped）才落全局层、全进程可见，并随 coop dispose 一并卸载。
3. **六个 vendored 技能移除 `disable-model-invocation: true`**（§3.4）：`tdd`、`typescript-best-practices`、`figure-it-out`、`interrogate`、`unslop`、`no-comments` —— policy 唤醒即载需要 model-invocable（上游是 poteto-mode 手动 UX 的选择）；记录于 `skills/SOURCES.md`。

验证：`tests/v2-quality-gate.spec.ts`（6 例）+ `tests/bundled-skills.spec.ts`（4 例，含真实 SkillRegistry 集成）+ 全 coop 套件 151 通过；`pnpm pack` tarball 含 62 个 `skills/` 文件。
