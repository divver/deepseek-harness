# coop-board（herdr 插件）

[English](README.md) | 中文

dsh coop workspace 之上的只读 Ratatui 分层仪表盘 —— herdr coop 插件的 `board` 窗格（spec §8.4）。层次为 workspace → master → 节点 → plan → task 看板。它同时支持两种注册表布局：v2（`.dsh/coop/v2/`，逐 master 的 task DAG，卡是 task）与 v1（`.dsh/coop/`，线性 11 态 plan，卡是 plan）。发现逻辑向上寻找任一布局标记（优先 v2，两者共存时 `v` 切换），找不到则回退 cwd。看板绝不写入：操作仍走 dsh 的工具与命令。已在 herdr 0.9.1 上验证。

## 安装与打开

```sh
cargo build --release
herdr plugin link .
herdr plugin pane open --plugin coop.board --entrypoint board
```

在 herdr 配置里绑定按键（例如 prefix+b）：

```toml
[[keys.command]]
key = "prefix+b"
type = "plugin_action"
command = "coop.board.board"
```

## Workspace 发现与空看板

Herdr 以插件根目录为工作目录运行插件窗格命令，向上寻找从这里开始：插件根之上没有 `.dsh/coop/workspace.json` 锚点时，看板回退到插件目录，显示 `(no master)`，所有列保持空白 —— 这是全新安装的预期状态，不是崩溃。

要让看板显示真实数据：

1. 在目标 workspace 内的 dsh 会话里执行 `/coop workspace init`，写入 `<root>/.dsh/coop/workspace.json` 锚点（spec §3.1/§12.5 —— 看板绝不自建锚点）。
2. 在那里注册至少一个 master（`/coop master`）；plan 与 task 随 `.dsh/coop/v2/` 中的实际状态渲染。纯 v1 根不需要锚点 —— 看板直接探测 `.dsh/coop/registry.json`。
3. 或者直接带显式 workspace 根运行二进制 —— `target/release/coop-board /path/to/workspace` 完全跳过发现。

计划中：清单窗格命令应从 herdr 插件上下文（`HERDR_PLUGIN_CONTEXT_JSON`，聚焦 workspace 的 cwd）或 `COOP_WORKSPACE` 环境变量取 workspace，让看板跟随 herdr workspace 而不是插件根。

## 按键

| 键 | 动作 |
|---|---|
| `q` / `Esc` | 退出 |
| `Tab` / `l` | 下一个 master（仅 v2） |
| `BackTab` / `h` | 上一个 master（仅 v2） |
| `j` / `↓` · `k` / `↑` | 在侧栏选择 plan（跨 master 边界移动） |
| `g` / `G` | 第一个 / 最后一个 plan 行 |
| `a` | 看板在「选中 plan」与「该 master 全部 plan 合并」之间切换 |
| `d` | 右侧面板在状态看板与拓扑 DAG 视图之间切换（仅 v2，投影选中 plan） |
| `v` | 切换 v1/v2 布局（两者共存时） |

## 仪表盘分层（v2）

看板是对 workspace 的分层仪表盘，约每 300 ms 从共享文件刷新一次：

- **Workspace 头部** —— 根路径、锚点状态与 workspace 汇总：master 数、被绑定节点数、unbound 池大小、plan 数（active 数）、task 数（done 数）、活跃 worktree 数。
- **侧栏** —— master/plan 树。master 行显示存活状态（`●` 心跳年龄，随 5 分钟存活窗口由绿→黄→灰）、机队规模与 plan 数；plan 行显示按状态着色的进度条（`[▓▓▓░░░] done/total`）与活跃 worktree 数。plan 排序运行优先（active → reviewing → designing → 终态）。unbound 池块列在树下，展示可收编节点。
- **机队条** —— 选中 master 自身与每个被绑定 worker/reviewer：角色标记、短 session id、模型路由、herdr 窗格、声明技能与心跳存活。
- **看板** —— 选中 plan 的 task 卡片（`a` 切换为该 master 全部 plan 合并），归入七个工作流列（ready / assigned / exec+reporting / verify / rework+blocked / pending / done+cancelled）。卡片带 plan 前缀 id、标题、assignee、返工次数、worktree 与年龄；列内次要状态加 `[tag]` 标注。
- **DAG 视图（`d`）** —— 选中 plan 的 task 依 `dependsOn` 做 Kahn 拓扑分层，每个 wave 一列，从左到右即合法执行顺序。头部显示 `wave k/n` 与 done 计数；含活跃任务的 wave 标黄、全部终态的 wave 标绿。卡片用运动图标（▶ 执行中 / ◌ ready / ⊟ blocked / ✓ done / ⊘ cancelled），尾部列出 `← 依赖`、assignee、返工次数与年龄；悬空依赖忽略，环的剩余节点落入最后一列，超过 8 列时尾部 wave 合并为溢出列。参考 OmO herdr-dag 面板的行式布局语义。

v1 模式下侧栏列出 plan、机队条显示本地注册表、列为十一个 plan 状态且每卡是一个 plan；master 切换隐藏，因为 v1 每目录单 master。只读本地注册表 —— v1 的全局 any-scope 表（`~/.dsh`）不读取。

## 开发

`cargo test` 运行 model/app/view 三套测试：状态分桶、进度与年龄格式化、存活窗口、plan 排序、双布局的 fixture 加载、选择语义（跨 master 移动、reload 存活、合并模式），以及基于 ratatui `TestBackend` 的整帧渲染断言。
