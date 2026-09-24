# coop-board (herdr plugin)

English | [中文](README.zh.md)

Read-only Ratatui kanban board over a dsh coop v2 workspace — the `board` pane of the herdr coop plugin (spec §8.4). It discovers the coop workspace by walking up for `.dsh/coop/workspace.json` (falling back to the cwd), reads the shared v2 registry and plan files, and renders every task grouped by status. The board never writes: operations stay in dsh tools and commands.

## Install and open

```sh
cargo build --release
herdr plugin link .
herdr plugin pane open --plugin coop.board --entrypoint board
```

Bind a key (for example prefix+b) in the herdr config:

```toml
[[keys.command]]
key = "prefix+b"
type = "plugin_action"
command = "coop.board.board"
```

## Keys

| Key | Action |
|---|---|
| `q` / `Esc` | quit |
| `Tab` / `l` | next master |
| `BackTab` / `h` | previous master |

The board refreshes from the shared files roughly every 300 ms; columns are task statuses (ready/assigned/executing/reporting/verifying/rework/blocked/done/pending) and each card shows the task id, title, assignee, and rework count.
