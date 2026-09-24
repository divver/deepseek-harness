# coop-board（herdr 插件）

[English](README.md) | 中文

dsh coop v2 workspace 之上的只读 Ratatui 看板 —— herdr coop 插件的 `board` 窗格（spec §8.4）。它自当前目录逐级向上寻找 `.dsh/coop/workspace.json` 发现 coop workspace（找不到则以 cwd 自身为准），读取 v2 共享注册表与 plan 文件，把全部 task 按状态分列渲染。看板绝不写入：操作仍走 dsh 的工具与命令。

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

## 按键

| 键 | 动作 |
|---|---|
| `q` / `Esc` | 退出 |
| `Tab` / `l` | 下一个 master |
| `BackTab` / `h` | 上一个 master |

看板约每 300 ms 从共享文件刷新一次；列为 task 状态（ready/assigned/executing/reporting/verifying/rework/blocked/done/pending），每张卡显示 task id、标题、assignee 与返工次数。
