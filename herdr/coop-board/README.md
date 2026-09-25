# coop-board (herdr plugin)

English | [中文](README.zh.md)

Read-only layered Ratatui dashboard over a dsh coop workspace — the `board` pane of the herdr coop plugin (spec §8.4). Workspace → masters → nodes → plans → task kanban. It supports both registry layouts: v2 (`.dsh/coop/v2/`, task DAG per master, cards are tasks) and v1 (`.dsh/coop/`, linear 11-state plans, cards are plans). Discovery walks up for either layout marker (v2 preferred, `v` toggles when both exist), else falls back to the cwd. The board never writes: operations stay in dsh tools and commands. Verified against herdr 0.9.1.

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
| `j` / `↓` · `k` / `↑` | select plan in the sidebar (crosses master boundaries) |
| `g` / `G` | first / last plan row |
| `a` | toggle the kanban between the selected plan and every plan of the master merged |
| `d` | toggle the right panel between the status kanban and the topological DAG view (v2 only; projects the selected plan) |
| `v` | toggle v1/v2 layout (when both exist) |

## Dashboard layers (v2)

The board is a layered dashboard over the workspace, refreshed from the shared files roughly every 300 ms:

- **Workspace header** — root path, anchor status, and workspace totals: masters, bound nodes, unbound pool size, plans (active), tasks (done), active worktrees.
- **Sidebar** — the master/plan tree. Each master row shows liveness (`●` age, green→yellow→gray as the 5-minute heartbeat window drains), fleet sizes, and plan count; each plan row shows a status-colored progress bar (`[▓▓▓░░░] done/total`) and its active-worktree count. Plans sort running-first (active → reviewing → designing → terminal). The unbound pool block lists adoptable nodes below the tree.
- **Fleet strip** — the selected master's own row plus every bound worker/reviewer: role tag, short session id, model route, herdr pane, declared skills, and heartbeat liveness.
- **Kanban** — task cards of the selected plan (or every plan of the master merged with `a`), grouped into seven workflow columns (ready / assigned / exec+reporting / verify / rework+blocked / pending / done+cancelled). Cards carry plan-prefixed id, title, assignee, rework count, worktree, and age; secondary statuses get a `[tag]` inside their column.
- **DAG view (`d`)** — the selected plan's tasks layered topologically (Kahn) over `dependsOn`, one column per wave; a left→right read is a valid execution order. The header shows `wave k/n` and done counts; the wave holding live work is highlighted yellow, fully settled waves green. Cards use motion glyphs (▶ executing / ◌ ready / ⊟ blocked / ✓ done / ⊘ cancelled) with a `← deps`, assignee, rework, and age tail. Dangling deps are ignored, a cycle's remainder lands in a final column, and beyond 8 columns trailing waves merge into one overflow column. Row semantics follow OmO's herdr-dag panel.

In v1 mode the sidebar lists plans, the fleet strip shows the local registry, and the columns are the eleven plan states with a plan per card; the master switcher is hidden because v1 has one master per directory. The local registry is read only — v1's global any-scope table under `~/.dsh` is not consulted.

## Development

`cargo test` runs the model/app/view suites: status bucketing, progress and age formatting, liveness windows, plan ordering, fixture-driven loading of both layouts, selection semantics (cross-master moves, reload survival, aggregate mode), and full-frame renders via ratatui's `TestBackend`.
