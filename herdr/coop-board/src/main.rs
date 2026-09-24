//! Read-only coop v2 kanban board (Ratatui), the `board` pane of the herdr
//! coop plugin. Discovers the coop workspace by walking up for
//! `.dsh/coop/workspace.json` (else the cwd), renders every master's plan
//! tasks grouped by status, and refreshes from the shared files. The board
//! never writes: operations stay in dsh tools/commands (spec §8.4).

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

const COLUMNS: [(&str, Color); 9] = [
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

fn read_json<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Option<T> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Walk up from `start` to the nearest `.dsh/coop/workspace.json` anchor; the
/// start itself is the fallback (spec §3.1/§12.5 — never create one here).
fn find_workspace(start: PathBuf) -> PathBuf {
    let mut dir = start.clone();
    loop {
        if dir.join(".dsh").join("coop").join("workspace.json").is_file() {
            return dir;
        }
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => return start,
        }
    }
}

fn v2_root(workspace: &PathBuf) -> PathBuf {
    workspace.join(".dsh").join("coop").join("v2")
}

struct Board {
    workspace: PathBuf,
    masters: Vec<String>,
    selected: usize,
    plans: Vec<PlanFile>,
    nodes: Vec<RegistryEntry>,
}

impl Board {
    fn reload(&mut self) {
        let root = v2_root(&self.workspace);
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
                let dir = root.join("masters").join(&master).join("plans");
                let mut plans = std::fs::read_dir(&dir)
                    .map(|entries| {
                        entries
                            .filter_map(|entry| entry.ok())
                            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                            .filter_map(|entry| read_json::<PlanFile>(&entry.path()))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                plans.sort_by(|left, right| left.plan_id.cmp(&right.plan_id));
                plans
            }
        };
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

fn main() -> std::io::Result<()> {
    let start = env::current_dir()?;
    let explicit = env::args().nth(1);
    let workspace = match explicit {
        Some(path) => PathBuf::from(path),
        None => find_workspace(start),
    };
    let mut board = Board { workspace: workspace.clone(), masters: Vec::new(), selected: 0, plans: Vec::new(), nodes: Vec::new() };
    board.reload();

    enable_raw_mode()?;
    std::io::stdout().execute(EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    'ui: loop {
        terminal.draw(|frame| {
            let area = frame.area();
            let header = Paragraph::new(Line::from(vec![
                Span::styled(" coop board ".to_string(), Style::default().fg(Color::Cyan)),
                Span::raw(workspace.display().to_string()),
                Span::raw("  ·  "),
                Span::styled(
                    board.master().cloned().unwrap_or_else(|| "(no master)".to_string()),
                    Style::default().fg(Color::LightGreen),
                ),
                Span::raw(format!(
                    "  ·  nodes {}  ·  h/l master, q quit",
                    board.nodes.len()
                )),
            ]))
            .block(Block::default().borders(Borders::BOTTOM));
            let chunks = Layout::vertical([
                Constraint::Length(1),
                Constraint::Min(1),
                Constraint::Length(1),
            ])
            .split(area);
            let header_area = chunks[0];
            frame.render_widget(header, header_area);

            let footer = Paragraph::new(Line::from(vec![
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
            ]))
            .block(Block::default().borders(Borders::TOP));
            frame.render_widget(footer, chunks[2]);

            let columns = Layout::horizontal(
                COLUMNS
                    .iter()
                    .map(|_| Constraint::Ratio(1, COLUMNS.len() as u32))
                    .collect::<Vec<_>>(),
            )
            .split(chunks[1]);
            for (index, (status, color)) in COLUMNS.iter().enumerate() {
                let mut cards: Vec<ListItem> = Vec::new();
                for plan in &board.plans {
                    for task in &plan.tasks {
                        if task.status == *status {
                            cards.push(card(task));
                        }
                    }
                }
                let list = List::new(cards).block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title(format!(" {} ({}) ", status, cards_len(&board.plans, status)))
                        .border_style(Style::default().fg(*color)),
                );
                frame.render_widget(list, columns[index]);
            }
        })?;
        if event::poll(Duration::from_millis(300))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    match key.code {
                        KeyCode::Char('q') | KeyCode::Esc => break 'ui,
                        KeyCode::Tab | KeyCode::Char('l') => board.switch(true),
                        KeyCode::BackTab | KeyCode::Char('h') => board.switch(false),
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

fn cards_len(plans: &[PlanFile], status: &str) -> usize {
    plans
        .iter()
        .flat_map(|plan| plan.tasks.iter())
        .filter(|task| task.status == status)
        .count()
}
