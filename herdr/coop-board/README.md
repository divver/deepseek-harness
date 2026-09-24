# coop-board (herdr plugin)

English | [中文](README.zh.md)

Read-only Ratatui kanban board over a dsh coop workspace — the `board` pane of the herdr coop plugin (spec §8.4). It supports both registry layouts: v2 (`.dsh/coop/v2/`, task DAG per master, cards are tasks) and v1 (`.dsh/coop/`, linear 11-state plans, cards are plans). Discovery walks up for either layout marker (v2 preferred, `v` toggles when both exist), else falls back to the cwd. The board never writes: operations stay in dsh tools and commands. Verified against herdr 0.9.1.

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

## Workspace discovery and the empty board

Herdr runs plugin pane commands with the plugin root as the working directory, so the walk-up starts there: without a `.dsh/coop/workspace.json` anchor above the plugin root the board falls back to the plugin directory, shows `(no master)`, and every column stays empty — that is the expected state for a fresh install, not a crash.

To point the board at real data:

1. Anchor the workspace from a dsh session inside it: `/coop workspace init` writes `<root>/.dsh/coop/workspace.json` (spec §3.1/§12.5 — the board never creates one).
2. Register at least one master there (`/coop master`); plans and tasks then render as they exist in `.dsh/coop/v2/`. A v1-only root needs no anchor — the board detects `.dsh/coop/registry.json` directly.
3. Alternatively run the binary directly with an explicit workspace root — `target/release/coop-board /path/to/workspace` skips discovery entirely.

Planned: the manifest pane command should take the workspace from the herdr plugin context (`HERDR_PLUGIN_CONTEXT_JSON`, the focused workspace cwd) or a `COOP_WORKSPACE` environment variable, so the board follows the herdr workspace instead of the plugin root.

## Keys

| Key | Action |
|---|---|
| `q` / `Esc` | quit |
| `Tab` / `l` | next master (v2 only) |
| `BackTab` / `h` | previous master (v2 only) |
| `v` | toggle v1/v2 layout (when both exist) |

The board refreshes from the shared files roughly every 300 ms. In v2 mode the columns are task statuses (ready/assigned/executing/reporting/verifying/rework/blocked/done/pending) and each card shows the task id, title, assignee, and rework count. In v1 mode the columns are the eleven plan states (draft/pending_pre_review/needs_plan_revision/ready_to_execute/executing/pending_verify/needs_rework/done/closed/aborting/aborted) and each card is a plan with its assigned worker; the master switcher is hidden because v1 has one master per directory. The local registry is read only — v1's global any-scope table under `~/.dsh` is not consulted.
