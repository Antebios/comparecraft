//! Folder comparison and synchronization.

use crate::fileio::{make_backup, modified_ms, BackupSpec};
use crate::quick::{crc32_file, files_binary_equal, rules_verdict, BINARY_DIFFERENT, BINARY_SAME, RULES_SAME, SIMILAR};
use crate::snapshot::{self, Snapshot};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

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
    /// Semicolon separated include masks for folders; empty or "*" includes all folders.
    pub include_folders: String,
    /// Date, size and content filters applied to files.
    pub other_filters: Vec<OtherFilter>,
    /// Skip protected operating system files (hidden + system attributes; Windows only).
    pub exclude_hidden: bool,
    /// Ignore folder structure: compare all files of both trees, paired by file name.
    pub flatten: bool,
    /// Timestamps exactly one hour apart are considered equal.
    pub ignore_dst: bool,
    /// Timestamps a whole number of hours (up to 24) apart are considered equal.
    pub ignore_tz: bool,
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

/// A file filter on date, size or content. Files matching the condition are excluded.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct OtherFilter {
    /// "date" | "size" | "content"
    pub kind: String,
    pub enabled: bool,
    /// date: exclude files newer (true) or older (false) than the threshold.
    pub newer: bool,
    /// date: threshold relative to now, in days (takes precedence over `date`).
    pub days: Option<u32>,
    /// date: absolute threshold in ms since the epoch.
    pub date: Option<i64>,
    /// size: exclude files larger (true) or smaller (false) than `size` bytes.
    pub larger: bool,
    pub size: u64,
    /// content: exclude files not containing (true) or containing (false) `text`.
    pub not_containing: bool,
    pub text: String,
    pub case_sensitive: bool,
    pub whole_words: bool,
    pub regex: bool,
}

impl Default for OtherFilter {
    fn default() -> Self {
        OtherFilter {
            kind: String::new(),
            enabled: true,
            newer: false,
            days: None,
            date: None,
            larger: false,
            size: 0,
            not_containing: false,
            text: String::new(),
            case_sensitive: false,
            whole_words: false,
            regex: false,
        }
    }
}

impl FolderOptions {
    fn eq_names(&self, a: &str, b: &str) -> bool {
        if self.ignore_case_names { a.to_lowercase() == b.to_lowercase() } else { a == b }
    }
    fn name_key(&self, a: &str) -> String {
        if self.ignore_case_names { a.to_lowercase() } else { a.to_string() }
    }
}

impl Default for FolderOptions {
    fn default() -> Self {
        FolderOptions {
            criteria: "timesize".into(),
            time_tolerance_secs: 2,
            include: "*".into(),
            exclude: String::new(),
            include_folders: String::new(),
            other_filters: vec![],
            exclude_hidden: false,
            flatten: false,
            ignore_dst: false,
            ignore_tz: false,
            ignore_case_names: cfg!(any(windows, target_os = "macos")),
            follow_symlinks: false,
            align: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Verdict of a content comparison of a file pair, shown in the center column.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Content {
    SameBinary,
    Same,
    Similar,
    Different,
    DifferentBinary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub name: String,
    pub rel: String,
    pub dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<Side>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<Side>,
    /// Flattened compare: relative path of the item on each side.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_path: Option<String>,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub newer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Result of the content comparison, when the criteria compared contents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Content>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Node>,
}

impl Node {
    fn new(name: &str, rel: &str, dir: bool, status: Status) -> Node {
        Node {
            name: name.into(),
            rel: rel.into(),
            dir,
            left: None,
            right: None,
            left_path: None,
            right_path: None,
            status,
            newer: None,
            error: None,
            content: None,
            children: vec![],
        }
    }
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
    /// Folder include masks (name masks and base-anchored ones); both empty = all folders.
    include_dirs: Vec<String>,
    include_rel_dirs: Vec<String>,
}

/// Normalizes a base-anchored mask to "a/b" form, or None for a plain name mask.
fn rel_mask(m: &str) -> Option<String> {
    let t = m.replace('\\', "/");
    if !t.contains('/') {
        return None;
    }
    Some(t.trim_start_matches('/').to_string())
}

fn split_masks(s: &str) -> Vec<String> {
    s.split(';').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

impl Masks {
    fn new(o: &FolderOptions) -> Masks {
        // As in the reference tool's -filters syntax, a leading '-' marks an exclusion.
        let (negated, mut include): (Vec<String>, Vec<String>) = split_masks(&o.include).into_iter().partition(|m| m.starts_with('-'));
        include.retain(|m| !m.ends_with('/') && !m.ends_with('\\'));
        if include.is_empty() {
            include.push("*".into());
        }
        let mut masks = Masks {
            include,
            exclude_files: vec![],
            exclude_dirs: vec![],
            exclude_rel_files: vec![],
            exclude_rel_dirs: vec![],
            include_dirs: vec![],
            include_rel_dirs: vec![],
        };
        let excludes = split_masks(&o.exclude).into_iter().chain(negated.into_iter().map(|m| m[1..].to_string()));
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
        let dir_includes = split_masks(&o.include_folders);
        if !dir_includes.iter().any(|m| m == "*") {
            for m in dir_includes {
                let body = m.trim_end_matches(['/', '\\']);
                match rel_mask(body) {
                    Some(r) => masks.include_rel_dirs.push(r),
                    None => masks.include_dirs.push(body.to_string()),
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
        let included = (self.include_dirs.is_empty() && self.include_rel_dirs.is_empty())
            || self.include_dirs.iter().any(|m| glob_match(m, name))
            || self.include_rel_dirs.iter().any(|m| glob_match(m, rel));
        included && !self.exclude_dirs.iter().any(|m| glob_match(m, name)) && !self.exclude_rel_dirs.iter().any(|m| glob_match(m, rel))
    }
}

/// Compiled form of an enabled `OtherFilter`.
enum Filter {
    Date { newer: bool, threshold: i64 },
    Size { larger: bool, size: u64 },
    Content { re: regex::bytes::Regex, not_containing: bool },
}

const CONTENT_FILTER_LIMIT: u64 = 64 << 20;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Filter {
    fn compile(f: &OtherFilter, now: i64) -> Option<Filter> {
        if !f.enabled {
            return None;
        }
        match f.kind.as_str() {
            "date" => {
                let threshold = f.days.map(|d| now - d as i64 * 86_400_000).or(f.date)?;
                Some(Filter::Date { newer: f.newer, threshold })
            }
            "size" => Some(Filter::Size { larger: f.larger, size: f.size }),
            "content" if !f.text.is_empty() => {
                let mut pat = if f.regex { f.text.clone() } else { regex::escape(&f.text) };
                if f.whole_words {
                    pat = format!(r"\b(?:{pat})\b");
                }
                let re = regex::bytes::RegexBuilder::new(&pat).case_insensitive(!f.case_sensitive).build().ok()?;
                Some(Filter::Content { re, not_containing: f.not_containing })
            }
            _ => None,
        }
    }

    /// Whether a file passes the filter. `path` is None for items without readable content (snapshots).
    fn keep(&self, path: Option<&Path>, m: &Meta) -> bool {
        match self {
            Filter::Date { newer, threshold } => match m.modified {
                Some(t) => !(if *newer { t > *threshold } else { t < *threshold }),
                None => true,
            },
            Filter::Size { larger, size } => !(if *larger { m.len > *size } else { m.len < *size }),
            Filter::Content { re, not_containing } => {
                let Some(p) = path else { return true };
                let mut buf = Vec::new();
                match fs::File::open(p).and_then(|f| f.take(CONTENT_FILTER_LIMIT).read_to_end(&mut buf)) {
                    Ok(_) => re.is_match(&buf) == *not_containing,
                    Err(_) => true,
                }
            }
        }
    }
}

/// Options plus the masks and filters compiled from them.
pub(crate) struct Ctx<'a> {
    o: &'a FolderOptions,
    masks: Masks,
    filters: Vec<Filter>,
}

impl<'a> Ctx<'a> {
    pub(crate) fn new(o: &'a FolderOptions) -> Ctx<'a> {
        let now = now_ms();
        Ctx { o, masks: Masks::new(o), filters: o.other_filters.iter().filter_map(|f| Filter::compile(f, now)).collect() }
    }

    /// Whether an entry of `parent` is listed.
    fn accept(&self, parent: &Loc, name: &str, rel: &str, m: &Meta) -> bool {
        if self.o.exclude_hidden && m.protected {
            return false;
        }
        if m.is_dir {
            return self.masks.dir_ok(name, rel);
        }
        if !self.masks.file_ok(name, rel) {
            return false;
        }
        let path = parent.disk().map(|d| d.join(name));
        self.filters.iter().all(|f| f.keep(path.as_deref(), m))
    }
}

fn child_rel(rel: &str, name: &str) -> String {
    if rel.is_empty() { name.to_string() } else { format!("{rel}/{name}") }
}

/// Facts about a listed item, from the file system or a snapshot.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Meta {
    pub is_dir: bool,
    pub len: u64,
    pub modified: Option<i64>,
    /// Known CRC-32 of a snapshot file.
    pub crc: Option<u32>,
    /// Protected operating system item (hidden + system).
    pub protected: bool,
}

#[cfg(windows)]
fn is_protected(m: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    m.file_attributes() & 0x6 == 0x6
}

#[cfg(not(windows))]
fn is_protected(_m: &fs::Metadata) -> bool {
    false
}

impl Meta {
    fn from_fs(m: &fs::Metadata) -> Meta {
        Meta { is_dir: m.is_dir(), len: if m.is_dir() { 0 } else { m.len() }, modified: modified_ms(m), crc: None, protected: is_protected(m) }
    }
}

/// A folder on one side of a comparison: on disk or inside a snapshot.
#[derive(Clone)]
pub(crate) enum Loc {
    Disk(PathBuf),
    Snap(Arc<Snapshot>, String),
}

impl Loc {
    fn join(&self, name: &str) -> Loc {
        match self {
            Loc::Disk(p) => Loc::Disk(p.join(name)),
            Loc::Snap(s, rel) => Loc::Snap(s.clone(), child_rel(rel, name)),
        }
    }

    fn join_rel(&self, rel: &str) -> Loc {
        rel.split('/').filter(|s| !s.is_empty()).fold(self.clone(), |l, seg| l.join(seg))
    }

    fn disk(&self) -> Option<&Path> {
        match self {
            Loc::Disk(p) => Some(p),
            Loc::Snap(..) => None,
        }
    }

    fn entries(&self, follow: bool) -> io::Result<Vec<(String, Meta)>> {
        match self {
            Loc::Disk(dir) => {
                let mut out = Vec::new();
                for e in fs::read_dir(dir)?.flatten() {
                    let meta = if follow { fs::metadata(e.path()) } else { fs::symlink_metadata(e.path()) };
                    if let Ok(m) = meta {
                        out.push((e.file_name().to_string_lossy().into_owned(), Meta::from_fs(&m)));
                    }
                }
                Ok(out)
            }
            Loc::Snap(s, rel) => s.children(rel).map(|c| c.to_vec()).ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{rel} not found in snapshot"))),
        }
    }

    /// Finds `name` inside this folder, falling back to a case-insensitive match when names are compared that way.
    fn child(&self, name: &str, o: &FolderOptions) -> Option<(String, Meta)> {
        if let Loc::Disk(dir) = self {
            let p = dir.join(name);
            let m = if o.follow_symlinks { fs::metadata(&p) } else { fs::symlink_metadata(&p) };
            if let Ok(m) = m {
                return Some((name.to_string(), Meta::from_fs(&m)));
            }
            if !o.ignore_case_names {
                return None;
            }
        }
        let entries = self.entries(o.follow_symlinks).ok()?;
        entries.iter().find(|(n, _)| n == name).or_else(|| entries.iter().find(|(n, _)| o.eq_names(n, name))).cloned()
    }

    /// Side shown for a compared root.
    fn root_side(&self, shown: &str) -> io::Result<Side> {
        match self {
            Loc::Disk(p) => Ok(side(shown, &Meta::from_fs(&fs::metadata(p)?))),
            Loc::Snap(s, _) => Ok(Side { name: s.root.clone(), size: 0, modified: None }),
        }
    }
}

/// Opens one side of a folder comparison: a folder or a snapshot file.
pub(crate) fn open_source(path: &str) -> io::Result<Option<Loc>> {
    let p = Path::new(path);
    if p.is_dir() {
        return Ok(Some(Loc::Disk(p.to_path_buf())));
    }
    if p.is_file() && snapshot::is_snapshot(p) {
        return Ok(Some(Loc::Snap(Arc::new(snapshot::load(p)?), String::new())));
    }
    Ok(None)
}

/// Display order of names: letters and digits first, ignoring punctuation and spaces,
/// then accents, then punctuation, then case (lower before upper).
pub fn name_order(a: &str, b: &str) -> Ordering {
    use unicode_normalization::char::is_combining_mark;
    use unicode_normalization::UnicodeNormalization;
    struct Keys {
        primary: Vec<char>,
        accents: Vec<String>,
        punct: Vec<(bool, char)>,
        case: Vec<bool>,
    }
    let keys = |s: &str| {
        let mut k = Keys { primary: vec![], accents: vec![], punct: vec![], case: vec![] };
        for c in s.nfd() {
            if is_combining_mark(c) {
                if let Some(last) = k.accents.last_mut() {
                    last.push(c);
                }
                continue;
            }
            let lower = c.to_lowercase().next().unwrap_or(c);
            if c.is_alphanumeric() {
                k.primary.push(lower);
                k.accents.push(String::new());
            }
            k.punct.push((c.is_alphanumeric(), lower));
            k.case.push(c.is_uppercase());
        }
        k
    };
    let (x, y) = (keys(a), keys(b));
    x.primary.cmp(&y.primary).then_with(|| x.accents.cmp(&y.accents)).then_with(|| x.punct.cmp(&y.punct)).then_with(|| x.case.cmp(&y.case)).then_with(|| a.cmp(b))
}

/// Folders first, then by display name order.
fn entry_order(a: &(String, bool), b: &(String, bool)) -> Ordering {
    b.1.cmp(&a.1).then_with(|| name_order(&a.0, &b.0))
}

struct Listing {
    entries: BTreeMap<(String, bool), (String, Meta)>,
}

fn list(loc: &Loc, rel: &str, cx: &Ctx) -> io::Result<Listing> {
    let mut entries = BTreeMap::new();
    for (name, meta) in loc.entries(cx.o.follow_symlinks)? {
        let crel = child_rel(rel, &name);
        if !cx.accept(loc, &name, &crel, &meta) {
            continue;
        }
        entries.insert((cx.o.name_key(&name), meta.is_dir), (name, meta));
    }
    Ok(Listing { entries })
}

/// Recursively lists the accepted items of a folder (for snapshots), folders before their contents.
pub(crate) fn walk(loc: &Loc, rel: &str, cx: &Ctx, out: &mut Vec<(String, Meta)>) -> io::Result<()> {
    for (_, (name, m)) in list(loc, rel, cx)?.entries {
        let crel = child_rel(rel, &name);
        let is_dir = m.is_dir;
        out.push((crel.clone(), m));
        if is_dir {
            let _ = walk(&loc.join(&name), &crel, cx, out);
        }
    }
    Ok(())
}

fn side(name: &str, m: &Meta) -> Side {
    Side { name: name.into(), size: if m.is_dir { 0 } else { m.len }, modified: m.modified }
}

/// Timestamp equality within the tolerance, optionally ignoring daylight-saving (1 hour) and
/// time-zone (whole hours up to a day) offsets.
fn times_equal(a: i64, b: i64, o: &FolderOptions) -> bool {
    const HOUR: i64 = 3_600_000;
    let tol = o.time_tolerance_secs.max(0) * 1000;
    let d = (a - b).abs();
    d <= tol || (o.ignore_dst && (d - HOUR).abs() <= tol) || (o.ignore_tz && (1..=24).any(|k| (d - k * HOUR).abs() <= tol))
}

fn timesize(l: &Side, r: &Side, o: &FolderOptions) -> Status {
    let times_eq = match (l.modified, r.modified) {
        (Some(a), Some(b)) => times_equal(a, b, o),
        _ => false,
    };
    if l.size == r.size && times_eq { Status::Same } else { Status::Diff }
}

/// Compares two files (`lf`/`rf` are the files themselves), with the content verdict when contents were compared.
fn compare_files(lf: &Loc, rf: &Loc, lm: &Meta, rm: &Meta, l: &Side, r: &Side, o: &FolderOptions) -> io::Result<(Status, Option<Content>)> {
    let same_size = l.size == r.size;
    let binary = |eq: bool| if eq { (Status::Same, Some(Content::SameBinary)) } else { (Status::Diff, Some(Content::DifferentBinary)) };
    let (lp, rp) = match (lf.disk(), rf.disk()) {
        (Some(lp), Some(rp)) => (lp, rp),
        // A snapshot side has no content: use CRCs when both are known, else size and time.
        _ => {
            let crc = |f: &Loc, m: &Meta| -> io::Result<Option<u32>> {
                match (m.crc, f.disk()) {
                    (Some(c), _) => Ok(Some(c)),
                    (None, Some(p)) => crc32_file(p).map(Some),
                    (None, None) => Ok(None),
                }
            };
            let has_crc = lm.crc.is_some() || rm.crc.is_some();
            if has_crc && matches!(o.criteria.as_str(), "crc" | "binary" | "rules") {
                if !same_size {
                    return Ok(binary(false));
                }
                if let (Some(a), Some(b)) = (crc(lf, lm)?, crc(rf, rm)?) {
                    return Ok(binary(a == b));
                }
            }
            return Ok((timesize(l, r, o), None));
        }
    };
    Ok(match o.criteria.as_str() {
        "size" => (if same_size { Status::Same } else { Status::Diff }, None),
        "binary" => binary(same_size && files_binary_equal(lp, rp)?),
        "crc" => binary(same_size && crc32_file(lp)? == crc32_file(rp)?),
        "rules" => {
            if same_size && files_binary_equal(lp, rp)? {
                (Status::Same, Some(Content::SameBinary))
            } else if l.size > 32 * 1024 * 1024 || r.size > 32 * 1024 * 1024 {
                (Status::Diff, Some(Content::Different))
            } else {
                match rules_verdict(&fs::read(lp)?, &fs::read(rp)?) {
                    BINARY_SAME => (Status::Same, Some(Content::SameBinary)),
                    RULES_SAME => (Status::Same, Some(Content::Same)),
                    SIMILAR => (Status::Similar, Some(Content::Similar)),
                    // Binary content is compared byte for byte.
                    BINARY_DIFFERENT => (Status::Diff, Some(Content::DifferentBinary)),
                    _ => (Status::Diff, Some(Content::Different)),
                }
            }
        }
        _ => (timesize(l, r, o), None),
    })
}

fn newer(l: &Side, r: &Side, o: &FolderOptions) -> Option<String> {
    match (l.modified, r.modified) {
        (Some(a), Some(b)) if !times_equal(a, b, o) => Some(if a > b { "left" } else { "right" }.into()),
        _ => None,
    }
}

fn orphan_tree(parent: &Loc, rel: &str, name: &str, m: &Meta, left: bool, cx: &Ctx, sum: &mut Summary) -> Node {
    let s = side(name, m);
    let mut node = Node::new(name, rel, m.is_dir, if left { Status::Left } else { Status::Right });
    if left {
        node.left = Some(s);
    } else {
        node.right = Some(s);
    }
    if m.is_dir {
        let loc = parent.join(name);
        match list(&loc, rel, cx) {
            Ok(l) => {
                let mut entries: Vec<_> = l.entries.into_iter().collect();
                entries.sort_by(|a, b| entry_order(&a.0, &b.0));
                for (_, (cname, cm)) in entries {
                    let crel = format!("{rel}/{cname}");
                    node.children.push(orphan_tree(&loc, &crel, &cname, &cm, left, cx, sum));
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

fn compare_dirs(lp: &Loc, rp: &Loc, rel: &str, cx: &Ctx, sum: &mut Summary) -> io::Result<Vec<Node>> {
    let o = cx.o;
    let ll = list(lp, rel, cx)?;
    let rl = list(rp, rel, cx)?;
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
    keys.sort_by(entry_order);
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
        let node = match (l, r) {
            (Some((ln, lm)), None) => orphan_tree(lp, &child_rel(rel, ln), ln, lm, true, cx, sum),
            (None, Some((rn, rm))) => orphan_tree(rp, &child_rel(rel, rn), rn, rm, false, cx, sum),
            (Some((ln, lm)), Some((rn, rm))) => pair_node(lp, rp, &child_rel(rel, ln), ln, lm, rn, rm, cx, sum),
            (None, None) => continue,
        };
        out.push(node);
    }
    Ok(out)
}

/// Compares an item present on both sides (`lp`/`rp` are the parent folders).
#[allow(clippy::too_many_arguments)]
fn pair_node(lp: &Loc, rp: &Loc, crel: &str, ln: &str, lm: &Meta, rn: &str, rm: &Meta, cx: &Ctx, sum: &mut Summary) -> Node {
    let o = cx.o;
    let ls = side(ln, lm);
    let rs = side(rn, rm);
    if lm.is_dir {
        let mut node = Node::new(ln, crel, true, Status::Same);
        node.left = Some(ls);
        node.right = Some(rs);
        match compare_dirs(&lp.join(ln), &rp.join(rn), crel, cx, sum) {
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
        let (status, content, error) = match compare_files(&lp.join(ln), &rp.join(rn), lm, rm, &ls, &rs, o) {
            Ok((s, c)) => (s, c, None),
            Err(e) => (Status::Error, None, Some(e.to_string())),
        };
        match status {
            Status::Same => sum.same += 1,
            Status::Similar => sum.similar += 1,
            Status::Error => sum.errors += 1,
            _ => sum.diff += 1,
        }
        let mut node = Node::new(ln, crel, false, status);
        node.newer = if status == Status::Diff { newer(&ls, &rs, o) } else { None };
        node.left = Some(ls);
        node.right = Some(rs);
        node.error = error;
        node.content = content;
        node
    }
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

fn item_node(left: &Loc, right: &Loc, rel: &str, cx: &Ctx) -> Option<Node> {
    let o = cx.o;
    let mut sum = Summary::default();
    let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    let lp = left.join_rel(parent);
    let rp = right.join_rel(&right_rel(parent, o));
    let l = lp.child(name, o).filter(|(n, m)| cx.accept(&lp, n, rel, m));
    let r = rp.child(aligned_right(parent, name, o).unwrap_or(name), o).filter(|(n, m)| cx.accept(&rp, n, &child_rel(parent, n), m));
    Some(match (l, r) {
        (Some((ln, lm)), Some((rn, rm))) if lm.is_dir == rm.is_dir => pair_node(&lp, &rp, rel, &ln, &lm, &rn, &rm, cx, &mut sum),
        (Some((ln, lm)), _) => orphan_tree(&lp, rel, &ln, &lm, true, cx, &mut sum),
        (None, Some((rn, rm))) => orphan_tree(&rp, rel, &rn, &rm, false, cx, &mut sum),
        (None, None) => return None,
    })
}

/// Re-compares a single item (Refresh Selection / Compare Contents). Returns None when it no longer exists
/// on either side or is now filtered out.
pub fn compare_item(left: &str, right: &str, rel: &str, o: &FolderOptions) -> Option<Node> {
    compare_items(left, right, &[rel.to_string()], o).pop().flatten()
}

/// `compare_item` for several items, opening each side once.
pub fn compare_items(left: &str, right: &str, rels: &[String], o: &FolderOptions) -> Vec<Option<Node>> {
    let (Ok(Some(l)), Ok(Some(r))) = (open_source(left), open_source(right)) else {
        return rels.iter().map(|_| None).collect();
    };
    let cx = Ctx::new(o);
    rels.iter().map(|rel| item_node(&l, &r, rel, &cx)).collect()
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

/// A file found while flattening a tree.
struct FlatFile {
    rel: String,
    name: String,
    parent: Loc,
    meta: Meta,
}

fn collect_files(loc: &Loc, rel: &str, cx: &Ctx, out: &mut Vec<FlatFile>) -> io::Result<()> {
    for (_, (name, meta)) in list(loc, rel, cx)?.entries {
        let crel = child_rel(rel, &name);
        if meta.is_dir {
            // Unreadable subfolders are skipped; there is no folder node to carry the error.
            let _ = collect_files(&loc.join(&name), &crel, cx, out);
        } else {
            out.push(FlatFile { rel: crel, name, parent: loc.clone(), meta });
        }
    }
    Ok(())
}

/// "Ignore folder structure": files of both trees paired by name, identical relative paths first.
fn compare_flat(left: &Loc, right: &Loc, cx: &Ctx, sum: &mut Summary) -> io::Result<Vec<Node>> {
    let o = cx.o;
    let (mut lf, mut rf) = (vec![], vec![]);
    collect_files(left, "", cx, &mut lf)?;
    collect_files(right, "", cx, &mut rf)?;
    let mut groups: BTreeMap<String, (Vec<FlatFile>, Vec<FlatFile>)> = BTreeMap::new();
    for f in lf {
        groups.entry(o.name_key(&f.name)).or_default().0.push(f);
    }
    for f in rf {
        groups.entry(o.name_key(&f.name)).or_default().1.push(f);
    }
    let mut pairs: Vec<(Option<FlatFile>, Option<FlatFile>)> = vec![];
    for (_, (mut ls, mut rs)) in groups {
        ls.sort_by(|a, b| a.rel.cmp(&b.rel));
        rs.sort_by(|a, b| a.rel.cmp(&b.rel));
        let mut rs: Vec<Option<FlatFile>> = rs.into_iter().map(Some).collect();
        let mut rest = vec![];
        for l in ls {
            match rs.iter().position(|r| r.as_ref().is_some_and(|r| o.eq_names(&r.rel, &l.rel))) {
                Some(i) => pairs.push((Some(l), rs[i].take())),
                None => rest.push(l),
            }
        }
        let mut rrest = rs.into_iter().flatten();
        for l in rest {
            pairs.push((Some(l), rrest.next()));
        }
        pairs.extend(rrest.map(|r| (None, Some(r))));
    }
    let mut used: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(pairs.len());
    for (l, r) in pairs {
        let mut node = match (&l, &r) {
            (Some(l), Some(r)) => pair_node(&l.parent, &r.parent, &l.rel, &l.name, &l.meta, &r.name, &r.meta, cx, sum),
            (Some(l), None) => orphan_tree(&l.parent, &l.rel, &l.name, &l.meta, true, cx, sum),
            (None, Some(r)) => orphan_tree(&r.parent, &r.rel, &r.name, &r.meta, false, cx, sum),
            (None, None) => continue,
        };
        node.left_path = l.map(|f| f.rel);
        node.right_path = r.map(|f| f.rel);
        let base = node.left_path.clone().or_else(|| node.right_path.clone()).unwrap_or_default();
        let mut rel = base.clone();
        let mut n = 1;
        while !used.insert(rel.clone()) {
            rel = format!("{base}\u{1}{n}");
            n += 1;
        }
        node.rel = rel;
        out.push(node);
    }
    out.sort_by(|a, b| name_order(&a.name, &b.name).then_with(|| a.rel.cmp(&b.rel)));
    Ok(out)
}

pub fn compare_folders(left: &str, right: &str, o: &FolderOptions) -> io::Result<FolderResult> {
    let lp = open_source(left)?.ok_or_else(|| io::Error::other(format!("Left folder not found: {left}")))?;
    let rp = open_source(right)?.ok_or_else(|| io::Error::other(format!("Right folder not found: {right}")))?;
    let cx = Ctx::new(o);
    let mut sum = Summary::default();
    let children = if o.flatten { compare_flat(&lp, &rp, &cx, &mut sum)? } else { compare_dirs(&lp, &rp, "", &cx, &mut sum)? };
    let mut root = Node::new("", "", true, folder_status(&children));
    root.left = Some(lp.root_side(left)?);
    root.right = Some(rp.root_side(right)?);
    root.children = children;
    Ok(FolderResult { root, summary: sum })
}

/// Compares two folders structurally and plans a sync. Actions reading from or writing into a
/// snapshot side are dropped, as a snapshot has no content and is read-only.
pub fn plan_sync_folders(left: &str, right: &str, o: &FolderOptions, mode: &str) -> io::Result<Vec<Action>> {
    let o = FolderOptions { flatten: false, ..o.clone() };
    let res = compare_folders(left, right, &o)?;
    let mut actions = plan_sync(&res.root, left, right, mode);
    let snaps: Vec<&Path> = [left, right].into_iter().map(Path::new).filter(|p| p.is_file()).collect();
    if !snaps.is_empty() {
        let touches = |p: &str| snaps.iter().any(|s| Path::new(p).starts_with(s));
        actions.retain(|a| !touches(&a.to) && !a.from.as_deref().is_some_and(touches));
    }
    Ok(actions)
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

/// Runs file operations. With `backup`, an existing destination file replaced by a copy or move is
/// first saved to its backup location.
pub fn execute(actions: &[Action], use_trash: bool, backup: Option<&BackupSpec>) -> Vec<ActionResult> {
    actions
        .iter()
        .map(|a| {
            let to = Path::new(&a.to);
            let from = a.from.as_deref().map(Path::new);
            let need_from = || from.ok_or_else(|| io::Error::other(format!("{} without source", a.op)));
            let backup_target = || -> io::Result<()> {
                match backup {
                    Some(spec) if fs::symlink_metadata(to).is_ok_and(|m| m.is_file()) => make_backup(to, spec),
                    _ => Ok(()),
                }
            };
            let res: io::Result<()> = match a.op.as_str() {
                "copy" => need_from().and_then(|f| {
                    backup_target()?;
                    // Replacing a folder with a file (or vice versa) requires removal first.
                    if to.exists() && to.is_dir() != f.is_dir() {
                        remove(to, use_trash)?;
                    }
                    copy_recursive(f, to)
                }),
                "move" => need_from().and_then(|f| {
                    backup_target()?;
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
    #[test]
    fn name_order_ignores_punctuation_then_accents_then_case() {
        let mut v = vec!["9.txt", "b.txt", "a.txt", "Ä.txt", "a-c.txt", "ab.txt", "a_b.txt", "A2.txt", "10.txt", "x.y.w", "xy", "Zeta.txt", "zeta2.txt", "b c.txt"];
        v.sort_by(|a, b| super::name_order(a, b));
        assert_eq!(v, ["10.txt", "9.txt", "A2.txt", "a_b.txt", "ab.txt", "a-c.txt", "a.txt", "Ä.txt", "b c.txt", "b.txt", "xy", "x.y.w", "zeta2.txt", "Zeta.txt"]);
    }

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
        let results = execute(&plan, false, None);
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
        let res = execute(&[act("move", Some(&p.join("a")), &p.join("b"))], false, None);
        assert!(res[0].ok, "{res:?}");
        assert!(!p.join("a").exists());
        assert_eq!(fs::read_to_string(p.join("b/x.txt")).unwrap(), "x");
        // Rename refuses to overwrite.
        let res = execute(&[act("rename", Some(&p.join("c.txt")), &p.join("b/x.txt"))], false, None);
        assert!(!res[0].ok);
        let res = execute(&[act("rename", Some(&p.join("c.txt")), &p.join("d.txt"))], false, None);
        assert!(res[0].ok && p.join("d.txt").exists());
        // mkdir and touch with a fixed time and from another item.
        let res = execute(&[act("mkdir", None, &p.join("n/m"))], false, None);
        assert!(res[0].ok && p.join("n/m").is_dir());
        let t = Action { time: Some(1_000_000_000_000), ..act("touch", None, &p.join("d.txt")) };
        assert!(execute(&[t], false, None)[0].ok);
        assert_eq!(item_info(&p.join("d.txt")).modified, Some(1_000_000_000_000));
        assert!(execute(&[act("touch", Some(&p.join("d.txt")), &p.join("b/x.txt"))], false, None)[0].ok);
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
        assert!(execute(&[a], false, None)[0].ok);
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
    fn set_ms(p: &Path, ms: i64) {
        set_mtime(p, ms).unwrap();
    }

    fn rels(n: &Node) -> Vec<String> {
        n.children.iter().map(|c| c.rel.clone()).collect()
    }

    #[test]
    fn flatten_pairs_by_name() {
        let d = tempfile::tempdir().unwrap();
        let (l, r) = (d.path().join("L"), d.path().join("R"));
        write(&l.join("a/x.txt"), "1");
        write(&l.join("b/x.txt"), "2");
        write(&l.join("y.txt"), "3");
        write(&r.join("a/x.txt"), "1");
        write(&r.join("c/x.txt"), "2");
        write(&r.join("d/e/y.txt"), "3");
        write(&r.join("z.txt"), "4");
        for p in [l.join("a/x.txt"), l.join("b/x.txt"), l.join("y.txt"), r.join("a/x.txt"), r.join("c/x.txt"), r.join("d/e/y.txt")] {
            set_ms(&p, 1_600_000_000_000);
        }
        let o = FolderOptions { flatten: true, ignore_case_names: false, ..Default::default() };
        let res = compare_folders(&l.to_string_lossy(), &r.to_string_lossy(), &o).unwrap();
        let ch = &res.root.children;
        assert!(ch.iter().all(|c| !c.dir));
        let got: Vec<(&str, Option<&str>, Option<&str>, Status)> =
            ch.iter().map(|c| (c.name.as_str(), c.left_path.as_deref(), c.right_path.as_deref(), c.status)).collect();
        assert_eq!(
            got,
            vec![
                ("x.txt", Some("a/x.txt"), Some("a/x.txt"), Status::Same),
                ("x.txt", Some("b/x.txt"), Some("c/x.txt"), Status::Same),
                ("y.txt", Some("y.txt"), Some("d/e/y.txt"), Status::Same),
                ("z.txt", None, Some("z.txt"), Status::Right),
            ]
        );
        assert_eq!(rels(&res.root), vec!["a/x.txt", "b/x.txt", "y.txt", "z.txt"]);
        assert_eq!((res.summary.files, res.summary.same, res.summary.right_only), (4, 3, 1));
        let json = serde_json::to_value(&ch[1]).unwrap();
        assert_eq!(json["leftPath"], "b/x.txt");
        assert_eq!(json["rightPath"], "c/x.txt");
        // Sync always works on the folder structure.
        let plan = plan_sync_folders(&l.to_string_lossy(), &r.to_string_lossy(), &o, "mirror-right").unwrap();
        assert!(plan.iter().any(|a| a.op == "copy" && a.rel == "b"), "{plan:?}");
    }

    #[test]
    fn other_filters() {
        let d = tempfile::tempdir().unwrap();
        let (l, r) = (d.path().join("L"), d.path().join("R"));
        write(&l.join("old.txt"), "Hello World");
        write(&l.join("new.txt"), "hello worldwide");
        write(&l.join("big.bin"), &"x".repeat(1000));
        write(&l.join("sub/old2.txt"), "nothing");
        fs::create_dir_all(&r).unwrap();
        set_time(&l.join("old.txt"), 10 * 86_400);
        set_time(&l.join("sub/old2.txt"), 10 * 86_400);
        let names = |filters: Vec<OtherFilter>| -> Vec<String> {
            let o = FolderOptions { other_filters: filters, ignore_case_names: false, ..Default::default() };
            let res = compare_folders(&l.to_string_lossy(), &r.to_string_lossy(), &o).unwrap();
            let mut v = vec![];
            fn all(n: &Node, v: &mut Vec<String>) {
                for c in &n.children {
                    if !c.dir {
                        v.push(c.rel.clone());
                    }
                    all(c, v);
                }
            }
            all(&res.root, &mut v);
            v.sort();
            v
        };
        let f = |kind: &str| OtherFilter { kind: kind.into(), ..Default::default() };
        // Older than 5 days excluded.
        assert_eq!(names(vec![OtherFilter { days: Some(5), ..f("date") }]), vec!["big.bin", "new.txt"]);
        // Newer than 5 days excluded.
        assert_eq!(names(vec![OtherFilter { days: Some(5), newer: true, ..f("date") }]), vec!["old.txt", "sub/old2.txt"]);
        assert_eq!(names(vec![OtherFilter { larger: true, size: 100, ..f("size") }]), vec!["new.txt", "old.txt", "sub/old2.txt"]);
        assert_eq!(names(vec![OtherFilter { size: 100, ..f("size") }]), vec!["big.bin"]);
        // Containing "world" (case-insensitive) excluded.
        assert_eq!(names(vec![OtherFilter { text: "WORLD".into(), ..f("content") }]), vec!["big.bin", "sub/old2.txt"]);
        assert_eq!(names(vec![OtherFilter { text: "WORLD".into(), case_sensitive: true, ..f("content") }]).len(), 4);
        assert_eq!(names(vec![OtherFilter { text: "world".into(), whole_words: true, ..f("content") }]), vec!["big.bin", "new.txt", "sub/old2.txt"]);
        assert_eq!(names(vec![OtherFilter { text: "world".into(), not_containing: true, ..f("content") }]), vec!["new.txt", "old.txt"]);
        assert_eq!(names(vec![OtherFilter { text: "^x+$".into(), regex: true, ..f("content") }]), vec!["new.txt", "old.txt", "sub/old2.txt"]);
        assert_eq!(names(vec![OtherFilter { text: "world".into(), enabled: false, ..f("content") }]).len(), 4);
        let parsed: OtherFilter = serde_json::from_str(r#"{"kind":"size","size":5}"#).unwrap();
        assert!(parsed.enabled);
    }

    #[test]
    fn include_folders() {
        let (_d, l, r) = fixture();
        let o = FolderOptions { include_folders: "nomatch".into(), ..Default::default() };
        let res = compare_folders(&l, &r, &o).unwrap();
        assert!(res.root.children.iter().all(|c| !c.dir), "{:?}", rels(&res.root));
        assert!(res.root.children.iter().any(|c| c.rel == "same.txt"));
        let o = FolderOptions { include_folders: "s*".into(), ..Default::default() };
        let res = compare_folders(&l, &r, &o).unwrap();
        let dirs: Vec<&str> = res.root.children.iter().filter(|c| c.dir).map(|c| c.rel.as_str()).collect();
        assert_eq!(dirs, vec!["sub"]);
        let o = FolderOptions { include_folders: "/sub".into(), ..Default::default() };
        assert!(compare_item(&l, &r, "sub", &o).is_some());
        assert!(compare_item(&l, &r, ".git", &o).is_none());
        let o = FolderOptions { include_folders: "*".into(), ..Default::default() };
        assert!(compare_item(&l, &r, ".git", &o).is_some());
    }

    #[test]
    fn dst_and_time_zone_offsets() {
        let d = tempfile::tempdir().unwrap();
        let (l, r) = (d.path().join("L"), d.path().join("R"));
        write(&l.join("dst.txt"), "a");
        write(&r.join("dst.txt"), "a");
        write(&l.join("tz.txt"), "a");
        write(&r.join("tz.txt"), "a");
        let t = 1_600_000_000_000;
        set_ms(&l.join("dst.txt"), t + 3_600_000 + 1000);
        set_ms(&r.join("dst.txt"), t);
        set_ms(&l.join("tz.txt"), t);
        set_ms(&r.join("tz.txt"), t + 5 * 3_600_000);
        let (ls, rs) = (l.to_string_lossy().into_owned(), r.to_string_lossy().into_owned());
        let st = |o: &FolderOptions, rel: &str| {
            let n = compare_item(&ls, &rs, rel, o).unwrap();
            (n.status, n.newer)
        };
        let plain = FolderOptions::default();
        assert_eq!(st(&plain, "dst.txt"), (Status::Diff, Some("left".into())));
        assert_eq!(st(&plain, "tz.txt"), (Status::Diff, Some("right".into())));
        let dst = FolderOptions { ignore_dst: true, ..Default::default() };
        assert_eq!(st(&dst, "dst.txt"), (Status::Same, None));
        assert_eq!(st(&dst, "tz.txt").0, Status::Diff);
        let tz = FolderOptions { ignore_tz: true, ..Default::default() };
        assert_eq!(st(&tz, "tz.txt"), (Status::Same, None));
        assert_eq!(st(&tz, "dst.txt"), (Status::Same, None));
        // Equal times never report a newer side, even when sizes differ.
        fs::write(r.join("tz.txt"), "bb").unwrap();
        set_ms(&r.join("tz.txt"), t + 5 * 3_600_000);
        assert_eq!(st(&tz, "tz.txt"), (Status::Diff, None));
    }

    #[test]
    fn snapshot_round_trip() {
        let (d, l, r) = fixture();
        let snap = d.path().join("right.ccsnap");
        let snap_s = snap.to_string_lossy().into_owned();
        fs::create_dir_all(Path::new(&r).join("empty/deeper")).unwrap();
        let o = FolderOptions { exclude: ".git/".into(), ignore_case_names: false, ..Default::default() };
        let n = crate::snapshot::save_snapshot(&r, &snap_s, true, false, Some(&o)).unwrap();
        // same.txt, changed.txt, sub, sub/onlyright.txt, sub/ws.txt (empty folders omitted)
        assert_eq!(n, 5);
        let json: serde_json::Value = serde_json::from_slice(&fs::read(&snap).unwrap()).unwrap();
        assert_eq!(json["format"], "comparecraft-snapshot");
        assert_eq!(json["version"], 1);
        assert!(json["entries"].as_array().unwrap().iter().all(|e| e["dir"] == true || e["crc"].is_u64()));
        let disk = compare_folders(&l, &r, &o).unwrap();
        let vs_snap = compare_folders(&l, &snap_s, &o).unwrap();
        assert_eq!(vs_snap.root.right.as_ref().unwrap().name, r);
        for rel in ["same.txt", "changed.txt", "onlyleft.txt", "sub/onlyright.txt", "sub/ws.txt"] {
            assert_eq!(find(&vs_snap.root, rel).status, find(&disk.root, rel).status, "{rel}");
        }
        assert_eq!(find(&vs_snap.root, "changed.txt").newer.as_deref(), Some("left"));
        // CRC comparison against the snapshot's checksums.
        let crc = FolderOptions { criteria: "crc".into(), ..o.clone() };
        let res = compare_folders(&l, &snap_s, &crc).unwrap();
        assert_eq!(find(&res.root, "same.txt").status, Status::Same);
        assert_eq!(find(&res.root, "sub/ws.txt").status, Status::Diff);
        // Snapshot on the left, with empty folders, sniffed without the extension.
        let snap2 = d.path().join("snap.json");
        let n2 = crate::snapshot::save_snapshot(&r, &snap2.to_string_lossy(), false, true, Some(&o)).unwrap();
        assert_eq!(n2, 7);
        let res = compare_folders(&snap2.to_string_lossy(), &r, &o).unwrap();
        assert_eq!(res.summary.files, 4);
        assert_eq!(res.summary.same, 4, "{:?}", res.summary);
        assert_eq!(find(&res.root, "empty/deeper").status, Status::Same);
        // Single items and sync planning against a snapshot.
        assert_eq!(compare_item(&l, &snap_s, "sub/onlyright.txt", &o).unwrap().status, Status::Right);
        assert_eq!(compare_item(&l, &snap_s, "same.txt", &o).unwrap().status, Status::Same);
        let plan = plan_sync_folders(&l, &snap_s, &o, "mirror-left").unwrap();
        assert!(plan.iter().all(|a| !a.from.as_deref().unwrap_or("").starts_with(&snap_s) && !a.to.starts_with(&snap_s)), "{plan:?}");
        assert!(plan.iter().any(|a| a.op == "delete" && a.rel == "onlyleft.txt"), "{plan:?}");
        assert!(plan.iter().all(|a| a.op == "delete"), "{plan:?}");
    }

    #[test]
    fn execute_backs_up_replaced_files() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        write(&p.join("src/a.txt"), "new");
        write(&p.join("dst/a.txt"), "old");
        write(&p.join("src/b.txt"), "new b");
        let spec = BackupSpec { kind: "folder".into(), dir: Some("bak".into()) };
        let res = execute(
            &[act("copy", Some(&p.join("src/a.txt")), &p.join("dst/a.txt")), act("move", Some(&p.join("src/b.txt")), &p.join("dst/b.txt"))],
            false,
            Some(&spec),
        );
        assert!(res.iter().all(|r| r.ok), "{res:?}");
        assert_eq!(fs::read_to_string(p.join("dst/a.txt")).unwrap(), "new");
        assert_eq!(fs::read_to_string(p.join("dst/bak/a.txt")).unwrap(), "old");
        assert!(!p.join("dst/bak/b.txt").exists());
        let spec = BackupSpec { kind: "nameTildeExt".into(), dir: None };
        write(&p.join("src/a.txt"), "newer");
        assert!(execute(&[act("move", Some(&p.join("src/a.txt")), &p.join("dst/a.txt"))], false, Some(&spec))[0].ok);
        assert_eq!(fs::read_to_string(p.join("dst/a~.txt")).unwrap(), "new");
    }
}
