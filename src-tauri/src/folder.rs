//! Folder comparison and synchronization.

use crate::fileio::modified_ms;
use crate::quick::{crc32_file, files_binary_equal, rules_verdict, BINARY_SAME, RULES_SAME, SIMILAR};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FolderOptions {
    /// "timesize" | "size" | "binary" | "crc" | "rules"
    pub criteria: String,
    pub time_tolerance_secs: i64,
    /// Semicolon separated include masks for files (e.g. "*.rs;*.toml").
    pub include: String,
    /// Semicolon separated exclude masks for files and folders.
    pub exclude: String,
    pub ignore_case_names: bool,
    pub follow_symlinks: bool,
    /// Items forced to be compared with each other although their names differ ("Align With").
    pub align: Vec<Alignment>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Alignment {
    /// Relative path of the parent folder ("" for the base folder), as shown on the left.
    pub parent: String,
    pub left: String,
    pub right: String,
}

impl FolderOptions {
    fn eq_names(&self, a: &str, b: &str) -> bool {
        if self.ignore_case_names { a.to_lowercase() == b.to_lowercase() } else { a == b }
    }
}

impl Default for FolderOptions {
    fn default() -> Self {
        FolderOptions {
            criteria: "timesize".into(),
            time_tolerance_secs: 2,
            include: "*".into(),
            exclude: String::new(),
            ignore_case_names: cfg!(any(windows, target_os = "macos")),
            follow_symlinks: false,
            align: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub name: String,
    pub size: u64,
    pub modified: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Same,
    Similar,
    Diff,
    Left,
    Right,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub name: String,
    pub rel: String,
    pub dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<Side>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<Side>,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub newer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Node>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub files: u32,
    pub same: u32,
    pub similar: u32,
    pub diff: u32,
    pub left_only: u32,
    pub right_only: u32,
    pub errors: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderResult {
    pub root: Node,
    pub summary: Summary,
}

/// Case-insensitive glob match supporting `*` and `?`.
pub fn glob_match(pattern: &str, name: &str) -> bool {
    // "*." selects names without an extension, as in the reference tool's filters.
    if pattern == "*." {
        return !name.contains('.');
    }
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut mark) = (None, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

struct Masks {
    include: Vec<String>,
    exclude_files: Vec<String>,
    exclude_dirs: Vec<String>,
    /// Excludes anchored to the base folder (e.g. "/src/gen/" or "\docs\a.txt"), matched against the relative path.
    exclude_rel_files: Vec<String>,
    exclude_rel_dirs: Vec<String>,
}

/// Normalizes a base-anchored mask to "a/b" form, or None for a plain name mask.
fn rel_mask(m: &str) -> Option<String> {
    let t = m.replace('\\', "/");
    if !t.contains('/') {
        return None;
    }
    Some(t.trim_start_matches('/').to_string())
}

impl Masks {
    fn new(o: &FolderOptions) -> Masks {
        let split = |s: &str| -> Vec<String> {
            s.split(';').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
        };
        // As in the reference tool's -filters syntax, a leading '-' marks an exclusion.
        let (negated, mut include): (Vec<String>, Vec<String>) = split(&o.include).into_iter().partition(|m| m.starts_with('-'));
        include.retain(|m| !m.ends_with('/') && !m.ends_with('\\'));
        if include.is_empty() {
            include.push("*".into());
        }
        let mut masks = Masks { include, exclude_files: vec![], exclude_dirs: vec![], exclude_rel_files: vec![], exclude_rel_dirs: vec![] };
        let excludes = split(&o.exclude).into_iter().chain(negated.into_iter().map(|m| m[1..].to_string()));
        for m in excludes {
            let dir_only = m.ends_with('/') || m.ends_with('\\');
            let body = m.trim_end_matches(['/', '\\']).to_string();
            match rel_mask(&body) {
                Some(r) => {
                    if !dir_only {
                        masks.exclude_rel_files.push(r.clone());
                    }
                    masks.exclude_rel_dirs.push(r);
                }
                None => {
                    if !dir_only {
                        masks.exclude_files.push(body.clone());
                    }
                    masks.exclude_dirs.push(body);
                }
            }
        }
        masks
    }
    fn file_ok(&self, name: &str, rel: &str) -> bool {
        self.include.iter().any(|m| glob_match(m, name))
            && !self.exclude_files.iter().any(|m| glob_match(m, name))
            && !self.exclude_rel_files.iter().any(|m| glob_match(m, rel))
    }
    fn dir_ok(&self, name: &str, rel: &str) -> bool {
        !self.exclude_dirs.iter().any(|m| glob_match(m, name)) && !self.exclude_rel_dirs.iter().any(|m| glob_match(m, rel))
    }
}

fn child_rel(rel: &str, name: &str) -> String {
    if rel.is_empty() { name.to_string() } else { format!("{rel}/{name}") }
}

struct Listing {
    entries: BTreeMap<(String, bool), (String, fs::Metadata)>,
}

fn list(dir: &Path, rel: &str, o: &FolderOptions, masks: &Masks) -> io::Result<Listing> {
    let mut entries = BTreeMap::new();
    for e in fs::read_dir(dir)? {
        let e = match e {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = e.file_name().to_string_lossy().into_owned();
        let meta = if o.follow_symlinks { fs::metadata(e.path()) } else { fs::symlink_metadata(e.path()) };
        let meta = match meta {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let crel = child_rel(rel, &name);
        if (is_dir && !masks.dir_ok(&name, &crel)) || (!is_dir && !masks.file_ok(&name, &crel)) {
            continue;
        }
        let key = if o.ignore_case_names { name.to_lowercase() } else { name.clone() };
        entries.insert((key, is_dir), (name, meta));
    }
    Ok(Listing { entries })
}

fn side(name: &str, m: &fs::Metadata) -> Side {
    Side { name: name.into(), size: if m.is_dir() { 0 } else { m.len() }, modified: modified_ms(m) }
}

fn compare_files(lp: &Path, rp: &Path, l: &Side, r: &Side, o: &FolderOptions) -> io::Result<Status> {
    let same_size = l.size == r.size;
    Ok(match o.criteria.as_str() {
        "size" => if same_size { Status::Same } else { Status::Diff },
        "binary" => if same_size && files_binary_equal(lp, rp)? { Status::Same } else { Status::Diff },
        "crc" => if same_size && crc32_file(lp)? == crc32_file(rp)? { Status::Same } else { Status::Diff },
        "rules" => {
            if same_size && files_binary_equal(lp, rp)? {
                Status::Same
            } else if l.size > 32 * 1024 * 1024 || r.size > 32 * 1024 * 1024 {
                Status::Diff
            } else {
                match rules_verdict(&fs::read(lp)?, &fs::read(rp)?) {
                    BINARY_SAME | RULES_SAME => Status::Same,
                    SIMILAR => Status::Similar,
                    _ => Status::Diff,
                }
            }
        }
        _ => {
            let tol = o.time_tolerance_secs.max(0) * 1000;
            let times_eq = match (l.modified, r.modified) {
                (Some(a), Some(b)) => (a - b).abs() <= tol,
                _ => false,
            };
            if same_size && times_eq { Status::Same } else { Status::Diff }
        }
    })
}

fn newer(l: &Side, r: &Side, o: &FolderOptions) -> Option<String> {
    let tol = o.time_tolerance_secs.max(0) * 1000;
    match (l.modified, r.modified) {
        (Some(a), Some(b)) if a - b > tol => Some("left".into()),
        (Some(a), Some(b)) if b - a > tol => Some("right".into()),
        _ => None,
    }
}

fn orphan_tree(base: &Path, rel: &str, name: &str, m: &fs::Metadata, left: bool, o: &FolderOptions, masks: &Masks, sum: &mut Summary) -> Node {
    let s = side(name, m);
    let mut node = Node {
        name: name.into(),
        rel: rel.into(),
        dir: m.is_dir(),
        left: if left { Some(s.clone()) } else { None },
        right: if left { None } else { Some(s) },
        status: if left { Status::Left } else { Status::Right },
        newer: None,
        error: None,
        children: vec![],
    };
    if m.is_dir() {
        match list(&base.join(name), rel, o, masks) {
            Ok(l) => {
                for ((_, _), (cname, cm)) in l.entries {
                    let crel = format!("{rel}/{cname}");
                    node.children.push(orphan_tree(&base.join(name), &crel, &cname, &cm, left, o, masks, sum));
                }
            }
            Err(e) => node.error = Some(e.to_string()),
        }
    } else {
        sum.files += 1;
        if left { sum.left_only += 1 } else { sum.right_only += 1 }
    }
    node
}

fn compare_dirs(lp: &Path, rp: &Path, rel: &str, o: &FolderOptions, masks: &Masks, sum: &mut Summary) -> io::Result<Vec<Node>> {
    let ll = list(lp, rel, o, masks)?;
    let rl = list(rp, rel, o, masks)?;
    // Aligned pairs: the right entry is listed under the left entry's key.
    let mut aligned: BTreeMap<(String, bool), (String, bool)> = BTreeMap::new();
    for a in o.align.iter().filter(|a| o.eq_names(&a.parent, rel)) {
        let find = |l: &Listing, name: &str| l.entries.iter().find(|(_, (n, _))| o.eq_names(n, name)).map(|(k, _)| k.clone());
        if let (Some(lk), Some(rk)) = (find(&ll, &a.left), find(&rl, &a.right)) {
            if lk.1 == rk.1 && lk != rk {
                aligned.insert(lk, rk);
            }
        }
    }
    let hidden: Vec<&(String, bool)> = aligned.values().collect();
    let mut keys: Vec<(String, bool)> = ll.entries.keys().chain(rl.entries.keys().filter(|k| !hidden.contains(k))).cloned().collect();
    keys.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())).then_with(|| a.0.cmp(&b.0)));
    keys.dedup();
    let mut out = Vec::new();
    for key in keys {
        let l = ll.entries.get(&key);
        let r = match aligned.get(&key) {
            Some(rk) if l.is_some() => rl.entries.get(rk),
            // A right entry consumed by an alignment is not also paired by name.
            _ if hidden.contains(&&key) => None,
            _ => rl.entries.get(&key),
        };
        if l.is_none() && r.is_none() {
            continue;
        }
        let name = l.or(r).map(|x| x.0.clone()).unwrap_or_default();
        let crel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let node = match (l, r) {
            (Some((ln, lm)), None) => orphan_tree(lp, &crel, ln, lm, true, o, masks, sum),
            (None, Some((rn, rm))) => orphan_tree(rp, &crel, rn, rm, false, o, masks, sum),
            (Some((ln, lm)), Some((rn, rm))) => pair_node(lp, rp, &crel, ln, lm, rn, rm, o, masks, sum),
            (None, None) => continue,
        };
        out.push(node);
    }
    Ok(out)
}

/// Compares an item present on both sides (`lp`/`rp` are the parent folders).
#[allow(clippy::too_many_arguments)]
fn pair_node(lp: &Path, rp: &Path, crel: &str, ln: &str, lm: &fs::Metadata, rn: &str, rm: &fs::Metadata, o: &FolderOptions, masks: &Masks, sum: &mut Summary) -> Node {
    let ls = side(ln, lm);
    let rs = side(rn, rm);
    let name = ln.to_string();
    if lm.is_dir() {
        let mut node = Node {
            name,
            rel: crel.into(),
            dir: true,
            left: Some(ls),
            right: Some(rs),
            status: Status::Same,
            newer: None,
            error: None,
            children: vec![],
        };
        match compare_dirs(&lp.join(ln), &rp.join(rn), crel, o, masks, sum) {
            Ok(ch) => {
                node.status = folder_status(&ch);
                node.children = ch;
            }
            Err(e) => {
                node.status = Status::Error;
                node.error = Some(e.to_string());
                sum.errors += 1;
            }
        }
        node
    } else {
        sum.files += 1;
        let (status, error) = match compare_files(&lp.join(ln), &rp.join(rn), &ls, &rs, o) {
            Ok(s) => (s, None),
            Err(e) => (Status::Error, Some(e.to_string())),
        };
        match status {
            Status::Same => sum.same += 1,
            Status::Similar => sum.similar += 1,
            Status::Error => sum.errors += 1,
            _ => sum.diff += 1,
        }
        let nw = if status == Status::Diff { newer(&ls, &rs, o) } else { None };
        Node { name, rel: crel.into(), dir: false, left: Some(ls), right: Some(rs), status, newer: nw, error, children: vec![] }
    }
}

/// Finds `name` inside `dir`, falling back to a case-insensitive match when names are compared that way.
fn resolve_child(dir: &Path, name: &str, o: &FolderOptions) -> Option<(String, fs::Metadata)> {
    let meta = |p: &Path| if o.follow_symlinks { fs::metadata(p) } else { fs::symlink_metadata(p) };
    if let Ok(m) = meta(&dir.join(name)) {
        return Some((name.to_string(), m));
    }
    if !o.ignore_case_names {
        return None;
    }
    let lower = name.to_lowercase();
    fs::read_dir(dir).ok()?.flatten().find_map(|e| {
        let n = e.file_name().to_string_lossy().into_owned();
        if n.to_lowercase() == lower { meta(&e.path()).ok().map(|m| (n, m)) } else { None }
    })
}

/// Right-side name of an item aligned with a differently named one.
fn aligned_right<'a>(parent: &str, name: &str, o: &'a FolderOptions) -> Option<&'a str> {
    o.align.iter().find(|a| o.eq_names(&a.parent, parent) && o.eq_names(&a.left, name)).map(|a| a.right.as_str())
}

/// Maps a relative path (left names) to the right side's names, following alignments.
pub fn right_rel(rel: &str, o: &FolderOptions) -> String {
    let mut parent = String::new();
    let mut out: Vec<String> = vec![];
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        out.push(aligned_right(&parent, seg, o).unwrap_or(seg).to_string());
        parent = child_rel(&parent, seg);
    }
    out.join("/")
}

/// Re-compares a single item (Refresh Selection / Compare Contents). Returns None when it no longer exists
/// on either side or is now filtered out.
pub fn compare_item(left: &str, right: &str, rel: &str, o: &FolderOptions) -> Option<Node> {
    let masks = Masks::new(o);
    let mut sum = Summary::default();
    let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    let lp = join_rel(left, parent);
    let rp = join_rel(right, &right_rel(parent, o));
    let l = resolve_child(&lp, name, o);
    let r = resolve_child(&rp, aligned_right(parent, name, o).unwrap_or(name), o);
    let is_dir = l.as_ref().or(r.as_ref())?.1.is_dir();
    if (is_dir && !masks.dir_ok(name, rel)) || (!is_dir && !masks.file_ok(name, rel)) {
        return None;
    }
    Some(match (l, r) {
        (Some((ln, lm)), Some((rn, rm))) if lm.is_dir() == rm.is_dir() => pair_node(&lp, &rp, rel, &ln, &lm, &rn, &rm, o, &masks, &mut sum),
        (Some((ln, lm)), _) => orphan_tree(&lp, rel, &ln, &lm, true, o, &masks, &mut sum),
        (None, Some((rn, rm))) => orphan_tree(&rp, rel, &rn, &rm, false, o, &masks, &mut sum),
        (None, None) => return None,
    })
}

fn folder_status(children: &[Node]) -> Status {
    if children.iter().any(|c| matches!(c.status, Status::Diff | Status::Left | Status::Right | Status::Error)) {
        Status::Diff
    } else if children.iter().any(|c| c.status == Status::Similar) {
        Status::Similar
    } else {
        Status::Same
    }
}

pub fn compare_folders(left: &str, right: &str, o: &FolderOptions) -> io::Result<FolderResult> {
    let lp = Path::new(left);
    let rp = Path::new(right);
    if !lp.is_dir() {
        return Err(io::Error::other(format!("Left folder not found: {left}")));
    }
    if !rp.is_dir() {
        return Err(io::Error::other(format!("Right folder not found: {right}")));
    }
    let masks = Masks::new(o);
    let mut sum = Summary::default();
    let children = compare_dirs(lp, rp, "", o, &masks, &mut sum)?;
    let lm = fs::metadata(lp)?;
    let rm = fs::metadata(rp)?;
    let root = Node {
        name: String::new(),
        rel: String::new(),
        dir: true,
        left: Some(side(left, &lm)),
        right: Some(side(right, &rm)),
        status: folder_status(&children),
        newer: None,
        error: None,
        children,
    };
    Ok(FolderResult { root, summary: sum })
}

// ---------------------------------------------------------------- sync

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    /// "copy" | "move" | "delete" | "rename" | "mkdir" | "touch" | "chmod"
    pub op: String,
    /// Source path (copy, move, rename) or, for touch, the item whose timestamp is copied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    pub to: String,
    pub rel: String,
    pub dir: bool,
    pub size: u64,
    /// touch: new modification time in ms since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<i64>,
    /// chmod: permission bits to set, limited to `mask`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask: Option<u32>,
    /// touch: also apply to folder contents.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub recursive: bool,
}

pub fn join_rel(root: &str, rel: &str) -> PathBuf {
    let mut p = PathBuf::from(root);
    for part in rel.split('/').filter(|s| !s.is_empty()) {
        p.push(part);
    }
    p
}

fn tree_size(n: &Node, left: bool) -> u64 {
    if n.dir {
        n.children.iter().map(|c| tree_size(c, left)).sum()
    } else {
        let s = if left { &n.left } else { &n.right };
        s.as_ref().map(|s| s.size).unwrap_or(0)
    }
}

/// Modes: update-right, update-left, update-both, mirror-right, mirror-left.
pub fn plan_sync(root: &Node, left_root: &str, right_root: &str, mode: &str) -> Vec<Action> {
    let mut out = Vec::new();
    for c in &root.children {
        plan_node(c, Path::new(left_root), Path::new(right_root), mode, &mut out);
    }
    out
}

/// Path of a node's item on one side, below that side's parent folder (names can differ by case or alignment).
fn node_path(parent: &Path, n: &Node, left: bool) -> PathBuf {
    let s = if left { &n.left } else { &n.right };
    parent.join(s.as_ref().map(|s| s.name.as_str()).unwrap_or(&n.name))
}

fn copy_action(n: &Node, src_parent: &Path, dst_parent: &Path, from_left: bool) -> Action {
    let src = node_path(src_parent, n, from_left);
    // Replace the existing target item; otherwise keep the source side's name.
    let dst = if (if from_left { &n.right } else { &n.left }).is_some() { node_path(dst_parent, n, !from_left) } else { node_path(dst_parent, n, from_left) };
    Action {
        op: "copy".into(),
        from: Some(src.to_string_lossy().into_owned()),
        to: dst.to_string_lossy().into_owned(),
        rel: n.rel.clone(),
        dir: n.dir,
        size: tree_size(n, from_left),
        ..Action::default()
    }
}

fn delete_action(n: &Node, parent: &Path, left: bool) -> Action {
    Action {
        op: "delete".into(),
        to: node_path(parent, n, left).to_string_lossy().into_owned(),
        rel: n.rel.clone(),
        dir: n.dir,
        size: tree_size(n, left),
        ..Action::default()
    }
}

fn plan_node(n: &Node, lp: &Path, rp: &Path, mode: &str, out: &mut Vec<Action>) {
    let to_right = matches!(mode, "update-right" | "update-both" | "mirror-right");
    let to_left = matches!(mode, "update-left" | "update-both" | "mirror-left");
    let mirror = mode.starts_with("mirror");
    match n.status {
        Status::Left => {
            if to_right {
                out.push(copy_action(n, lp, rp, true));
            } else if mirror {
                out.push(delete_action(n, lp, true));
            }
        }
        Status::Right => {
            if to_left {
                out.push(copy_action(n, rp, lp, false));
            } else if mirror {
                out.push(delete_action(n, rp, false));
            }
        }
        _ if n.dir => {
            let (l, r) = (node_path(lp, n, true), node_path(rp, n, false));
            for c in &n.children {
                plan_node(c, &l, &r, mode, out);
            }
        }
        Status::Diff => {
            let newer = n.newer.as_deref();
            if mirror {
                if to_right {
                    out.push(copy_action(n, lp, rp, true));
                } else {
                    out.push(copy_action(n, rp, lp, false));
                }
            } else if to_right && newer == Some("left") {
                out.push(copy_action(n, lp, rp, true));
            } else if to_left && newer == Some("right") {
                out.push(copy_action(n, rp, lp, false));
            }
        }
        _ => {}
    }
}

fn copy_file_preserving(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(p) = to.parent() {
        fs::create_dir_all(p)?;
    }
    fs::copy(from, to)?;
    if let Ok(m) = fs::metadata(from).and_then(|m| m.modified()) {
        if let Ok(f) = fs::OpenOptions::new().write(true).open(to) {
            let _ = f.set_modified(m);
        }
    }
    Ok(())
}

pub fn copy_recursive(from: &Path, to: &Path) -> io::Result<()> {
    let m = fs::symlink_metadata(from)?;
    if m.is_dir() {
        fs::create_dir_all(to)?;
        for e in fs::read_dir(from)? {
            let e = e?;
            copy_recursive(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        copy_file_preserving(from, to)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub rel: String,
    pub op: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn execute(actions: &[Action], use_trash: bool) -> Vec<ActionResult> {
    actions
        .iter()
        .map(|a| {
            let to = Path::new(&a.to);
            let from = a.from.as_deref().map(Path::new);
            let need_from = || from.ok_or_else(|| io::Error::other(format!("{} without source", a.op)));
            let res: io::Result<()> = match a.op.as_str() {
                "copy" => need_from().and_then(|f| {
                    // Replacing a folder with a file (or vice versa) requires removal first.
                    if to.exists() && to.is_dir() != f.is_dir() {
                        remove(to, use_trash)?;
                    }
                    copy_recursive(f, to)
                }),
                "move" => need_from().and_then(|f| {
                    if to.exists() && to.is_dir() != f.is_dir() {
                        remove(to, use_trash)?;
                    }
                    move_item(f, to)
                }),
                "delete" => remove(to, use_trash),
                "rename" => need_from().and_then(|f| rename_item(f, to)),
                "mkdir" => fs::create_dir_all(to),
                "touch" => match (a.time, from) {
                    (_, Some(f)) => touch_from(f, to, a.recursive),
                    (Some(t), None) => touch_at(to, t, a.recursive),
                    _ => Err(io::Error::other("touch without time or source")),
                },
                "chmod" => set_mode(to, a.mode.unwrap_or(0), a.mask.unwrap_or(0o777)),
                other => Err(io::Error::other(format!("unknown op {other}"))),
            };
            ActionResult { rel: a.rel.clone(), op: a.op.clone(), ok: res.is_ok(), error: res.err().map(|e| e.to_string()) }
        })
        .collect()
}

/// Moves a file or folder, merging into an existing target folder and falling back to copy + delete
/// across file systems.
fn move_item(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(p) = to.parent() {
        fs::create_dir_all(p)?;
    }
    let src_dir = fs::symlink_metadata(from)?.is_dir();
    if src_dir && to.is_dir() {
        for e in fs::read_dir(from)? {
            let e = e?;
            move_item(&e.path(), &to.join(e.file_name()))?;
        }
        return fs::remove_dir(from);
    }
    if !src_dir && to.is_file() {
        fs::remove_file(to)?;
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_recursive(from, to)?;
    remove(from, false)
}

fn rename_item(from: &Path, to: &Path) -> io::Result<()> {
    // A case-only rename on a case-insensitive file system reports the target as existing.
    let same = |a: &Path, b: &Path| a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase();
    if to.symlink_metadata().is_ok() && !same(from, to) {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} already exists", to.display())));
    }
    fs::rename(from, to)
}

fn set_mtime(p: &Path, ms: i64) -> io::Result<()> {
    let t = filetime::FileTime::from_unix_time(ms.div_euclid(1000), (ms.rem_euclid(1000) * 1_000_000) as u32);
    filetime::set_symlink_file_times(p, filetime::FileTime::from_last_access_time(&fs::symlink_metadata(p)?), t)
}

fn touch_at(p: &Path, ms: i64, recursive: bool) -> io::Result<()> {
    if recursive && fs::symlink_metadata(p)?.is_dir() {
        for e in fs::read_dir(p)? {
            touch_at(&e?.path(), ms, true)?;
        }
    }
    set_mtime(p, ms)
}

/// Copies the timestamp of `src` (and, recursively, of matching children) onto `dst`.
fn touch_from(src: &Path, dst: &Path, recursive: bool) -> io::Result<()> {
    if recursive && fs::symlink_metadata(dst)?.is_dir() && src.is_dir() {
        for e in fs::read_dir(dst)? {
            let e = e?;
            let s = src.join(e.file_name());
            if s.symlink_metadata().is_ok() {
                touch_from(&s, &e.path(), true)?;
            }
        }
    }
    let ms = modified_ms(&fs::symlink_metadata(src)?).ok_or_else(|| io::Error::other("source has no timestamp"))?;
    set_mtime(dst, ms)
}

/// Sets the permission bits selected by `mask` to their value in `mode`. On Windows only the
/// owner-write bit is meaningful and maps to the read-only attribute.
fn set_mode(p: &Path, mode: u32, mask: u32) -> io::Result<()> {
    let m = fs::metadata(p)?;
    let mut perms = m.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let cur = perms.mode();
        perms.set_mode((cur & !mask) | (mode & mask));
    }
    #[cfg(not(unix))]
    if mask & 0o200 != 0 {
        perms.set_readonly(mode & 0o200 == 0);
    }
    fs::set_permissions(p, perms)
}

/// Facts about a path used by the file-operation dialogs (replace confirmation, attributes).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInfo {
    pub exists: bool,
    pub dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
    /// Unix permission bits (on Windows: 0o444, plus 0o222 unless read-only).
    pub mode: u32,
}

pub fn item_info(p: &Path) -> ItemInfo {
    match fs::symlink_metadata(p) {
        Ok(m) => {
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                m.permissions().mode() & 0o7777
            };
            #[cfg(not(unix))]
            let mode = if m.permissions().readonly() { 0o444 } else { 0o666 };
            ItemInfo { exists: true, dir: m.is_dir(), size: if m.is_dir() { 0 } else { m.len() }, modified: modified_ms(&m), mode }
        }
        Err(_) => ItemInfo { exists: false, dir: false, size: 0, modified: None, mode: 0 },
    }
}

fn remove(p: &Path, use_trash: bool) -> io::Result<()> {
    if use_trash {
        if trash::delete(p).is_ok() {
            return Ok(());
        }
    }
    if fs::symlink_metadata(p)?.is_dir() {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn write(p: &Path, s: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, s).unwrap();
    }
    fn set_time(p: &Path, secs_ago: u64) {
        let f = fs::OpenOptions::new().write(true).open(p).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(secs_ago)).unwrap();
    }

    #[test]
    fn glob() {
        assert!(glob_match("*.rs", "main.RS"));
        assert!(glob_match("a?c*", "abcdef"));
        assert!(!glob_match("*.rs", "main.rsx"));
        assert!(glob_match("*", ""));
        assert!(glob_match("*.", "Makefile") && !glob_match("*.", "a.txt"));
    }

    #[test]
    fn negated_include_masks_exclude() {
        let (_d, l, r) = fixture();
        let o = FolderOptions { include: "*.txt;-sub/;-.git/".into(), ..Default::default() };
        let res = compare_folders(&l, &r, &o).unwrap();
        let names: Vec<&str> = res.root.children.iter().map(|c| c.rel.as_str()).collect();
        assert!(!names.contains(&"sub") && !names.contains(&".git"), "{names:?}");
        assert!(names.contains(&"same.txt"));
    }

    fn fixture() -> (tempfile::TempDir, String, String) {
        let d = tempfile::tempdir().unwrap();
        let l = d.path().join("L");
        let r = d.path().join("R");
        write(&l.join("same.txt"), "hello");
        write(&r.join("same.txt"), "hello");
        write(&l.join("changed.txt"), "left version");
        write(&r.join("changed.txt"), "right");
        write(&l.join("onlyleft.txt"), "x");
        write(&r.join("sub/onlyright.txt"), "y");
        write(&l.join("sub/ws.txt"), "a  b\n");
        write(&r.join("sub/ws.txt"), "a b\r\n");
        write(&l.join(".git/HEAD"), "ref");
        let t = 1000;
        for p in ["same.txt", "sub/ws.txt"] {
            set_time(&l.join(p), t);
            set_time(&r.join(p), t);
        }
        set_time(&l.join("changed.txt"), 10);
        set_time(&r.join("changed.txt"), 5000);
        (d, l.to_string_lossy().into(), r.to_string_lossy().into())
    }

    fn find<'a>(n: &'a Node, rel: &str) -> &'a Node {
        if n.rel == rel {
            return n;
        }
        for c in &n.children {
            if rel.starts_with(&c.rel) {
                return find(c, rel);
            }
        }
        panic!("{rel} not found");
    }

    #[test]
    fn compares_and_syncs() {
        let (_d, l, r) = fixture();
        let o = FolderOptions { exclude: ".git/".into(), criteria: "rules".into(), ..Default::default() };
        let res = compare_folders(&l, &r, &o).unwrap();
        let root = &res.root;
        assert_eq!(find(root, "same.txt").status, Status::Same);
        assert_eq!(find(root, "changed.txt").status, Status::Diff);
        assert_eq!(find(root, "changed.txt").newer.as_deref(), Some("left"));
        assert_eq!(find(root, "onlyleft.txt").status, Status::Left);
        assert_eq!(find(root, "sub/onlyright.txt").status, Status::Right);
        assert_eq!(find(root, "sub/ws.txt").status, Status::Similar);
        assert!(root.children.iter().all(|c| c.name != ".git"));
        assert_eq!(res.summary.left_only, 1);
        assert_eq!(res.summary.right_only, 1);

        let plan = plan_sync(root, &l, &r, "mirror-right");
        let ops: Vec<(String, String)> = plan.iter().map(|a| (a.op.clone(), a.rel.clone())).collect();
        assert!(ops.contains(&("copy".into(), "changed.txt".into())));
        assert!(ops.contains(&("copy".into(), "onlyleft.txt".into())));
        assert!(ops.contains(&("delete".into(), "sub/onlyright.txt".into())));
        let results = execute(&plan, false);
        assert!(results.iter().all(|r| r.ok), "{results:?}");

        let o2 = FolderOptions { exclude: ".git/".into(), criteria: "binary".into(), ..Default::default() };
        let after = compare_folders(&l, &r, &o2).unwrap();
        assert_eq!(after.summary.diff, 1, "only ws.txt differs in binary"); // ws.txt
        assert_eq!(after.summary.left_only + after.summary.right_only, 0);
    }

    #[test]
    fn update_right_only_copies_newer() {
        let (_d, l, r) = fixture();
        let res = compare_folders(&l, &r, &FolderOptions { exclude: ".git/".into(), ..Default::default() }).unwrap();
        let plan = plan_sync(&res.root, &l, &r, "update-left");
        let rels: Vec<&str> = plan.iter().map(|a| a.rel.as_str()).collect();
        assert_eq!(rels, vec!["sub/onlyright.txt"]);
    }

    fn act(op: &str, from: Option<&Path>, to: &Path) -> Action {
        Action { op: op.into(), from: from.map(|f| f.to_string_lossy().into_owned()), to: to.to_string_lossy().into_owned(), ..Action::default() }
    }

    #[test]
    fn file_operations() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        write(&p.join("a/x.txt"), "x");
        write(&p.join("b/x.txt"), "old");
        write(&p.join("c.txt"), "c");
        // Move merges a folder into an existing one and replaces files.
        let res = execute(&[act("move", Some(&p.join("a")), &p.join("b"))], false);
        assert!(res[0].ok, "{res:?}");
        assert!(!p.join("a").exists());
        assert_eq!(fs::read_to_string(p.join("b/x.txt")).unwrap(), "x");
        // Rename refuses to overwrite.
        let res = execute(&[act("rename", Some(&p.join("c.txt")), &p.join("b/x.txt"))], false);
        assert!(!res[0].ok);
        let res = execute(&[act("rename", Some(&p.join("c.txt")), &p.join("d.txt"))], false);
        assert!(res[0].ok && p.join("d.txt").exists());
        // mkdir and touch with a fixed time and from another item.
        let res = execute(&[act("mkdir", None, &p.join("n/m"))], false);
        assert!(res[0].ok && p.join("n/m").is_dir());
        let t = Action { time: Some(1_000_000_000_000), ..act("touch", None, &p.join("d.txt")) };
        assert!(execute(&[t], false)[0].ok);
        assert_eq!(item_info(&p.join("d.txt")).modified, Some(1_000_000_000_000));
        assert!(execute(&[act("touch", Some(&p.join("d.txt")), &p.join("b/x.txt"))], false)[0].ok);
        assert_eq!(item_info(&p.join("b/x.txt")).modified, Some(1_000_000_000_000));
        let info = item_info(&p.join("b"));
        assert!(info.exists && info.dir);
        assert!(!item_info(&p.join("nope")).exists);
    }

    #[cfg(unix)]
    #[test]
    fn chmod_respects_mask() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("f");
        write(&f, "x");
        fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap();
        // Set owner execute, clear other read, leave everything else.
        let a = Action { mode: Some(0o100), mask: Some(0o104), ..act("chmod", None, &f) };
        assert!(execute(&[a], false)[0].ok);
        assert_eq!(item_info(&f).mode & 0o777, 0o740);
    }

    #[test]
    fn compare_single_item_and_anchored_excludes() {
        let (_d, l, r) = fixture();
        let o = FolderOptions { exclude: ".git/".into(), ..Default::default() };
        let n = compare_item(&l, &r, "changed.txt", &o).unwrap();
        assert_eq!(n.status, Status::Diff);
        let n = compare_item(&l, &r, "sub/onlyright.txt", &o).unwrap();
        assert_eq!(n.status, Status::Right);
        assert!(compare_item(&l, &r, "missing.txt", &o).is_none());
        // A mask with a separator is anchored to the base folder.
        let o = FolderOptions { exclude: ".git/;/sub/ws.txt".into(), ..Default::default() };
        let res = compare_folders(&l, &r, &o).unwrap();
        let sub = find(&res.root, "sub");
        assert!(sub.children.iter().all(|c| c.rel != "sub/ws.txt"));
        let o = FolderOptions { exclude: ".git/;/sub/".into(), ..Default::default() };
        let res = compare_folders(&l, &r, &o).unwrap();
        assert!(res.root.children.iter().all(|c| c.rel != "sub"));
    }

    #[test]
    fn align_pairs_differently_named_items() {
        let d = tempfile::tempdir().unwrap();
        let (l, r) = (d.path().join("L"), d.path().join("R"));
        write(&l.join("old.txt"), "same");
        write(&r.join("new.txt"), "same");
        write(&l.join("dl/f.txt"), "1");
        write(&r.join("dr/f.txt"), "2");
        set_time(&l.join("old.txt"), 1000);
        set_time(&r.join("new.txt"), 1000);
        set_time(&l.join("dl/f.txt"), 9000);
        set_time(&r.join("dr/f.txt"), 1000);
        let (ls, rs) = (l.to_string_lossy().into_owned(), r.to_string_lossy().into_owned());
        let o = FolderOptions {
            align: vec![
                Alignment { parent: "".into(), left: "old.txt".into(), right: "new.txt".into() },
                Alignment { parent: "".into(), left: "dl".into(), right: "dr".into() },
            ],
            ..Default::default()
        };
        let res = compare_folders(&ls, &rs, &o).unwrap();
        assert_eq!(res.root.children.len(), 2, "{:?}", res.root.children.iter().map(|c| &c.rel).collect::<Vec<_>>());
        let f = find(&res.root, "old.txt");
        assert_eq!(f.status, Status::Same);
        assert_eq!(f.right.as_ref().unwrap().name, "new.txt");
        assert_eq!(find(&res.root, "dl/f.txt").status, Status::Diff);
        assert_eq!(right_rel("dl/f.txt", &o), "dr/f.txt");
        assert_eq!(compare_item(&ls, &rs, "dl/f.txt", &o).unwrap().status, Status::Diff);
        // Sync writes into the aligned right folder, not a new "dl".
        let plan = plan_sync(&res.root, &ls, &rs, "mirror-right");
        assert!(plan.iter().all(|a| !a.to.contains("/dl/") && !a.to.contains("\\dl\\")), "{plan:?}");
        assert!(plan.iter().any(|a| a.to.ends_with("f.txt") && a.to.contains("dr")));
    }

    #[test]
    fn no_extension_mask() {
        let d = tempfile::tempdir().unwrap();
        let (l, r) = (d.path().join("L"), d.path().join("R"));
        write(&l.join("Makefile"), "a");
        write(&l.join("a.txt"), "a");
        fs::create_dir_all(&r).unwrap();
        let o = FolderOptions { exclude: "*.".into(), ..Default::default() };
        let res = compare_folders(&l.to_string_lossy(), &r.to_string_lossy(), &o).unwrap();
        let names: Vec<&str> = res.root.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["a.txt"]);
    }
}
