# coop-board（herdr 插件）

[English](README.md) | 中文

dsh coop v2 workspace 之上的只读 Ratatui 看板 —— herdr coop 插件的 `board` 窗格（spec §8.4）。它自当前目录逐级向上寻找 `.dsh/coop/workspace.json` 发现 coop workspace（找不到则以 cwd 自身为准），读取 v2 共享注册表与 plan 文件，把全部 task 按状态分列渲染。看板绝不写入：操作仍走 dsh 的工具与命令。已在 herdr 0.9.1 上验证。

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
2. 在那里注册至少一个 master（`/coop master`）；plan 与 task 随 `.dsh/coop/v2/` 中的实际状态渲染。
3. 或者直接带显式 workspace 根运行二进制 —— `target/release/coop-board /path/to/workspace` 完全跳过发现。

计划中：清单窗格命令应从 herdr 插件上下文（`HERDR_PLUGIN_CONTEXT_JSON`，聚焦 workspace 的 cwd）或 `COOP_WORKSPACE` 环境变量取 workspace，让看板跟随 herdr workspace 而不是插件根。

## 按键

| 键 | 动作 |
|---|---|
| `q` / `Esc` | 退出 |
| `Tab` / `l` | 下一个 master |
| `BackTab` / `h` | 上一个 master |

看板约每 300 ms 从共享文件刷新一次；列为 task 状态（ready/assigned/executing/reporting/verifying/rework/blocked/done/pending），每张卡显示 task id、标题、assignee 与返工次数。
