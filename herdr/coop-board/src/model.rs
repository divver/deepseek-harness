//! Data layer of the coop board: read-only projections of the shared coop
//! files (registry, master profiles, plan DAGs, worktree occupancy) into the
//! layered dashboard model — workspace → masters → nodes → plans → tasks.
//! Every computation that can drift (status buckets, progress, liveness,
//! ordering) lives here as a pure function so the tests can pin it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

/// Node liveness window; mirrors the dsh coop `staleMs` default (5 min).
pub const STALE_MS: u64 = 300_000;

/// Refresh cadence of the shared-file poll, ms.
pub const POLL_MS: u64 = 300;

/// Epoch ms right now (0 when the clock is before the unix epoch).
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    V1,
    V2,
}

#[derive(Deserialize, Default)]
struct RegistryFile {
    #[serde(default)]
    entries: Vec<RegistryEntry>,
}

/// Shared registry row: v1 entries simply leave `master_id`/`bind_state` empty.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct RegistryEntry {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    roles: Vec<String>,
    #[serde(default)]
    master_id: Option<String>,
    #[serde(default)]
    bind_state: String,
    #[serde(default)]
    heartbeat_at: u64,
    #[serde(default)]
    meta: Option<NodeMeta>,
    #[serde(default)]
    skills: Vec<String>,
}

/// Optional registration metadata (`model` route, self-reported herdr pane).
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct NodeMeta {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    pane_id: Option<String>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub worktree_id: Option<String>,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub updated_at: u64,
    /// Upstream task ids of this task's DAG edges (empty on legacy plans).
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct PlanFile {
    #[serde(default)]
    plan_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    tasks: Vec<Task>,
    #[serde(default)]
    created_at: u64,
}

/// v1 plan: the linear 11-state workflow, one affine worker per plan.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlanV1 {
    #[serde(default)]
    pub plan_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub assigned_worker_session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileFile {
    #[serde(default)]
    display_name: String,
}

#[derive(Deserialize, Default)]
struct WtRegistryFile {
    #[serde(default)]
    entries: Vec<WtEntry>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct WtEntry {
    #[serde(default)]
    plan_id: String,
    #[serde(default)]
    status: String,
}

/// One fleet row: a node as the dashboard shows it.
#[derive(Clone)]
pub struct NodeCard {
    pub session_id: String,
    pub roles: Vec<String>,
    pub heartbeat_at: u64,
    pub model: Option<String>,
    pub pane_id: Option<String>,
    pub skills: Vec<String>,
}

impl NodeCard {
    /// Short role tag for one line: `w`, `r`, `m`, or `+` mixes.
    pub fn role_tag(&self) -> String {
        let master = self.roles.iter().any(|role| role == "master");
        let worker = self.roles.iter().any(|role| role == "worker");
        let reviewer = self.roles.iter().any(|role| role == "reviewer");
        match (master, worker, reviewer) {
            (true, _, _) => "m".to_string(),
            (false, true, true) => "+".to_string(),
            (false, true, false) => "w".to_string(),
            (false, false, true) => "r".to_string(),
            (false, false, false) => "?".to_string(),
        }
    }

    /// Heartbeat age, ms (saturating; a zero heartbeat reads as ancient).
    pub fn age_ms(&self, now: u64) -> u64 {
        now.saturating_sub(self.heartbeat_at)
    }
}

/// Plan-level aggregates over task statuses.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Totals {
    pub done: usize,
    pub cancelled: usize,
    pub in_flight: usize,
    pub waiting: usize,
    pub total: usize,
}

impl Totals {
    /// Tasks resolved one way or another (done + cancelled).
    pub fn resolved(&self) -> usize {
        self.done + self.cancelled
    }

    /// Completion ratio in `0.0..=1.0` (1.0 for an empty plan).
    pub fn ratio(&self) -> f64 {
        if self.total == 0 {
            1.0
        } else {
            self.resolved() as f64 / self.total as f64
        }
    }
}

/// Bucket one task set into the dashboard aggregates.
pub fn totals(tasks: &[Task]) -> Totals {
    let mut sums = Totals {
        total: tasks.len(),
        ..Totals::default()
    };
    for task in tasks {
        match task.status.as_str() {
            "done" => sums.done += 1,
            "cancelled" => sums.cancelled += 1,
            "assigned" | "executing" | "reporting" | "verifying" | "rework" => sums.in_flight += 1,
            _ => sums.waiting += 1,
        }
    }
    sums
}

/// Topological waves of one plan's task DAG (Kahn): wave *i* holds every
/// task whose in-plan dependencies all sit in earlier waves, so a left→
/// right read is a valid execution order. Edges naming ids outside the set
/// are ignored (cross-plan or dangling deps never strand a card), and a
/// cycle's remainder lands in a final wave instead of vanishing.
pub fn dag_waves(tasks: &[Task]) -> Vec<Vec<&Task>> {
    let index: HashMap<&str, usize> = tasks
        .iter()
        .enumerate()
        .map(|(i, task)| (task.task_id.as_str(), i))
        .collect();
    let mut indegree = vec![0usize; tasks.len()];
    let mut dependents: Vec<Vec<usize>> = vec![Vec::new(); tasks.len()];
    for (i, task) in tasks.iter().enumerate() {
        for dep in &task.depends_on {
            if let Some(&j) = index.get(dep.as_str()) {
                indegree[i] += 1;
                dependents[j].push(i);
            }
        }
    }
    let mut placed = vec![false; tasks.len()];
    let mut waves: Vec<Vec<&Task>> = Vec::new();
    loop {
        let wave: Vec<usize> = (0..tasks.len())
            .filter(|&i| !placed[i] && indegree[i] == 0)
            .collect();
        if wave.is_empty() {
            break;
        }
        for &i in &wave {
            placed[i] = true;
            for &downstream in &dependents[i] {
                indegree[downstream] = indegree[downstream].saturating_sub(1);
            }
        }
        waves.push(wave.iter().map(|&i| &tasks[i]).collect());
    }
    let leftover: Vec<&Task> = (0..tasks.len())
        .filter(|&i| !placed[i])
        .map(|i| &tasks[i])
        .collect();
    if !leftover.is_empty() {
        waves.push(leftover);
    }
    waves
}

/// 1-based index of the first wave still holding a non-terminal task; a
/// fully settled plan reports its wave count ("wave n/n").
pub fn current_wave(waves: &[Vec<&Task>]) -> usize {
    for (i, wave) in waves.iter().enumerate() {
        if wave
            .iter()
            .any(|task| !matches!(task.status.as_str(), "done" | "cancelled"))
        {
            return i + 1;
        }
    }
    waves.len()
}

/// Textual progress bar of `width` cells.
pub fn progress_bar(totals: Totals, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let filled = (totals.ratio() * width as f64).round() as usize;
    let filled = filled.min(width);
    format!("{}{}", "▓".repeat(filled), "░".repeat(width - filled))
}

/// Compact age: `now`, `45s`, `3m`, `2h`, `4d`.
pub fn age_string(age_ms: u64) -> String {
    let secs = age_ms / 1000;
    if secs < 1 {
        "now".to_string()
    } else if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86_400)
    }
}

/// The slug half of a master id (`llm#ab12` → `llm`).
pub fn slug(id: &str) -> &str {
    id.split('#').next().unwrap_or(id)
}

/// First 8 chars of a session id (display only; files keep full ids).
pub fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

/// Compact plan id for card prefixes: drop a `plan-` prefix, keep 8 chars.
pub fn plan_short(plan_id: &str) -> String {
    let rest = plan_id.strip_prefix("plan-").unwrap_or(plan_id);
    rest.chars().take(8).collect()
}

/// Dashboard ordering of v2 plan statuses: running first, designing mid,
/// terminal last.
pub fn status_rank(status: &str) -> u8 {
    match status {
        "active" => 0,
        "reviewing" | "closing" => 1,
        "designing" => 2,
        "closed" => 3,
        "aborted" => 4,
        _ => 5,
    }
}

/// One plan row of the sidebar / kanban source.
#[derive(Clone)]
pub struct PlanView {
    pub plan_id: String,
    pub title: String,
    pub status: String,
    pub tasks: Vec<Task>,
    pub totals: Totals,
    /// Active worktrees occupied by this plan.
    pub worktrees: usize,
    pub updated_at: u64,
}

/// One master layer: its own entry, bound fleet, and plans.
#[derive(Clone)]
pub struct MasterView {
    pub master_id: String,
    pub display_name: String,
    pub heartbeat_at: u64,
    pub nodes: Vec<NodeCard>,
    pub plans: Vec<PlanView>,
    pub totals: Totals,
}

impl MasterView {
    /// Bound worker count.
    pub fn workers(&self) -> usize {
        self.nodes
            .iter()
            .filter(|node| node.roles.iter().any(|role| role == "worker"))
            .count()
    }

    /// Bound reviewer count.
    pub fn reviewers(&self) -> usize {
        self.nodes
            .iter()
            .filter(|node| node.roles.iter().any(|role| role == "reviewer"))
            .count()
    }
}

/// v2 layered snapshot: everything the dashboard renders.
#[derive(Clone, Default)]
pub struct Snapshot {
    pub anchored: bool,
    pub masters: Vec<MasterView>,
    pub unbound: Vec<NodeCard>,
    pub worktrees_active: usize,
}

impl Snapshot {
    /// Bound node count across masters.
    pub fn bound_nodes(&self) -> usize {
        self.masters.iter().map(|master| master.nodes.len()).sum()
    }

    /// Plan count across masters.
    pub fn plans(&self) -> usize {
        self.masters.iter().map(|master| master.plans.len()).sum()
    }

    /// Active plan count across masters.
    pub fn active_plans(&self) -> usize {
        self.masters
            .iter()
            .flat_map(|master| master.plans.iter())
            .filter(|plan| plan.status == "active")
            .count()
    }

    /// Task aggregates across masters.
    pub fn task_totals(&self) -> Totals {
        self.masters
            .iter()
            .fold(Totals::default(), |acc, master| Totals {
                done: acc.done + master.totals.done,
                cancelled: acc.cancelled + master.totals.cancelled,
                in_flight: acc.in_flight + master.totals.in_flight,
                waiting: acc.waiting + master.totals.waiting,
                total: acc.total + master.totals.total,
            })
    }
}

/// v1 snapshot: registry rows plus the linear plan set (cards are plans).
#[derive(Clone, Default)]
pub struct SnapshotV1 {
    pub nodes: Vec<NodeCard>,
    pub plans: Vec<PlanV1>,
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_plans<T: for<'de> Deserialize<'de>>(dir: &Path) -> Vec<T> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                .filter_map(|entry| read_json::<T>(&entry.path()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn card_of(entry: &RegistryEntry) -> NodeCard {
    NodeCard {
        session_id: entry.session_id.clone(),
        roles: entry.roles.clone(),
        heartbeat_at: entry.heartbeat_at,
        model: entry.meta.as_ref().and_then(|meta| meta.model.clone()),
        pane_id: entry.meta.as_ref().and_then(|meta| meta.pane_id.clone()),
        skills: entry.skills.clone(),
    }
}

/// Build the v2 layered snapshot from one workspace root.
pub fn load_v2(workspace: &Path) -> Snapshot {
    let root = workspace.join(".dsh").join("coop").join("v2");
    let entries = read_json::<RegistryFile>(&root.join("registry.json"))
        .map(|file| file.entries)
        .unwrap_or_default();
    let anchored = workspace
        .join(".dsh")
        .join("coop")
        .join("workspace.json")
        .is_file();

    let mut masters: Vec<String> = entries
        .iter()
        .filter(|entry| entry.roles.iter().any(|role| role == "master"))
        .filter_map(|entry| entry.master_id.clone())
        .collect();
    masters.sort();
    masters.dedup();

    let wt = read_json::<WtRegistryFile>(&root.join("wt-registry.json"));
    let mut worktrees_by_plan: HashMap<String, usize> = HashMap::new();
    let mut worktrees_active = 0;
    for entry in wt.iter().flat_map(|file| file.entries.iter()) {
        if entry.status == "active" {
            worktrees_active += 1;
            *worktrees_by_plan.entry(entry.plan_id.clone()).or_default() += 1;
        }
    }

    let mut views: Vec<MasterView> = Vec::new();
    for master_id in &masters {
        let own = entries
            .iter()
            .find(|entry| entry.master_id.as_deref() == Some(master_id.as_str()));
        let profile =
            read_json::<ProfileFile>(&root.join("masters").join(master_id).join("profile.json"));
        let nodes: Vec<NodeCard> = entries
            .iter()
            .filter(|entry| {
                !entry.roles.iter().any(|role| role == "master")
                    && entry.bind_state == "bound"
                    && entry.master_id.as_deref() == Some(master_id.as_str())
            })
            .map(card_of)
            .collect();
        let mut plans: Vec<PlanView> =
            read_plans::<PlanFile>(&root.join("masters").join(master_id).join("plans"))
                .into_iter()
                .map(|plan| {
                    let plan_id = plan.plan_id.clone();
                    let updated_at = plan
                        .tasks
                        .iter()
                        .map(|task| task.updated_at)
                        .chain([plan.created_at])
                        .max()
                        .unwrap_or(0);
                    PlanView {
                        totals: totals(&plan.tasks),
                        plan_id: plan.plan_id,
                        title: plan.title,
                        status: plan.status,
                        tasks: plan.tasks,
                        worktrees: worktrees_by_plan.get(&plan_id).copied().unwrap_or(0),
                        updated_at,
                    }
                })
                .collect();
        plans.sort_by(|left, right| {
            status_rank(&left.status)
                .cmp(&status_rank(&right.status))
                .then_with(|| right.updated_at.cmp(&left.updated_at))
                .then_with(|| left.plan_id.cmp(&right.plan_id))
        });
        let master_totals = plans.iter().fold(Totals::default(), |acc, plan| Totals {
            done: acc.done + plan.totals.done,
            cancelled: acc.cancelled + plan.totals.cancelled,
            in_flight: acc.in_flight + plan.totals.in_flight,
            waiting: acc.waiting + plan.totals.waiting,
            total: acc.total + plan.totals.total,
        });
        views.push(MasterView {
            master_id: master_id.clone(),
            display_name: profile
                .map(|it| it.display_name)
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| slug(master_id).to_string()),
            heartbeat_at: own.map(|entry| entry.heartbeat_at).unwrap_or(0),
            nodes,
            plans,
            totals: master_totals,
        });
    }

    let unbound = entries
        .iter()
        .filter(|entry| {
            !entry.roles.iter().any(|role| role == "master") && entry.bind_state != "bound"
        })
        .map(card_of)
        .collect();

    Snapshot {
        anchored,
        masters: views,
        unbound,
        worktrees_active,
    }
}

/// Build the v1 snapshot: local registry plus the linear plan set.
pub fn load_v1(workspace: &Path) -> SnapshotV1 {
    let coop = workspace.join(".dsh").join("coop");
    let entries = read_json::<RegistryFile>(&coop.join("registry.json"))
        .map(|file| file.entries)
        .unwrap_or_default();
    let mut plans = read_plans::<PlanV1>(&coop.join("plans"));
    plans.sort_by(|left, right| left.plan_id.cmp(&right.plan_id));
    SnapshotV1 {
        nodes: entries.iter().map(card_of).collect(),
        plans,
    }
}

/// Layout markers present under one candidate root.
fn layout_markers(root: &Path) -> (bool, bool) {
    let coop = root.join(".dsh").join("coop");
    let v1 = coop.join("registry.json").is_file();
    let v2 = coop.join("v2").join("registry.json").is_file();
    (v1, v2)
}

/// Walk up from `start` to the nearest directory carrying either coop layout
/// marker (v2 preferred when both sit at the same level); the start itself is
/// the fallback. Never creates an anchor (spec §3.1/§12.5).
pub fn discover(start: PathBuf) -> (PathBuf, bool, bool) {
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

/// Markers of one explicit candidate root (no walking).
pub fn markers_of(root: &Path) -> (bool, bool) {
    layout_markers(root)
}

/// Extract the workspace a herdr plugin invocation points at. The context
/// JSON is FLAT (verified against herdr 0.9.x): `focused_pane_cwd` names the
/// pane the command ran from, `workspace_cwd` the workspace's own root; both
/// are absolute paths or absent. Tolerant by design: any missing or
/// differently-shaped field simply yields `None` and the caller falls back to
/// cwd discovery.
/// @param json - raw `HERDR_PLUGIN_CONTEXT_JSON` value (may be empty).
/// @returns the root the board should project, if the context names one.
pub fn context_workspace(json: &str) -> Option<PathBuf> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    ["focused_pane_cwd", "workspace_cwd"]
        .iter()
        .find_map(|key| {
            value.get(*key).and_then(|v| v.as_str()).and_then(|s| {
                let p = PathBuf::from(s);
                p.is_absolute().then_some(p)
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, status: &str, updated_at: u64) -> Task {
        Task {
            task_id: id.to_string(),
            title: format!("task {id}"),
            status: status.to_string(),
            assignee: None,
            worktree_id: None,
            attempts: 0,
            updated_at,
            depends_on: Vec::new(),
        }
    }

    #[test]
    fn dag_waves_chain_and_diamond() {
        let mut root = task("a", "done", 0);
        root.depends_on = Vec::new();
        let mut left = task("b", "executing", 0);
        left.depends_on = vec!["a".to_string()];
        let mut right = task("c", "ready", 0);
        right.depends_on = vec!["a".to_string()];
        let mut sink = task("d", "pending", 0);
        sink.depends_on = vec!["b".to_string(), "c".to_string()];
        let tasks = vec![root, left, right, sink];
        let waves = dag_waves(&tasks);
        let ids: Vec<Vec<&str>> = waves
            .iter()
            .map(|wave| wave.iter().map(|task| task.task_id.as_str()).collect())
            .collect();
        assert_eq!(ids, vec![vec!["a"], vec!["b", "c"], vec!["d"]]);
        assert_eq!(current_wave(&waves), 2, "b/c still executing");
    }

    #[test]
    fn dag_waves_ignore_dangling_and_home_cycles() {
        let mut only = task("solo", "ready", 0);
        only.depends_on = vec!["ghost".to_string()];
        let solo = vec![only];
        assert_eq!(dag_waves(&solo).len(), 1);

        let mut loop_a = task("x", "pending", 0);
        loop_a.depends_on = vec!["y".to_string()];
        let mut loop_b = task("y", "pending", 0);
        loop_b.depends_on = vec!["x".to_string()];
        let cycle = vec![loop_a, loop_b];
        let waves = dag_waves(&cycle);
        assert_eq!(waves.len(), 1, "cycle remainder keeps one home");
        assert_eq!(waves[0].len(), 2);
    }

    #[test]
    fn current_wave_settled_plan_reports_total() {
        let settled_a = task("a", "done", 0);
        let settled_b = task("b", "cancelled", 0);
        let waves = vec![vec![&settled_a], vec![&settled_b]];
        assert_eq!(current_wave(&waves), 2);
        assert_eq!(current_wave(&[]), 0);
    }

    #[test]
    fn context_workspace_extraction() {
        let live = r#"{"workspace_id":"w1","workspace_label":"xlshcn","workspace_cwd":"/Users/a/harness","tab_id":"w1:t7","focused_pane_id":"w1:p4","focused_pane_cwd":"/Users/a/xlshcn","invocation_source":"api"}"#;
        assert_eq!(
            context_workspace(live),
            Some(PathBuf::from("/Users/a/xlshcn")),
            "the focused pane wins over the workspace root"
        );
        let workspace_only = r#"{"workspace_cwd":"/Users/a/harness"}"#;
        assert_eq!(
            context_workspace(workspace_only),
            Some(PathBuf::from("/Users/a/harness"))
        );
        assert_eq!(context_workspace(r#"{"tab_id":"w1:t7"}"#), None);
        assert_eq!(context_workspace("not json"), None);
        assert_eq!(context_workspace(""), None);
        let relative = r#"{"focused_pane_cwd":"proj"}"#;
        assert_eq!(context_workspace(relative), None, "only absolute roots count");
    }

    #[test]
    fn totals_buckets_statuses() {
        let tasks = vec![
            task("t1", "done", 0),
            task("t2", "done", 0),
            task("t3", "cancelled", 0),
            task("t4", "assigned", 0),
            task("t5", "executing", 0),
            task("t6", "verifying", 0),
            task("t7", "ready", 0),
            task("t8", "pending", 0),
            task("t9", "blocked", 0),
        ];
        let sums = totals(&tasks);
        assert_eq!(
            sums,
            Totals {
                done: 2,
                cancelled: 1,
                in_flight: 3,
                waiting: 3,
                total: 9
            }
        );
        assert_eq!(sums.resolved(), 3);
    }

    #[test]
    fn ratio_and_bar() {
        let empty = totals(&[]);
        assert_eq!(empty.ratio(), 1.0);
        let half = Totals {
            done: 2,
            cancelled: 0,
            in_flight: 1,
            waiting: 1,
            total: 4,
        };
        assert_eq!(progress_bar(half, 4), "▓▓░░");
        assert_eq!(progress_bar(Totals::default(), 0), "");
    }

    #[test]
    fn age_string_boundaries() {
        assert_eq!(age_string(0), "now");
        assert_eq!(age_string(59_999), "59s");
        assert_eq!(age_string(60_000), "1m");
        assert_eq!(age_string(3_599_999), "59m");
        assert_eq!(age_string(3_600_000), "1h");
        assert_eq!(age_string(86_400_000), "1d");
    }

    fn empty_node() -> NodeCard {
        NodeCard {
            session_id: String::new(),
            roles: vec![],
            heartbeat_at: 0,
            model: None,
            pane_id: None,
            skills: vec![],
        }
    }

    #[test]
    fn liveness_window() {
        let node = NodeCard {
            heartbeat_at: 1_000_000,
            ..empty_node()
        };
        assert_eq!(node.age_ms(1_000_000 + STALE_MS), STALE_MS);
        assert_eq!(node.age_ms(0), 0);
        assert_eq!(
            NodeCard {
                heartbeat_at: 0,
                ..empty_node()
            }
            .age_ms(u64::MAX),
            u64::MAX
        );
    }

    #[test]
    fn slug_cuts_the_hash() {
        assert_eq!(slug("llm#ab12cd"), "llm");
        assert_eq!(slug("plain"), "plain");
    }

    #[test]
    fn short_ids_for_display() {
        assert_eq!(short_id("6779ac37-20df-4479"), "6779ac37");
        assert_eq!(short_id("w1"), "w1");
        assert_eq!(plan_short("plan-2b9322eb-81c0"), "2b9322eb");
        assert_eq!(plan_short("a1"), "a1");
    }

    #[test]
    fn role_tags() {
        let mut node = empty_node();
        node.roles = vec!["worker".to_string()];
        assert_eq!(node.role_tag(), "w");
        node.roles = vec!["worker".to_string(), "reviewer".to_string()];
        assert_eq!(node.role_tag(), "+");
        node.roles = vec!["master".to_string(), "worker".to_string()];
        assert_eq!(node.role_tag(), "m");
    }

    // ---- fixture-driven loading ----

    fn fixture_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("coop-board-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("fixture root");
        dir
    }

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("fixture dir");
        fs::write(path, body).expect("fixture file");
    }

    #[test]
    fn load_v2_layers_workspace_masters_nodes_plans() {
        let root = fixture_root("v2");
        let coop = root.join(".dsh").join("coop");
        write(
            &coop.join("v2").join("registry.json"),
            r#"{"version":2,"entries":[
                {"sessionId":"s-master","roles":["master"],"masterId":"llm#abc","bindState":"bound","heartbeatAt":900},
                {"sessionId":"s-worker","roles":["worker"],"masterId":"llm#abc","bindState":"bound","heartbeatAt":800,"meta":{"model":"glm-5.3","paneId":"w1:p1"},"skills":["rust"]},
                {"sessionId":"s-free","roles":["worker"],"bindState":"unbound","heartbeatAt":700}
            ]}"#,
        );
        write(
            &coop
                .join("v2")
                .join("masters")
                .join("llm#abc")
                .join("profile.json"),
            r#"{"masterId":"llm#abc","sessionId":"s-master","displayName":"relay","createdAt":1,"status":"active"}"#,
        );
        write(
            &coop
                .join("v2")
                .join("masters")
                .join("llm#abc")
                .join("plans")
                .join("p1.json"),
            r#"{"version":2,"planId":"p1","masterId":"llm#abc","repoRoot":"/r","title":"Ship","objective":"o","status":"active","createdBy":"s-master","cwd":"/r","createdAt":10,"tasks":[
                {"taskId":"t1","title":"setup","spec":"","status":"done","dependsOn":[],"executor":"inline","skills":[],"attempts":0,"createdAt":10,"updatedAt":50},
                {"taskId":"t2","title":"auth","spec":"","status":"executing","dependsOn":["t1"],"executor":"inline","skills":[],"attempts":1,"createdAt":10,"updatedAt":90}
            ],"edges":[],"history":[]}"#,
        );
        write(
            &coop.join("v2").join("wt-registry.json"),
            r#"{"version":1,"entries":[{"dir":"/wt/a","masterId":"llm#abc","planId":"p1","status":"active"},{"dir":"/wt/b","masterId":"llm#abc","planId":"p1","status":"merged"}]}"#,
        );

        let snap = load_v2(&root);
        assert_eq!(snap.masters.len(), 1);
        let master = &snap.masters[0];
        assert_eq!(master.display_name, "relay");
        assert_eq!(master.workers(), 1);
        assert_eq!(master.plans.len(), 1);
        assert_eq!(master.plans[0].totals.done, 1);
        assert_eq!(master.plans[0].totals.in_flight, 1);
        assert_eq!(master.plans[0].updated_at, 90);
        assert_eq!(snap.unbound.len(), 1);
        assert_eq!(snap.worktrees_active, 1);
        assert_eq!(snap.masters[0].plans[0].worktrees, 1);
        assert!(!snap.anchored);
        assert_eq!(snap.plans(), 1);
        assert_eq!(snap.active_plans(), 1);
        assert_eq!(snap.bound_nodes(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn plan_ordering_runs_first_terminal_last() {
        let root = fixture_root("order");
        let coop = root.join(".dsh").join("coop");
        write(
            &coop.join("v2").join("registry.json"),
            r#"{"version":2,"entries":[{"sessionId":"m","roles":["master"],"masterId":"m#1","bindState":"bound","heartbeatAt":1}]}"#,
        );
        let plans = coop.join("v2").join("masters").join("m#1").join("plans");
        for (id, status, updated) in [
            ("a", "closed", 900),
            ("b", "active", 100),
            ("c", "active", 500),
            ("d", "designing", 999),
        ] {
            write(
                &plans.join(format!("{id}.json")),
                &format!(
                    r#"{{"version":2,"planId":"{id}","title":"{id}","status":"{status}","createdAt":{updated},"tasks":[]}}"#
                ),
            );
        }
        let snap = load_v2(&root);
        let order: Vec<&str> = snap.masters[0]
            .plans
            .iter()
            .map(|plan| plan.plan_id.as_str())
            .collect();
        assert_eq!(order, vec!["c", "b", "d", "a"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn load_v1_reads_registry_and_plans() {
        let root = fixture_root("v1");
        let coop = root.join(".dsh").join("coop");
        write(
            &coop.join("registry.json"),
            r#"{"version":1,"entries":[{"sessionId":"s1","roles":["master","worker"],"updatedAt":1,"heartbeatAt":2,"cwd":"/r","cwdScope":"cwd"}]}"#,
        );
        write(
            &coop.join("plans").join("plan-2.json"),
            r#"{"version":1,"planId":"plan-2","docPath":"/d","title":"Two","objective":"","status":"executing","createdBy":"s1","cwd":"/r","reviewLevel":"standard","history":[]}"#,
        );
        let snap = load_v1(&root);
        assert_eq!(snap.nodes.len(), 1);
        assert_eq!(snap.plans.len(), 1);
        assert_eq!(snap.plans[0].status, "executing");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn discover_walks_up_to_marker() {
        let root = fixture_root("walk");
        let coop = root.join(".dsh").join("coop");
        write(&coop.join("v2").join("registry.json"), "{}");
        let deep = root.join("a").join("b");
        fs::create_dir_all(&deep).expect("deep dir");
        let (found, v1, v2) = discover(deep);
        assert_eq!(found, root);
        assert!(!v1);
        assert!(v2);
        let _ = fs::remove_dir_all(&root);
    }
}
