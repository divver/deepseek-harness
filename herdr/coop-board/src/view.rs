//! Rendering layer: the layered dashboard chrome (workspace header totals,
//! master/plan sidebar, fleet strip, kanban columns) over the model snapshot.

use std::collections::HashMap;

use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph};
use ratatui::Frame;

use crate::app::{App, Panel};
use crate::model::{self, NodeCard, PlanView, Task};

/// Grouped v2 kanban columns: title, member statuses, accent color.
const COLUMNS_V2: [(&str, &[&str], Color); 7] = [
    ("ready", &["ready"], Color::Cyan),
    ("assigned", &["assigned"], Color::LightCyan),
    ("exec", &["executing", "reporting"], Color::Yellow),
    ("verify", &["verifying"], Color::Magenta),
    ("rework", &["rework", "blocked"], Color::LightRed),
    ("pend", &["pending"], Color::DarkGray),
    ("done", &["done", "cancelled"], Color::Green),
];

/// v1 columns: the linear 11-state plan workflow.
const COLUMNS_V1: [(&str, &[&str], Color); 11] = [
    ("draft", &["draft"], Color::DarkGray),
    ("pre-rev", &["pending_pre_review"], Color::Cyan),
    ("revise", &["needs_plan_revision"], Color::LightYellow),
    ("ready", &["ready_to_execute"], Color::LightCyan),
    ("exec", &["executing"], Color::Yellow),
    ("verify", &["pending_verify"], Color::Magenta),
    ("rework", &["needs_rework"], Color::LightRed),
    ("done", &["done"], Color::Green),
    ("closed", &["closed"], Color::LightGreen),
    ("aborting", &["aborting"], Color::Red),
    ("aborted", &["aborted"], Color::DarkGray),
];

/// Sidebar width, cells.
const SIDEBAR_WIDTH: u16 = 36;
/// Progress-bar width inside sidebar rows, cells.
const BAR_WIDTH: usize = 6;
/// Hard ceiling on DAG wave columns before they merge into a trailing bucket.
const DAG_MAX_COLUMNS: usize = 8;
/// Minimum gutter cells between DAG columns, reserved for dependency edges.
const DAG_MIN_GUTTER: u16 = 4;
/// One DAG card box: 2 border rows + 4 text rows, uniform so edge anchors line up.
const DAG_CARD_H: u16 = 6;

/// Motion glyph for one task status (OmO dag-widget convention: the
/// pre-running states stay visually distinct so a booting graph never reads
/// as a dead one).
fn task_icon(status: &str) -> &'static str {
    match status {
        "executing" | "reporting" => "▶",
        "assigned" | "verifying" => "◐",
        "ready" => "◌",
        "rework" => "↻",
        "blocked" => "⊟",
        "done" => "✓",
        "cancelled" => "⊘",
        "pending" => "·",
        _ => "○",
    }
}

/// Foreground color for one task status, shared by kanban cards and DAG cards.
fn task_color(status: &str) -> Color {
    match status {
        "executing" | "reporting" => Color::Yellow,
        "assigned" | "verifying" => Color::LightCyan,
        "ready" => Color::Cyan,
        "rework" | "blocked" => Color::LightRed,
        "done" | "cancelled" => Color::Green,
        _ => Color::Gray,
    }
}

/// Compact dep id for DAG tails: drop a `task-` prefix, keep 6 chars.
fn task_short(task_id: &str) -> String {
    let rest = task_id.strip_prefix("task-").unwrap_or(task_id);
    rest.chars().take(6).collect()
}

/// One-line liveness indicator colored by freshness.
fn liveness_span(age_ms: u64) -> Span<'static> {
    let (dot, color) = if age_ms <= model::STALE_MS {
        if age_ms > model::STALE_MS / 2 {
            ("●", Color::Yellow)
        } else {
            ("●", Color::Green)
        }
    } else {
        ("○", Color::DarkGray)
    };
    Span::styled(
        format!("{dot} {}", model::age_string(age_ms)),
        Style::default().fg(color),
    )
}

/// One fleet row: `w session · model · pane · ● age`.
fn node_line(node: &NodeCard, now: u64) -> Line<'static> {
    let mut spans = vec![
        Span::styled(
            format!("{} ", node.role_tag()),
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(model::short_id(&node.session_id)),
    ];
    if let Some(model_route) = &node.model {
        spans.push(Span::styled(
            format!(" · {model_route}"),
            Style::default().fg(Color::Blue),
        ));
    }
    if let Some(pane) = &node.pane_id {
        spans.push(Span::styled(
            format!(" · {pane}"),
            Style::default().fg(Color::DarkGray),
        ));
    }
    if !node.skills.is_empty() {
        spans.push(Span::styled(
            format!(" [{}]", node.skills.join(",")),
            Style::default().fg(Color::DarkGray),
        ));
    }
    spans.push(Span::raw(" · "));
    spans.push(liveness_span(node.age_ms(now)));
    Line::from(spans)
}

/// One fleet panel: master row first, then bound workers/reviewers.
fn fleet_lines(app: &App, now: u64) -> (String, Vec<Line<'static>>) {
    match app.selected_master() {
        None => (
            " fleet · no master ".to_string(),
            vec![Line::from(Span::styled(
                "no master registered",
                Style::default().fg(Color::DarkGray),
            ))],
        ),
        Some(master) => {
            let title = format!(
                " fleet · {} · {}w {}r · {} unbound in pool ",
                master.master_id,
                master.workers(),
                master.reviewers(),
                app.v2.unbound.len()
            );
            let mut lines = vec![Line::from(vec![
                Span::styled(
                    "m ",
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(format!("{} · ", master.display_name)),
                liveness_span(now.saturating_sub(master.heartbeat_at)),
            ])];
            lines.extend(master.nodes.iter().map(|node| node_line(node, now)));
            (title, lines)
        }
    }
}

/// Sidebar master row: liveness, id, fleet sizes.
fn master_line(master: &model::MasterView, now: u64) -> Line<'static> {
    Line::from(vec![
        liveness_span(now.saturating_sub(master.heartbeat_at)),
        Span::raw(" "),
        Span::styled(
            master.master_id.clone(),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(
                "  {}w {}r · {}p",
                master.workers(),
                master.reviewers(),
                master.plans.len()
            ),
            Style::default().fg(Color::Gray),
        ),
    ])
}

/// Sidebar plan row: id, title, progress bar (colored by status), worktrees.
fn plan_line(plan: &PlanView, selected: bool) -> Line<'static> {
    let style = if selected {
        Style::default().add_modifier(Modifier::REVERSED)
    } else {
        Style::default()
    };
    let status_color = match plan.status.as_str() {
        "active" => Color::Green,
        "reviewing" | "closing" => Color::Yellow,
        "designing" => Color::Cyan,
        "closed" => Color::DarkGray,
        "aborted" => Color::Red,
        _ => Color::Gray,
    };
    Line::from(vec![
        Span::styled("  ▸ ", style),
        Span::styled(
            format!("{} {}", model::plan_short(&plan.plan_id), plan.title),
            style.add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(
                " [{}] {}/{}",
                model::progress_bar(plan.totals, BAR_WIDTH),
                plan.totals.resolved(),
                plan.totals.total
            ),
            style.fg(status_color),
        ),
        Span::styled(
            if plan.worktrees > 0 {
                format!(" wt{}", plan.worktrees)
            } else {
                String::new()
            },
            style.fg(Color::Blue),
        ),
    ])
}

/// One kanban card: bold head line plus an assignee/attempts/worktree/age
/// tail. `tag` marks secondary statuses inside a grouped column (reporting,
/// blocked, cancelled).
fn task_card(task: &Task, plan: &PlanView, tag: bool) -> ListItem<'static> {
    let mut tail = String::new();
    if tag {
        tail.push_str(&format!("[{}] ", task.status));
    }
    if let Some(assignee) = &task.assignee {
        tail.push_str(&format!("→ {}", model::short_id(assignee)));
    }
    if task.attempts > 0 {
        tail.push_str(&format!(" · rw{}", task.attempts));
    }
    if let Some(worktree) = &task.worktree_id {
        tail.push_str(&format!(" · wt {worktree}"));
    }
    tail.push_str(&format!(
        " · {}",
        model::age_string(model::now_ms().saturating_sub(task.updated_at))
    ));
    ListItem::new(vec![
        Line::from(Span::styled(
            format!(
                "{}·{} {}",
                model::plan_short(&plan.plan_id),
                task.task_id,
                task.title
            ),
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            format!("  {tail}"),
            Style::default().fg(Color::Gray),
        )),
    ])
}

/// One v1 kanban card: a plan with its affine worker.
fn plan_card_v1(plan: &model::PlanV1) -> ListItem<'static> {
    ListItem::new(vec![
        Line::from(Span::styled(
            format!("{} {}", plan.plan_id, plan.title),
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            format!(
                "  {}",
                plan.assigned_worker_session_id.clone().unwrap_or_default()
            ),
            Style::default().fg(Color::Gray),
        )),
    ])
}

fn header(app: &App) -> Paragraph<'static> {
    let mode_badge = match app.mode {
        model::Mode::V1 => " [v1] ",
        model::Mode::V2 => " [v2] ",
    };
    let line2 = match app.mode {
        model::Mode::V2 => {
            let snap = &app.v2;
            let totals = snap.task_totals();
            format!(
                "{} masters · {} nodes ({} unbound) · {} plans ({} active) · {} tasks ({} done) · {} wt",
                snap.masters.len(),
                snap.bound_nodes(),
                snap.unbound.len(),
                snap.plans(),
                snap.active_plans(),
                totals.total,
                totals.done,
                snap.worktrees_active
            )
        }
        model::Mode::V1 => format!(
            "{} plan(s) · {} node(s)",
            app.v1.plans.len(),
            app.v1.nodes.len()
        ),
    };
    Paragraph::new(vec![
        Line::from(vec![
            Span::styled(" coop board ", Style::default().fg(Color::Cyan)),
            Span::styled(mode_badge, Style::default().fg(Color::LightMagenta)),
            Span::raw(app.workspace.display().to_string()),
            Span::styled(
                if app.mode == model::Mode::V2 && app.v2.anchored {
                    "  ·  anchored"
                } else {
                    "  ·  no anchor"
                },
                Style::default().fg(Color::DarkGray),
            ),
        ]),
        Line::from(Span::styled(line2, Style::default().fg(Color::Gray))),
    ])
    .block(Block::default().borders(Borders::BOTTOM))
}

fn footer(app: &App) -> Paragraph<'static> {
    let hint = match app.mode {
        model::Mode::V2 => match app.panel {
            Panel::Kanban => " h/l master · j/k plan · a all/one · d dag · q quit ",
            Panel::Dag => " h/l master · j/k plan · d kanban · q quit ",
        },
        model::Mode::V1 => " q quit ",
    };
    let hint = if app.has_v1 && app.has_v2 {
        format!(" v layout ·{hint}")
    } else {
        hint.to_string()
    };
    Paragraph::new(Line::from(Span::raw(hint.trim_end().to_string() + " ")))
        .block(Block::default().borders(Borders::TOP))
}

/// Draw one full dashboard frame.
pub fn draw(app: &mut App, frame: &mut Frame) {
    let now = model::now_ms();
    let area = frame.area();
    let rows = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .split(area);
    frame.render_widget(header(app), rows[0]);
    frame.render_widget(footer(app), rows[2]);

    let body =
        Layout::horizontal([Constraint::Length(SIDEBAR_WIDTH), Constraint::Min(0)]).split(rows[1]);

    match app.mode {
        model::Mode::V2 => {
            draw_sidebar_v2(app, frame, body[0], now);
            let right =
                Layout::vertical([Constraint::Length(fleet_height(app)), Constraint::Min(0)])
                    .split(body[1]);
            let (fleet_title, fleet) = fleet_lines(app, now);
            frame.render_widget(
                Paragraph::new(fleet)
                    .block(Block::default().borders(Borders::ALL).title(fleet_title)),
                right[0],
            );
            match app.panel {
                Panel::Kanban => draw_kanban_v2(app, frame, right[1]),
                Panel::Dag => draw_dag_v2(app, frame, right[1]),
            }
        }
        model::Mode::V1 => {
            let items: Vec<ListItem> = app
                .v1
                .plans
                .iter()
                .map(|plan| {
                    ListItem::new(vec![
                        Line::from(Span::styled(
                            format!("{} {}", plan.plan_id, plan.title),
                            Style::default().add_modifier(Modifier::BOLD),
                        )),
                        Line::from(Span::styled(
                            format!("  {}", plan.status),
                            Style::default().fg(Color::Gray),
                        )),
                    ])
                })
                .collect();
            frame.render_widget(
                List::new(items).block(Block::default().borders(Borders::ALL).title(" plans ")),
                body[0],
            );
            let right = Layout::vertical([
                Constraint::Length((app.v1.nodes.len() as u16 + 2).min(8)),
                Constraint::Min(0),
            ])
            .split(body[1]);
            let fleet: Vec<Line> = app
                .v1
                .nodes
                .iter()
                .map(|node| node_line(node, now))
                .collect();
            frame.render_widget(
                Paragraph::new(fleet)
                    .block(Block::default().borders(Borders::ALL).title(" nodes ")),
                right[0],
            );
            let cards: Vec<(String, ListItem<'static>)> = app
                .v1
                .plans
                .iter()
                .map(|plan| (plan.status.clone(), plan_card_v1(plan)))
                .collect();
            render_columns(frame, right[1], &COLUMNS_V1, cards);
        }
    }
}

/// Fleet strip height: title + master row + one row per bound node.
fn fleet_height(app: &App) -> u16 {
    (app.selected_master()
        .map(|master| master.nodes.len() + 1)
        .unwrap_or(1) as u16
        + 2)
    .min(10)
}

/// v2 sidebar: master rows with their plan children, then the unbound pool.
fn draw_sidebar_v2(app: &mut App, frame: &mut Frame, area: Rect, now: u64) {
    let selection = app.selection();
    let mut items: Vec<ListItem<'static>> = Vec::new();
    let mut selected_index: Option<usize> = None;
    for (master_idx, master) in app.v2.masters.iter().enumerate() {
        items.push(ListItem::new(master_line(master, now)));
        for (plan_idx, plan) in master.plans.iter().enumerate() {
            let is_selected = selection == Some((master_idx, plan_idx));
            if is_selected {
                selected_index = Some(items.len());
            }
            items.push(ListItem::new(plan_line(plan, is_selected)));
        }
    }
    if items.is_empty() {
        items.push(ListItem::new(Line::from(Span::styled(
            "(no masters)",
            Style::default().fg(Color::DarkGray),
        ))));
    }
    let pool_height = (app.v2.unbound.len() as u16 + 2).min(5);
    let split = Layout::vertical([Constraint::Min(0), Constraint::Length(pool_height)]).split(area);
    app.list_state.select(selected_index);
    frame.render_stateful_widget(
        List::new(items).block(Block::default().borders(Borders::ALL).title(" workspace ")),
        split[0],
        &mut app.list_state,
    );
    let pool: Vec<Line> = if app.v2.unbound.is_empty() {
        vec![Line::from(Span::styled(
            "(empty)",
            Style::default().fg(Color::DarkGray),
        ))]
    } else {
        app.v2
            .unbound
            .iter()
            .map(|node| node_line(node, now))
            .collect()
    };
    frame.render_widget(
        Paragraph::new(pool).block(
            Block::default()
                .borders(Borders::ALL)
                .title(format!(" unbound pool ({}) ", app.v2.unbound.len())),
        ),
        split[1],
    );
}

/// Take at most `max` chars of `s` (chars, not bytes: safe on wide glyphs).
fn trunc(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// DAG card content (OmO task-graph wireframe): name, `status · age`,
/// `→ assignee · model`, and a sparse footline (dangling deps, rework,
/// worktree). Padded to four rows so every box anchors edges uniformly;
/// `placed` carries the ids whose cards are on screen, so resolved deps rely
/// on drawn edges and only dangling ones stay on the footline.
fn dag_card_lines(
    task: &Task,
    models: &HashMap<String, String>,
    inner: usize,
    placed: &HashMap<&str, (u16, u16)>,
) -> Vec<Line<'static>> {
    let color = task_color(&task.status);
    let age = model::age_string(model::now_ms().saturating_sub(task.updated_at));
    let model_line = match &task.assignee {
        Some(assignee) => {
            let model = models
                .get(assignee)
                .map(|m| format!(" · {m}"))
                .unwrap_or_default();
            format!("→ {}{model}", model::short_id(assignee))
        }
        None => String::new(),
    };
    let mut foot: Vec<String> = Vec::new();
    let dangling: Vec<String> = task
        .depends_on
        .iter()
        .filter(|dep| !placed.contains_key(dep.as_str()))
        .map(|dep| task_short(dep))
        .collect();
    if !dangling.is_empty() {
        foot.push(format!("← {}", dangling.join(",")));
    }
    if task.attempts > 0 {
        foot.push(format!("rw{}", task.attempts));
    }
    if let Some(worktree) = &task.worktree_id {
        foot.push(format!("wt {worktree}"));
    }
    let name = if task.title.is_empty() {
        task_short(&task.task_id)
    } else {
        task.title.clone()
    };
    vec![
        Line::from(Span::styled(
            trunc(&name, inner),
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            trunc(&format!("{} · {}", task.status, age), inner),
            Style::default().fg(color),
        )),
        Line::from(Span::styled(
            trunc(&model_line, inner),
            Style::default().fg(Color::Gray),
        )),
        Line::from(Span::styled(
            trunc(&foot.join(" · "), inner),
            Style::default().fg(Color::DarkGray),
        )),
    ]
}

/// Paint a connector cell only where the canvas is still blank, so edges
/// pass behind cards instead of corrupting them.
fn paint(buf: &mut Buffer, clip: Rect, x: u16, y: u16, symbol: &str, style: Style) {
    if x < clip.x || y < clip.y || x >= clip.right() || y >= clip.bottom() {
        return;
    }
    if let Some(cell) = buf.cell_mut((x, y)) {
        if cell.symbol() == " " {
            cell.set_symbol(symbol);
            cell.set_style(style);
        }
    }
}

/// Orthogonal dependency edge (OmO task-graph wireframe): exit the source
/// card's right border, jog vertically inside the gutter lane, run flat into
/// the target row, and enter with a `>` head.
fn draw_edge(
    buf: &mut Buffer,
    clip: Rect,
    source_right: u16,
    source_y: u16,
    lane_x: u16,
    target_x: u16,
    target_y: u16,
    style: Style,
) {
    if source_y == target_y {
        for x in source_right..target_x {
            paint(
                buf,
                clip,
                x,
                source_y,
                if x + 1 == target_x { ">" } else { "─" },
                style,
            );
        }
        return;
    }
    let (corner_a, corner_b) = if target_y > source_y {
        ("┌", "┘")
    } else {
        ("┐", "└")
    };
    for x in source_right..lane_x {
        paint(buf, clip, x, source_y, "─", style);
    }
    paint(buf, clip, lane_x, source_y, corner_a, style);
    let (top, bottom) = if target_y > source_y {
        (source_y + 1, target_y)
    } else {
        (target_y + 1, source_y)
    };
    for y in top..bottom {
        paint(buf, clip, lane_x, y, "│", style);
    }
    paint(buf, clip, lane_x, target_y, corner_b, style);
    for x in (lane_x + 1)..target_x {
        paint(
            buf,
            clip,
            x,
            target_y,
            if x + 1 == target_x { ">" } else { "─" },
            style,
        );
    }
}

/// v2 DAG projection in the OmO task-graph style: topological waves as
/// left→right columns (a left→right read is a valid execution order), a
/// two-line header leading with the live wave, per-wave `done/total` titles,
/// rich cards (status · age, assignee · model, deps tail), and a `live`
/// ticker of in-flight tasks pinned to the bottom. Beyond `DAG_MAX_COLUMNS`
/// the trailing waves merge into one overflow column so narrow terminals
/// never collapse to nothing.
fn draw_dag_v2(app: &App, frame: &mut Frame, area: Rect) {
    let plan = match app.dag_plan() {
        Some(plan) => plan,
        None => {
            frame.render_widget(
                Paragraph::new("no master — register one with /coop master")
                    .block(Block::default().borders(Borders::ALL)),
                area,
            );
            return;
        }
    };
    let waves = model::dag_waves(&plan.tasks);
    let current = model::current_wave(&waves);
    let models: HashMap<String, String> = app
        .selected_master()
        .map(|master| {
            master
                .nodes
                .iter()
                .filter_map(|node| node.model.clone().map(|m| (node.session_id.clone(), m)))
                .collect()
        })
        .unwrap_or_default();
    let distinct_models = models
        .values()
        .collect::<std::collections::HashSet<_>>()
        .len();
    let running = plan
        .tasks
        .iter()
        .filter(|task| matches!(task.status.as_str(), "executing" | "reporting"))
        .count();
    let live: Vec<&Task> = plan
        .tasks
        .iter()
        .filter(|task| {
            matches!(
                task.status.as_str(),
                "executing" | "reporting" | "verifying" | "rework"
            )
        })
        .collect();
    let ticker_height = if live.is_empty() {
        0
    } else {
        (live.len().min(3) + 2) as u16
    };
    let rows = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(0),
        Constraint::Length(ticker_height),
    ])
    .split(area);
    let settled_header = current > waves.len();
    let mut status_line = format!(
        "wave {}/{} · {}/{} done · {running} running · {} waiting",
        current,
        waves.len(),
        plan.totals.resolved(),
        plan.totals.total,
        plan.totals.waiting
    );
    if distinct_models > 0 {
        status_line.push_str(&format!(
            " · {distinct_models} model{}",
            if distinct_models > 1 { "s" } else { "" }
        ));
    }
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(vec![
                Span::styled(
                    " Task Graph: ",
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("{} [{}] ", plan.title, plan.status),
                    Style::default().fg(Color::Gray),
                ),
                Span::styled(
                    format!("· {}", model::plan_short(&plan.plan_id)),
                    Style::default().fg(Color::DarkGray),
                ),
            ]),
            Line::from(Span::styled(
                status_line,
                Style::default().fg(if settled_header {
                    Color::Green
                } else {
                    Color::Yellow
                }),
            )),
            Line::from(Span::styled(
                "─".repeat(area.width as usize),
                Style::default().fg(Color::DarkGray),
            )),
        ]),
        rows[0],
    );
    if plan.tasks.is_empty() {
        frame.render_widget(
            Paragraph::new("(no tasks — add them from the master session)")
                .block(Block::default().borders(Borders::ALL)),
            rows[1],
        );
        return;
    }

    // Merge trailing waves beyond the column ceiling into one overflow bucket.
    let mut shown: Vec<(usize, Vec<&Task>)> = waves
        .iter()
        .enumerate()
        .take(DAG_MAX_COLUMNS)
        .map(|(wave_idx, wave)| (wave_idx + 1, wave.clone()))
        .collect();
    if waves.len() > DAG_MAX_COLUMNS {
        let merged: Vec<&Task> = waves[DAG_MAX_COLUMNS..].concat();
        if let Some(last) = shown.last_mut() {
            last.1.extend(merged);
        }
    }
    let overflow = waves.len() > DAG_MAX_COLUMNS;

    // Node-graph layout (OmO task-graph wireframe): one column per wave with
    // `Wave k` + `(done/total …)` headers, boxed cards stacked underneath,
    // and orthogonal dependency edges routed through the gutters. Cards are
    // ordered by the mean row of their placed dependencies so fan-outs stay
    // tight; edges only paint blank cells and pass behind cards.
    let graph = rows[1];
    let column_w = graph.width / shown.len().max(1) as u16;
    let card_w = column_w.saturating_sub(DAG_MIN_GUTTER).clamp(12, 24);
    let inner_w = card_w.saturating_sub(2) as usize;
    let pitch = DAG_CARD_H + 1;
    let mut card_at: HashMap<&str, (u16, u16)> = HashMap::new();
    let mut center_y: HashMap<&str, u16> = HashMap::new();
    let mut color_of: HashMap<&str, Color> = HashMap::new();
    for wave in shown.iter_mut().skip(1) {
        let mut keyed: Vec<(u64, usize, &Task)> = wave
            .1
            .iter()
            .enumerate()
            .map(|(slot, task)| {
                let anchors: Vec<u64> = task
                    .depends_on
                    .iter()
                    .filter_map(|dep| center_y.get(dep.as_str()).copied().map(u64::from))
                    .collect();
                let key = if anchors.is_empty() {
                    u64::MAX
                } else {
                    anchors.iter().sum::<u64>() / anchors.len() as u64
                };
                (key, slot, *task)
            })
            .collect();
        keyed.sort_by_key(|(key, slot, _)| (*key, *slot));
        wave.1 = keyed.into_iter().map(|(_, _, task)| task).collect();
    }
    for (index, (wave_no, wave)) in shown.iter().enumerate() {
        let x = graph.x + index as u16 * column_w;
        let is_current = *wave_no == current && current <= waves.len();
        let resolved = wave
            .iter()
            .filter(|task| matches!(task.status.as_str(), "done" | "cancelled"))
            .count();
        let settled = resolved == wave.len();
        let wave_running = wave
            .iter()
            .filter(|task| matches!(task.status.as_str(), "executing" | "reporting"))
            .count();
        let title_color = if is_current {
            Color::Yellow
        } else if settled {
            Color::Green
        } else {
            Color::DarkGray
        };
        let name = if overflow && *wave_no == DAG_MAX_COLUMNS {
            format!("Wave {wave_no}+")
        } else {
            format!("Wave {wave_no}")
        };
        let subtitle = if overflow && *wave_no == DAG_MAX_COLUMNS {
            format!("({})", wave.len())
        } else if settled {
            format!("({resolved}/{} done ✓)", wave.len())
        } else if wave_running > 0 {
            format!("({resolved}/{} done · {wave_running} running)", wave.len())
        } else {
            format!("({resolved}/{} done)", wave.len())
        };
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    name,
                    Style::default()
                        .fg(title_color)
                        .add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(subtitle, Style::default().fg(title_color))),
            ]),
            Rect {
                x,
                y: graph.y,
                width: column_w,
                height: 2,
            },
        );
        for (slot, task) in wave.iter().enumerate() {
            let y = graph.y + 3 + slot as u16 * pitch;
            if y + DAG_CARD_H > graph.bottom() {
                break;
            }
            card_at.insert(task.task_id.as_str(), (x, y));
            center_y.insert(task.task_id.as_str(), y + DAG_CARD_H / 2);
            color_of.insert(task.task_id.as_str(), task_color(&task.status));
            let lines = dag_card_lines(task, &models, inner_w, &card_at);
            frame.render_widget(
                Paragraph::new(lines).block(
                    Block::bordered().border_style(Style::default().fg(task_color(&task.status))),
                ),
                Rect {
                    x,
                    y,
                    width: card_w,
                    height: DAG_CARD_H,
                },
            );
        }
    }

    // Dependency edges: one wire per (dep → task) pair whose cards both fit
    // on screen; a source with several targets fans into successive gutter
    // lanes, and each wire takes the dep's status color.
    let lane_span = column_w.saturating_sub(card_w).saturating_sub(2).max(1);
    let mut lane_use: HashMap<&str, u16> = HashMap::new();
    for wave in &shown {
        for task in &wave.1 {
            for dep in &task.depends_on {
                let (Some(&(sx, sy)), Some(&(tx, ty))) = (
                    card_at.get(dep.as_str()),
                    card_at.get(task.task_id.as_str()),
                ) else {
                    continue;
                };
                if sx >= tx {
                    continue;
                }
                let used = lane_use.entry(dep.as_str()).or_insert(0);
                let lane = sx + card_w + 1 + (*used % lane_span);
                *used += 1;
                draw_edge(
                    frame.buffer_mut(),
                    graph,
                    sx + card_w,
                    sy + DAG_CARD_H / 2,
                    lane,
                    tx,
                    ty + DAG_CARD_H / 2,
                    Style::default().fg(color_of[dep.as_str()]),
                );
            }
        }
    }

    if !live.is_empty() {
        let items: Vec<ListItem> = live
            .iter()
            .take(3)
            .map(|task| {
                let model = task
                    .assignee
                    .as_ref()
                    .and_then(|assignee| models.get(assignee))
                    .map(|m| format!(" · {m}"))
                    .unwrap_or_default();
                ListItem::new(Line::from(vec![
                    Span::styled(
                        format!("{} ", task_icon(&task.status)),
                        Style::default().fg(task_color(&task.status)),
                    ),
                    Span::styled(
                        format!("{} · {}", task_short(&task.task_id), task.status),
                        Style::default().add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(model, Style::default().fg(Color::Gray)),
                ]))
            })
            .collect();
        frame.render_widget(
            List::new(items).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(format!(" live ({}) ", live.len())),
            ),
            rows[2],
        );
    }
}

/// v2 kanban: the selected plan, or every plan of the master merged (`a`).
fn draw_kanban_v2(app: &App, frame: &mut Frame, area: Rect) {
    let master = match app.selected_master() {
        Some(master) => master,
        None => {
            frame.render_widget(
                Paragraph::new("no master — register one with /coop master")
                    .block(Block::default().borders(Borders::ALL)),
                area,
            );
            return;
        }
    };
    let (title, cards): (String, Vec<(String, ListItem<'static>)>) = match app.selected_plan() {
        Some(plan) => (
            format!(
                " {} {} [{}] · {}/{} ",
                model::plan_short(&plan.plan_id),
                plan.title,
                plan.status,
                plan.totals.resolved(),
                plan.totals.total
            ),
            plan.tasks
                .iter()
                .map(|task| {
                    (
                        task.status.clone(),
                        task_card(task, plan, tagged(&task.status)),
                    )
                })
                .collect(),
        ),
        None if app.aggregate => (
            format!(
                " all plans · {} · {} tasks ",
                master.master_id, master.totals.total
            ),
            master
                .plans
                .iter()
                .flat_map(|plan| {
                    plan.tasks.iter().map(move |task| {
                        (
                            task.status.clone(),
                            task_card(task, plan, tagged(&task.status)),
                        )
                    })
                })
                .collect(),
        ),
        None => (format!(" {} — no plans ", master.master_id), Vec::new()),
    };
    let split = Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).split(area);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            title,
            Style::default().fg(Color::LightGreen),
        ))),
        split[0],
    );
    render_columns(frame, split[1], &COLUMNS_V2, cards);
}

/// Whether one status is a secondary member of its column (gets a card tag).
fn tagged(status: &str) -> bool {
    for (_, members, _) in &COLUMNS_V2 {
        if members.contains(&status) {
            return members[0] != status;
        }
    }
    false
}

fn render_columns(
    frame: &mut Frame,
    area: Rect,
    columns: &[(&str, &[&str], Color)],
    cards: Vec<(String, ListItem<'static>)>,
) {
    let layout = Layout::horizontal(
        columns
            .iter()
            .map(|_| Constraint::Ratio(1, columns.len() as u32))
            .collect::<Vec<_>>(),
    )
    .split(area);
    for (index, (title, members, color)) in columns.iter().enumerate() {
        let matched: Vec<ListItem> = cards
            .iter()
            .filter(|(status, _)| members.contains(&status.as_str()))
            .map(|(_, item)| item.clone())
            .collect();
        let count = matched.len();
        let list = List::new(matched).block(
            Block::default()
                .borders(Borders::ALL)
                .title(format!(" {title} ({count}) "))
                .border_style(Style::default().fg(*color)),
        );
        frame.render_widget(list, layout[index]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::App;
    use ratatui::backend::TestBackend;
    use std::fs;
    use std::path::PathBuf;

    fn fixture(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("coop-board-view-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let coop = dir.join(".dsh").join("coop");
        let write = |path: std::path::PathBuf, body: &str| {
            fs::create_dir_all(path.parent().expect("parent")).expect("dir");
            fs::write(path, body).expect("file");
        };
        write(
            coop.join("workspace.json"),
            r#"{"version":2,"root":"/ws","createdAt":1}"#,
        );
        write(
            coop.join("v2").join("registry.json"),
            r#"{"version":2,"entries":[
                {"sessionId":"m1","roles":["master"],"masterId":"one#aa","bindState":"bound","heartbeatAt":1},
                {"sessionId":"w1","roles":["worker"],"masterId":"one#aa","bindState":"bound","heartbeatAt":2,"meta":{"model":"glm-5.3","paneId":"w1:p1"},"skills":["rust"]},
                {"sessionId":"free","roles":["reviewer"],"bindState":"unbound","heartbeatAt":3}
            ]}"#,
        );
        write(
            coop.join("v2")
                .join("masters")
                .join("one#aa")
                .join("plans")
                .join("a1.json"),
            r#"{"version":2,"planId":"a1","title":"Ship it","status":"active","createdAt":1,"tasks":[
                {"taskId":"t1","title":"setup","status":"done","attempts":0,"createdAt":1,"updatedAt":2},
                {"taskId":"t2","title":"auth layer","status":"executing","assignee":"w1","worktreeId":"2-auth-layer","attempts":1,"createdAt":1,"updatedAt":3}
            ],"edges":[]}"#,
        );
        write(
            coop.join("v2").join("wt-registry.json"),
            r#"{"version":1,"entries":[{"dir":"/wt/1","masterId":"one#aa","planId":"a1","status":"active"}]}"#,
        );
        dir
    }

    fn render(app: &mut App, width: u16, height: u16) -> String {
        let backend = TestBackend::new(width, height);
        let mut terminal = ratatui::Terminal::new(backend).expect("terminal");
        terminal.draw(|frame| draw(app, frame)).expect("draw");
        let buffer = terminal.backend().buffer().clone();
        let mut out = String::new();
        for y in 0..height {
            for x in 0..width {
                out.push_str(buffer[(x, y)].symbol());
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn dashboard_renders_every_layer() {
        let dir = fixture("layer");
        let mut app = App::new(dir.clone(), false, true);
        let frame = render(&mut app, 160, 40);
        // workspace header layer
        assert!(frame.contains("coop board"), "title missing");
        assert!(frame.contains(
            "1 masters · 1 nodes (1 unbound) · 1 plans (1 active) · 2 tasks (1 done) · 1 wt"
        ));
        assert!(frame.contains("anchored"));
        // sidebar master + plan rows
        assert!(frame.contains("one#aa"));
        assert!(frame.contains("a1 Ship it"));
        assert!(frame.contains("wt1"));
        // fleet layer: master, bound worker with model/pane/skills
        assert!(frame.contains("glm-5.3"));
        assert!(frame.contains("w1:p1"));
        assert!(frame.contains("[rust]"));
        // unbound pool
        assert!(frame.contains("unbound pool (1)"));
        assert!(frame.contains("free"));
        // kanban: selected-plan title, done column, executing card with assignee and worktree
        assert!(frame.contains("a1 Ship it [active] · 1/2"));
        assert!(frame.contains("done (1)"));
        assert!(frame.contains("exec (1)"));
        assert!(frame.contains("→ w1 · rw1"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn aggregate_merges_every_plan_of_the_master() {
        let dir = fixture("agg");
        let mut app = App::new(dir.clone(), false, true);
        app.handle_key(ratatui::crossterm::event::KeyCode::Char('a'));
        let frame = render(&mut app, 160, 40);
        assert!(frame.contains("all plans · one#aa · 2 tasks"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn selection_highlights_the_plan_row() {
        let dir = fixture("sel");
        let mut app = App::new(dir.clone(), false, true);
        let frame = render(&mut app, 160, 40);
        assert_eq!(app.selection(), Some((0, 0)));
        assert!(frame.contains("▸ a1 Ship it"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dag_panel_renders_waves_and_dep_tails() {
        let dir = fixture("dag");
        let coop = dir.join(".dsh").join("coop");
        fs::create_dir_all(coop.join("v2").join("masters").join("one#aa").join("plans"))
            .expect("dirs");
        fs::write(
            coop.join("v2")
                .join("masters")
                .join("one#aa")
                .join("plans")
                .join("b1.json"),
            r#"{"version":2,"planId":"b1","title":"dag plan","status":"active","createdAt":1,"tasks":[
                {"taskId":"task-a","title":"root","status":"done","updatedAt":10,"dependsOn":[]},
                {"taskId":"task-b","title":"fan left","status":"executing","updatedAt":20,"assignee":"w1","dependsOn":["task-a"]},
                {"taskId":"task-c","title":"fan right","status":"ready","updatedAt":30,"dependsOn":["task-a"]},
                {"taskId":"task-d","title":"sink","status":"pending","updatedAt":40,"dependsOn":["task-b","task-c"]}
            ]}"#,
        )
        .expect("plan");
        let mut app = App::new(dir.clone(), false, true);
        assert_eq!(
            app.dag_plan().map(|plan| plan.plan_id.as_str()),
            Some("b1"),
            "newest active plan sorts first"
        );
        app.handle_key(ratatui::crossterm::event::KeyCode::Char('d'));
        let frame = render(&mut app, 160, 40);
        if let Ok(path) = std::env::var("COOP_BOARD_DUMP") {
            fs::write(path, &frame).expect("dump");
        }
        assert!(frame.contains("Task Graph:"), "wireframe title bar");
        assert!(
            frame.contains("wave 2/3 · 1/4 done · 1 running"),
            "status line leads with the live wave"
        );
        assert!(frame.contains("Wave 1"), "wave column header");
        assert!(frame.contains("(1/1 done ✓)"), "settled wave subtitle");
        assert!(
            frame.contains("(0/2 done · 1 running)"),
            "live wave subtitle"
        );
        assert!(frame.contains("──>"), "flat dependency edge into a card");
        assert!(frame.contains("└"), "elbow edge turning up into a card");
        assert!(
            frame.contains("→ w1 · glm-5.3"),
            "card resolves the assignee's model from the fleet"
        );
        assert!(
            frame.contains("live (1)"),
            "bottom ticker of in-flight tasks"
        );
        assert!(frame.contains("dag plan"), "plan title in the header");
        assert!(frame.contains("▶"), "executing motion glyph in the ticker");
        let _ = fs::remove_dir_all(&dir);
    }
}
