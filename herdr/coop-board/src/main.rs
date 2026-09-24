//! Read-only coop kanban board (Ratatui), the `board` pane of the herdr coop
//! plugin. Supports both registry layouts: v2 (`.dsh/coop/v2/`, task DAG per
//! master) and v1 (`.dsh/coop/`, linear 11-state plans — cards are plans, not
//! tasks). Discovery walks up for either layout marker (v2 preferred, `v`
//! toggles when both exist), else falls back to the cwd. The board never
//! writes: operations stay in dsh tools/commands (spec §8.4).

use std::{env, io, path::PathBuf, time::Duration};

use ratatui::{
    crossterm::{
        event::{self, Event, KeyCode, KeyEventKind},
        terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
        ExecutableCommand,
    },
    layout::{Constraint, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph},
};
use ratatui::{backend::CrosstermBackend, Terminal};
use serde::Deserialize;

#[derive(Deserialize, Default)]
struct RegistryFile {
    #[serde(default)]
    entries: Vec<RegistryEntry>,
}

/// Shared registry row: v1 entries simply leave `master_id`/`bind_state` empty.
#[derive(Deserialize, Default)]
struct RegistryEntry {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    roles: Vec<String>,
    #[serde(default)]
    master_id: Option<String>,
    #[serde(default)]
    bind_state: String,
}

#[derive(Deserialize, Default)]
struct PlanFile {
    #[serde(default)]
    plan_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    tasks: Vec<Task>,
}

#[derive(Deserialize, Default)]
struct Task {
    #[serde(default)]
    task_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    assignee: Option<String>,
    #[serde(default)]
    attempts: u32,
}

/// v1 plan: the linear 11-state workflow, one affine worker per plan.
#[derive(Deserialize, Default)]
struct PlanV1 {
    #[serde(default)]
    plan_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    assigned_worker_session_id: Option<String>,
}

const COLUMNS_V2: [(&str, Color); 9] = [
    ("ready", Color::Cyan),
    ("assigned", Color::LightCyan),
    ("executing", Color::Yellow),
    ("reporting", Color::LightYellow),
    ("verifying", Color::Magenta),
    ("rework", Color::LightRed),
    ("blocked", Color::Red),
    ("done", Color::Green),
    ("pending", Color::DarkGray),
];

const COLUMNS_V1: [(&str, Color); 11] = [
    ("draft", Color::DarkGray),
    ("pending_pre_review", Color::Cyan),
    ("needs_plan_revision", Color::LightYellow),
    ("ready_to_execute", Color::LightCyan),
    ("executing", Color::Yellow),
    ("pending_verify", Color::Magenta),
    ("needs_rework", Color::LightRed),
    ("done", Color::Green),
    ("closed", Color::LightGreen),
    ("aborting", Color::Red),
    ("aborted", Color::DarkGray),
];

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    V1,
    V2,
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Option<T> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Layout markers present under one candidate root.
fn layout_markers(root: &PathBuf) -> (bool, bool) {
    let coop = root.join(".dsh").join("coop");
    let v1 = coop.join("registry.json").is_file();
    let v2 = coop.join("v2").join("registry.json").is_file();
    (v1, v2)
}

/// Walk up from `start` to the nearest directory carrying either coop layout
/// marker (v2 preferred when both sit at the same level); the start itself is
/// the fallback. Never creates an anchor (spec §3.1/§12.5).
fn discover(start: PathBuf) -> (PathBuf, bool, bool) {
    let mut dir = start.clone();
    loop {
        let (v1, v2) = layout_markers(&dir);
        if v1 || v2 {
            return (dir, v1, v2);
        }
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => return (start, false, false),
        }
    }
}

fn coop_root(workspace: &PathBuf) -> PathBuf {
    workspace.join(".dsh").join("coop")
}

struct Board {
    workspace: PathBuf,
    mode: Mode,
    has_v1: bool,
    has_v2: bool,
    masters: Vec<String>,
    selected: usize,
    plans: Vec<PlanFile>,
    plans_v1: Vec<PlanV1>,
    nodes: Vec<RegistryEntry>,
}

impl Board {
    fn reload(&mut self) {
        let coop = coop_root(&self.workspace);
        match self.mode {
            Mode::V2 => {
                let root = coop.join("v2");
                self.nodes = read_json::<RegistryFile>(&root.join("registry.json"))
                    .map(|file| file.entries)
                    .unwrap_or_default();
                let mut masters: Vec<String> = self
                    .nodes
                    .iter()
                    .filter(|entry| entry.roles.iter().any(|role| role == "master"))
                    .filter_map(|entry| entry.master_id.clone())
                    .collect();
                masters.sort();
                masters.dedup();
                if self.selected >= masters.len() {
                    self.selected = masters.len().saturating_sub(1);
                }
                self.masters = masters;
                let master = self.masters.get(self.selected).cloned();
                self.plans = match master {
                    None => Vec::new(),
                    Some(master) => {
                        let mut plans: Vec<PlanFile> = read_plans(&root.join("masters").join(&master).join("plans"));
                        plans.sort_by(|left, right| left.plan_id.cmp(&right.plan_id));
                        plans
                    }
                };
                self.plans_v1 = Vec::new();
            }
            Mode::V1 => {
                self.nodes = read_json::<RegistryFile>(&coop.join("registry.json"))
                    .map(|file| file.entries)
                    .unwrap_or_default();
                self.masters = Vec::new();
                self.selected = 0;
                self.plans = Vec::new();
                let mut plans_v1: Vec<PlanV1> = read_plans(&coop.join("plans"));
                plans_v1.sort_by(|left, right| left.plan_id.cmp(&right.plan_id));
                self.plans_v1 = plans_v1;
            }
        }
    }

    fn master(&self) -> Option<&String> {
        self.masters.get(self.selected)
    }

    fn switch(&mut self, forward: bool) {
        if self.masters.is_empty() {
            return;
        }
        let len = self.masters.len();
        self.selected = if forward {
            (self.selected + 1) % len
        } else {
            (self.selected + len - 1) % len
        };
        self.reload();
    }

    fn toggle_layout(&mut self) {
        if self.has_v1 && self.has_v2 {
            self.mode = if self.mode == Mode::V2 { Mode::V1 } else { Mode::V2 };
            self.reload();
        }
    }
}

fn read_plans<T: for<'de> Deserialize<'de>>(dir: &PathBuf) -> Vec<T> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                .filter_map(|entry| read_json::<T>(&entry.path()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn card(task: &Task) -> ListItem<'static> {
    let assignee = task.assignee.clone().unwrap_or_default();
    let attempts = if task.attempts > 0 {
        format!(" ·rw{}", task.attempts)
    } else {
        String::new()
    };
    ListItem::new(vec![
        Line::from(Span::styled(
            format!("{} {}", task.task_id, task.title),
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            format!("  {}{}", assignee, attempts),
            Style::default().fg(Color::Gray),
        )),
    ])
}

fn card_v1(plan: &PlanV1) -> ListItem<'static> {
    let worker = plan.assigned_worker_session_id.clone().unwrap_or_default();
    ListItem::new(vec![
        Line::from(Span::styled(
            format!("{} {}", plan.plan_id, plan.title),
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            format!("  {}", worker),
            Style::default().fg(Color::Gray),
        )),
    ])
}

fn main() -> std::io::Result<()> {
    let start = env::current_dir()?;
    let explicit = env::args().nth(1);
    let (workspace, has_v1, mut has_v2) = match explicit {
        Some(path) => {
            let root = PathBuf::from(path);
            let (v1, v2) = layout_markers(&root);
            (root, v1, v2)
        }
        None => discover(start),
    };
    if !has_v1 && !has_v2 {
        has_v2 = true;
    }
    let mode = if has_v2 { Mode::V2 } else { Mode::V1 };
    let mut board = Board {
        workspace: workspace.clone(),
        mode,
        has_v1,
        has_v2,
        masters: Vec::new(),
        selected: 0,
        plans: Vec::new(),
        plans_v1: Vec::new(),
        nodes: Vec::new(),
    };
    board.reload();

    enable_raw_mode()?;
    std::io::stdout().execute(EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    'ui: loop {
        terminal.draw(|frame| {
            let area = frame.area();
            let mode_badge = match board.mode {
                Mode::V1 => " [v1] ",
                Mode::V2 => " [v2] ",
            };
            let mut header_spans = vec![
                Span::styled(" coop board ".to_string(), Style::default().fg(Color::Cyan)),
                Span::styled(mode_badge.to_string(), Style::default().fg(Color::LightMagenta)),
                Span::raw(workspace.display().to_string()),
                Span::raw("  ·  "),
            ];
            let mut hint = String::from("q quit");
            match board.mode {
                Mode::V2 => {
                    header_spans.push(Span::styled(
                        board.master().cloned().unwrap_or_else(|| "(no master)".to_string()),
                        Style::default().fg(Color::LightGreen),
                    ));
                    header_spans.push(Span::raw(format!("  ·  nodes {}", board.nodes.len())));
                    hint.insert_str(0, "h/l master, ");
                }
                Mode::V1 => {
                    header_spans.push(Span::styled(
                        format!("{} plan(s)", board.plans_v1.len()),
                        Style::default().fg(Color::LightGreen),
                    ));
                    header_spans.push(Span::raw(format!("  ·  nodes {}", board.nodes.len())));
                }
            }
            if board.has_v1 && board.has_v2 {
                hint.insert_str(0, "v layout, ");
            }
            header_spans.push(Span::raw(format!("  ·  {}", hint)));
            let header = Paragraph::new(Line::from(header_spans))
                .block(Block::default().borders(Borders::BOTTOM));
            let chunks = Layout::vertical([
                Constraint::Length(1),
                Constraint::Min(1),
                Constraint::Length(1),
            ])
            .split(area);
            frame.render_widget(header, chunks[0]);

            let footer_spans: Vec<Span> = match board.mode {
                Mode::V2 => vec![
                    Span::styled(
                        board
                            .plans
                            .iter()
                            .map(|plan| format!("{} {} [{}]", plan.plan_id, plan.title, plan.status))
                            .collect::<Vec<_>>()
                            .join(" · "),
                        Style::default().fg(Color::Gray),
                    ),
                    Span::raw("  ·  "),
                    Span::raw(format!(
                        "bound {} ({}) · unbound {}",
                        board.nodes.iter().filter(|node| node.bind_state == "bound").count(),
                        board
                            .nodes
                            .iter()
                            .filter(|node| node.bind_state == "bound")
                            .map(|node| node.session_id.as_str())
                            .collect::<Vec<_>>()
                            .join("/"),
                        board.nodes.iter().filter(|node| node.bind_state != "bound").count(),
                    )),
                ],
                Mode::V1 => vec![
                    Span::styled(
                        board
                            .plans_v1
                            .iter()
                            .map(|plan| format!("{} [{}]", plan.plan_id, plan.status))
                            .collect::<Vec<_>>()
                            .join(" · "),
                        Style::default().fg(Color::Gray),
                    ),
                    Span::raw("  ·  "),
                    Span::raw(format!(
                        "{}",
                        board
                            .nodes
                            .iter()
                            .map(|node| format!("{}:{}", node.roles.join("+"), node.session_id))
                            .collect::<Vec<_>>()
                            .join(" · ")
                    )),
                ],
            };
            let footer = Paragraph::new(Line::from(footer_spans))
                .block(Block::default().borders(Borders::TOP));
            frame.render_widget(footer, chunks[2]);

            match board.mode {
                Mode::V2 => render_columns(frame, chunks[1], &COLUMNS_V2, board
                    .plans
                    .iter()
                    .flat_map(|plan| plan.tasks.iter())
                    .map(|task| (task.status.clone(), card(task)))
                    .collect()),
                Mode::V1 => render_columns(frame, chunks[1], &COLUMNS_V1, board
                    .plans_v1
                    .iter()
                    .map(|plan| (plan.status.clone(), card_v1(plan)))
                    .collect()),
            }
        })?;
        if event::poll(Duration::from_millis(300))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    match key.code {
                        KeyCode::Char('q') | KeyCode::Esc => break 'ui,
                        KeyCode::Tab | KeyCode::Char('l') => {
                            if board.mode == Mode::V2 {
                                board.switch(true)
                            }
                        }
                        KeyCode::BackTab | KeyCode::Char('h') => {
                            if board.mode == Mode::V2 {
                                board.switch(false)
                            }
                        }
                        KeyCode::Char('v') => board.toggle_layout(),
                        _ => {}
                    }
                }
            }
        }
        board.reload();
    }
    disable_raw_mode()?;
    std::io::stdout().execute(LeaveAlternateScreen)?;
    Ok(())
}

fn render_columns(
    frame: &mut ratatui::Frame,
    area: ratatui::layout::Rect,
    columns: &[(&str, Color)],
    cards: Vec<(String, ListItem<'static>)>,
) {
    let layout = Layout::horizontal(
        columns
            .iter()
            .map(|_| Constraint::Ratio(1, columns.len() as u32))
            .collect::<Vec<_>>(),
    )
    .split(area);
    for (index, (status, color)) in columns.iter().enumerate() {
        let matched: Vec<ListItem> = cards
            .iter()
            .filter(|(card_status, _)| card_status == *status)
            .map(|(_, item)| item.clone())
            .collect();
        let list = List::new(matched).block(
            Block::default()
                .borders(Borders::ALL)
                .title(format!(" {} ({}) ", status, cards_len(&cards, status)))
                .border_style(Style::default().fg(*color)),
        );
        frame.render_widget(list, layout[index]);
    }
}

fn cards_len(cards: &[(String, ListItem<'static>)], status: &str) -> usize {
    cards
        .iter()
        .filter(|(card_status, _)| card_status == status)
        .count()
}
