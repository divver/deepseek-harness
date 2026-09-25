//! Dashboard state and key handling: which master/plan the kanban projects,
//! how selection survives reloads (ids, not indices), and the input grammar.

use std::path::PathBuf;

use ratatui::crossterm::event::KeyCode;
use ratatui::widgets::ListState;

use crate::model::{self, Mode, Snapshot, SnapshotV1};

/// Right-panel projection of the selected plan: status kanban or the
/// topological DAG waves.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Panel {
    Kanban,
    Dag,
}

/// One selectable sidebar row: a plan under a master.
#[derive(Clone)]
pub struct PlanRow {
    pub master_idx: usize,
    pub plan_idx: usize,
    pub master_id: String,
    pub plan_id: String,
}

pub struct App {
    pub workspace: PathBuf,
    pub has_v1: bool,
    pub has_v2: bool,
    pub mode: Mode,
    pub v2: Snapshot,
    pub v1: SnapshotV1,
    /// Selected master id; the first master when unset or vanished.
    sel_master: Option<String>,
    /// Selected plan id; the first plan of the master when unset or vanished.
    sel_plan: Option<String>,
    /// Merge every plan of the selected master into the kanban.
    pub aggregate: bool,
    /// Right-panel projection (v2): kanban columns or DAG waves.
    pub panel: Panel,
    pub quit: bool,
    pub list_state: ListState,
}

impl App {
    pub fn new(workspace: PathBuf, has_v1: bool, has_v2: bool) -> Self {
        let mode = if has_v2 || !has_v1 {
            Mode::V2
        } else {
            Mode::V1
        };
        let mut app = App {
            workspace,
            has_v1,
            has_v2,
            mode,
            v2: Snapshot::default(),
            v1: SnapshotV1::default(),
            sel_master: None,
            sel_plan: None,
            aggregate: false,
            panel: Panel::Kanban,
            quit: false,
            list_state: ListState::default(),
        };
        app.reload();
        app
    }

    pub fn reload(&mut self) {
        match self.mode {
            Mode::V2 => self.v2 = model::load_v2(&self.workspace),
            Mode::V1 => self.v1 = model::load_v1(&self.workspace),
        }
    }

    /// Flat plan rows of the sidebar: masters in file order, their plans in
    /// dashboard order (running first).
    pub fn plan_rows(&self) -> Vec<PlanRow> {
        self.v2
            .masters
            .iter()
            .enumerate()
            .flat_map(|(master_idx, master)| {
                master
                    .plans
                    .iter()
                    .enumerate()
                    .map(move |(plan_idx, plan)| PlanRow {
                        master_idx,
                        plan_idx,
                        master_id: master.master_id.clone(),
                        plan_id: plan.plan_id.clone(),
                    })
            })
            .collect()
    }

    /// Index of the selected master, clamped to the live table.
    fn master_index(&self) -> usize {
        self.v2
            .masters
            .iter()
            .position(|master| Some(&master.master_id) == self.sel_master.as_ref())
            .unwrap_or(0)
    }

    /// Index of the selected plan inside the selected master, clamped.
    fn plan_index(&self) -> usize {
        let master = self.v2.masters.get(self.master_index());
        master
            .and_then(|master| {
                master
                    .plans
                    .iter()
                    .position(|plan| Some(&plan.plan_id) == self.sel_plan.as_ref())
            })
            .unwrap_or(0)
    }

    /// The master layer the fleet and kanban project.
    pub fn selected_master(&self) -> Option<&model::MasterView> {
        self.v2.masters.get(self.master_index())
    }

    /// The plan the kanban projects (aggregate mode merges, so `None`).
    pub fn selected_plan(&self) -> Option<&model::PlanView> {
        if self.aggregate {
            return None;
        }
        self.selected_master()?.plans.get(self.plan_index())
    }

    /// Current selection position in the flat plan-row list.
    fn flat_index(&self) -> usize {
        let master_idx = self.master_index();
        let plan_idx = self.plan_index();
        self.plan_rows()
            .iter()
            .position(|row| row.master_idx == master_idx && row.plan_idx == plan_idx)
            .unwrap_or(0)
    }

    fn select_flat(&mut self, index: usize) {
        let rows = self.plan_rows();
        if rows.is_empty() {
            self.sel_master = None;
            self.sel_plan = None;
            return;
        }
        let index = index.min(rows.len() - 1);
        let row = &rows[index];
        self.sel_master = Some(row.master_id.clone());
        self.sel_plan = Some(row.plan_id.clone());
    }

    /// Move the plan selection one row down, crossing master boundaries.
    pub fn move_down(&mut self) {
        self.select_flat(self.flat_index() + 1);
    }

    /// Move the plan selection one row up, crossing master boundaries.
    pub fn move_up(&mut self) {
        let index = self.flat_index();
        self.select_flat(index.saturating_sub(1));
    }

    /// Jump to the first plan of the next master.
    pub fn next_master(&mut self) {
        let len = self.v2.masters.len();
        if len == 0 {
            return;
        }
        let next = (self.master_index() + 1) % len;
        self.sel_master = Some(self.v2.masters[next].master_id.clone());
        self.sel_plan = self.v2.masters[next]
            .plans
            .first()
            .map(|plan| plan.plan_id.clone());
    }

    /// Jump to the first plan of the previous master.
    pub fn prev_master(&mut self) {
        let len = self.v2.masters.len();
        if len == 0 {
            return;
        }
        let prev = (self.master_index() + len - 1) % len;
        self.sel_master = Some(self.v2.masters[prev].master_id.clone());
        self.sel_plan = self.v2.masters[prev]
            .plans
            .first()
            .map(|plan| plan.plan_id.clone());
    }

    /// Toggle the merged-all-plans kanban (v2 only).
    pub fn toggle_aggregate(&mut self) {
        if self.mode == Mode::V2 {
            self.aggregate = !self.aggregate;
        }
    }

    /// Toggle kanban ↔ DAG projection (v2 only).
    pub fn toggle_panel(&mut self) {
        if self.mode == Mode::V2 {
            self.panel = if self.panel == Panel::Kanban {
                Panel::Dag
            } else {
                Panel::Kanban
            };
        }
    }

    /// The plan the DAG projects. Deps are plan-scoped, so the DAG always
    /// reads the flat-selected plan and ignores `aggregate`.
    pub fn dag_plan(&self) -> Option<&model::PlanView> {
        self.selected_master()?.plans.get(self.plan_index())
    }

    /// Toggle the v1/v2 layout when both markers exist.
    pub fn toggle_layout(&mut self) {
        if self.has_v1 && self.has_v2 {
            self.mode = if self.mode == Mode::V2 {
                Mode::V1
            } else {
                Mode::V2
            };
            self.aggregate = false;
            self.reload();
        }
    }

    /// Apply one keypress.
    pub fn handle_key(&mut self, key: KeyCode) {
        match key {
            KeyCode::Char('q') | KeyCode::Esc => self.quit = true,
            KeyCode::Tab | KeyCode::Char('l') if self.mode == Mode::V2 => self.next_master(),
            KeyCode::BackTab | KeyCode::Char('h') if self.mode == Mode::V2 => self.prev_master(),
            KeyCode::Char('j') | KeyCode::Down if self.mode == Mode::V2 => self.move_down(),
            KeyCode::Char('k') | KeyCode::Up if self.mode == Mode::V2 => self.move_up(),
            KeyCode::Char('g') if self.mode == Mode::V2 => self.select_flat(0),
            KeyCode::Char('G') if self.mode == Mode::V2 => {
                let len = self.plan_rows().len();
                self.select_flat(len.saturating_sub(1));
            }
            KeyCode::Char('a') => self.toggle_aggregate(),
            KeyCode::Char('d') => self.toggle_panel(),
            KeyCode::Char('v') => self.toggle_layout(),
            _ => {}
        }
    }

    /// Selected (master index, plan index) for sidebar highlighting.
    pub fn selection(&self) -> Option<(usize, usize)> {
        Some((self.master_index(), self.plan_index()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coop-board-app-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("fixture");
        dir
    }

    fn write(path: &std::path::Path, body: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        fs::write(path, body).expect("file");
    }

    fn seeded(tag: &str, plans_a: &[(&str, &str)], plans_b: &[(&str, &str)]) -> PathBuf {
        let root = fixture(tag);
        let coop = root.join(".dsh").join("coop").join("v2");
        write(
            &coop.join("registry.json"),
            r#"{"version":2,"entries":[
                {"sessionId":"m1","roles":["master"],"masterId":"one#aa","bindState":"bound","heartbeatAt":1},
                {"sessionId":"m2","roles":["master"],"masterId":"two#bb","bindState":"bound","heartbeatAt":1}
            ]}"#,
        );
        for (master, plans) in [("one#aa", plans_a), ("two#bb", plans_b)] {
            for (id, status) in plans {
                write(
                    &coop
                        .join("masters")
                        .join(master)
                        .join("plans")
                        .join(format!("{id}.json")),
                    &format!(
                        r#"{{"version":2,"planId":"{id}","title":"{id}","status":"{status}","createdAt":1,"tasks":[]}}"#
                    ),
                );
            }
        }
        root
    }

    #[test]
    fn selection_moves_across_master_boundaries() {
        let root = seeded(
            "move",
            &[("a1", "active"), ("a2", "designing")],
            &[("b1", "active")],
        );
        let mut app = App::new(root.clone(), false, true);
        assert_eq!(
            app.selected_plan().map(|plan| plan.plan_id.as_str()),
            Some("a1")
        );
        app.move_down();
        assert_eq!(
            app.selected_plan().map(|plan| plan.plan_id.as_str()),
            Some("a2")
        );
        app.move_down();
        assert_eq!(
            app.selected_master().map(|m| m.master_id.as_str()),
            Some("two#bb")
        );
        assert_eq!(
            app.selected_plan().map(|plan| plan.plan_id.as_str()),
            Some("b1")
        );
        app.move_down();
        assert_eq!(
            app.selected_plan().map(|plan| plan.plan_id.as_str()),
            Some("b1"),
            "clamped at the end"
        );
        app.move_up();
        app.move_up();
        assert_eq!(
            app.selected_plan().map(|plan| plan.plan_id.as_str()),
            Some("a1")
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn master_switch_lands_on_first_plan() {
        let root = seeded(
            "switch",
            &[("a1", "active"), ("a2", "designing")],
            &[("b1", "active")],
        );
        let mut app = App::new(root.clone(), false, true);
        app.move_down();
        assert_eq!(
            app.selected_plan().map(|plan| plan.plan_id.as_str()),
            Some("a2")
        );
        app.next_master();
        assert_eq!(
            app.selected_plan().map(|plan| plan.plan_id.as_str()),
            Some("b1")
        );
        app.prev_master();
        assert_eq!(
            app.selected_plan().map(|plan| plan.plan_id.as_str()),
            Some("a1")
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn aggregate_hides_single_plan_selection() {
        let root = seeded("agg", &[("a1", "active")], &[]);
        let mut app = App::new(root.clone(), false, true);
        assert!(app.selected_plan().is_some());
        app.handle_key(KeyCode::Char('a'));
        assert!(app.aggregate);
        assert!(app.selected_plan().is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dag_panel_ignores_aggregate_and_toggles() {
        let root = seeded("dag", &[("a1", "active")], &[]);
        let mut app = App::new(root.clone(), false, true);
        app.handle_key(KeyCode::Char('a'));
        assert!(app.aggregate);
        assert_eq!(app.panel, Panel::Kanban);
        app.handle_key(KeyCode::Char('d'));
        assert_eq!(app.panel, Panel::Dag);
        assert_eq!(
            app.dag_plan().map(|plan| plan.plan_id.as_str()),
            Some("a1"),
            "DAG reads the selected plan even under aggregate"
        );
        app.handle_key(KeyCode::Char('d'));
        assert_eq!(app.panel, Panel::Kanban);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn selection_survives_reload() {
        let root = seeded("reload", &[("a1", "active"), ("a2", "designing")], &[]);
        let mut app = App::new(root.clone(), false, true);
        app.move_down();
        assert_eq!(
            app.selected_plan().map(|plan| plan.plan_id.as_str()),
            Some("a2")
        );
        app.reload();
        assert_eq!(
            app.selected_plan().map(|plan| plan.plan_id.as_str()),
            Some("a2")
        );
        let _ = fs::remove_dir_all(&root);
    }
}
