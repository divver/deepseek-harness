//! Read-only layered coop dashboard (Ratatui), the `board` pane of the herdr
//! coop plugin. Workspace → masters → nodes → plans → tasks: a header of
//! workspace totals, a sidebar tree of masters and plans with progress, a
//! fleet strip of live nodes, and the kanban columns of the selected plan (or
//! every plan of the master merged). Supports both registry layouts — v2
//! (`.dsh/coop/v2/`, task DAG per master) and v1 (`.dsh/coop/`, linear
//! 11-state plans — cards are plans, not tasks). Discovery walks up for either
//! layout marker (v2 preferred, `v` toggles when both exist), else falls back
//! to the cwd. The board never writes: operations stay in dsh tools/commands
//! (spec §8.4).

mod app;
mod model;
mod view;

use std::{env, io, path::PathBuf, time::Duration};

use ratatui::crossterm::{
    event::{self, Event, KeyEventKind},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use ratatui::{backend::CrosstermBackend, Terminal};

use app::App;

/// The interactive loop: draw, poll, dispatch, reload. Split out of `main`
/// so every exit path — quit, draw error, poll error, read error — funnels
/// through one terminal-restoring epilogue.
fn run<B: ratatui::backend::Backend>(app: &mut App, terminal: &mut Terminal<B>) -> io::Result<()> {
    loop {
        terminal.draw(|frame| view::draw(app, frame))?;
        if event::poll(Duration::from_millis(model::POLL_MS))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    app.handle_key(key.code);
                    if app.quit {
                        return Ok(());
                    }
                }
            }
        }
        app.reload();
    }
}

fn main() -> io::Result<()> {
    let explicit = env::args().nth(1);
    let start = match explicit {
        Some(path) => PathBuf::from(path),
        // Plugin panes run with the plugin directory as cwd; the workspace the
        // user is looking at comes from the herdr plugin context (or an
        // explicit COOP_WORKSPACE override), then normal discovery walks up
        // from there to the nearest coop layout markers.
        None => env::var("COOP_WORKSPACE")
            .ok()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                env::var("HERDR_PLUGIN_CONTEXT_JSON")
                    .ok()
                    .and_then(|json| model::context_workspace(&json))
            })
            .or_else(|| env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from(".")),
    };
    let (workspace, has_v1, mut has_v2) = {
        let root = start;
        let (v1, v2) = model::markers_of(&root);
        if v1 || v2 {
            (root, v1, v2)
        } else {
            model::discover(root)
        }
    };
    if !has_v1 && !has_v2 {
        has_v2 = true;
    }
    let mut app = App::new(workspace.clone(), has_v1, has_v2);

    // Build the terminal before touching tty state: a failed construction
    // holds no raw mode and no alternate screen, so it may return early.
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    enable_raw_mode()?;
    // From here on (alt-screen entry through the run loop) every failure is
    // routed through the restoring epilogue below — no early `?` returns.
    let outcome = io::stdout()
        .execute(EnterAlternateScreen)
        .and_then(|_| run(&mut app, &mut terminal));
    // Restore the terminal on every exit path. Best-effort on purpose: a
    // failing restore must not mask the error that caused the exit, and the
    // original problem still surfaces after the screen is usable again.
    let _ = terminal.flush();
    let _ = disable_raw_mode();
    let _ = io::stdout().execute(LeaveAlternateScreen);
    outcome
}
