//! Headless script runner: `comparecraft @script.txt [params] [-silent]`.
//!
//! A script is a text file with one command per line. Commands load folder or file comparisons,
//! select items, run file operations (copy, move, delete, rename, touch, sync) and write reports.

use crate::folder::{self, FolderOptions, Node, OtherFilter, Status};
use crate::report::{self, FileItem, FolderCtx, ReportSpec};
use crate::{fileio, sessions, snapshot};
use chrono::{Local, NaiveDate, NaiveDateTime, TimeZone};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// An error with `option stop-on-error` active.
pub const EXIT_ERROR: i32 = 100;
/// The script file could not be read.
pub const EXIT_SCRIPT_LOAD: i32 = 105;
/// Unknown command or invalid arguments.
pub const EXIT_SYNTAX: i32 = 106;
/// A comparison could not be loaded.
pub const EXIT_LOAD: i32 = 107;

// ---------------------------------------------------------------------------
// Log

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Level {
    None,
    Normal,
    Verbose,
}

struct Logger {
    file: Option<fs::File>,
    level: Level,
    /// Lines written before a log file is opened; flushed after the banner.
    pending: Vec<(Level, String)>,
    banner: bool,
    silent: bool,
}

impl Logger {
    fn stamp(msg: &str) -> String {
        format!("{}  {}", report::fmt_time(report::now_ms()), msg)
    }
    fn store(&mut self, lvl: Level, msg: &str) {
        let line = Logger::stamp(msg);
        match &mut self.file {
            Some(f) => {
                if lvl <= self.level {
                    let _ = writeln!(f, "{line}");
                }
            }
            None => self.pending.push((lvl, line)),
        }
    }
    fn write(&mut self, lvl: Level, msg: &str) {
        let shown = if self.level == Level::None { Level::Normal } else { self.level };
        if !self.silent && lvl <= shown {
            println!("{msg}");
        }
        self.store(lvl, msg);
    }
    fn info(&mut self, msg: &str) {
        self.write(Level::Normal, msg);
    }
    fn verbose(&mut self, msg: &str) {
        self.write(Level::Verbose, msg);
    }
    fn error(&mut self, msg: &str) {
        eprintln!("{msg}");
        self.store(Level::Normal, msg);
    }
    fn open(&mut self, path: &Path, append: bool, level: Level) -> Result<(), String> {
        if let Some(p) = path.parent() {
            let _ = fs::create_dir_all(p);
        }
        let mut f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(path)
            .map_err(|e| format!("Unable to open log file {}: {e}", path.display()))?;
        if !self.banner {
            self.banner = true;
            let _ = writeln!(f, "{}", Logger::stamp(&format!("*** CompareCraft {} ***", env!("CARGO_PKG_VERSION"))));
        }
        for (lvl, line) in std::mem::take(&mut self.pending) {
            if lvl <= level {
                let _ = writeln!(f, "{line}");
            }
        }
        self.file = Some(f);
        self.level = level;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Parsing helpers

/// Splits a command line on whitespace. Double quotes group text and are removed, also inside a token
/// (`output-to:"My Report.txt"`). There are no escape characters.
fn tokenize(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quoted = false;
    let mut has = false;
    for c in s.chars() {
        if c == '"' {
            quoted = !quoted;
            has = true;
        } else if c.is_whitespace() && !quoted {
            if has {
                out.push(std::mem::take(&mut cur));
                has = false;
            }
        } else {
            cur.push(c);
            has = true;
        }
    }
    if has {
        out.push(cur);
    }
    out
}

/// Expands `%1`..`%9` (script parameters), `%date%`, `%time%`, `%fn_time%` and `%NAME%` (environment
/// variables). Unknown names are left as they are; `%%` is a literal percent sign.
fn expand_vars(line: &str, params: &[String], var: &dyn Fn(&str) -> Option<String>) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c != '%' {
            out.push(c);
            i += 1;
            continue;
        }
        if let Some(d) = chars.get(i + 1).and_then(|c| c.to_digit(10)).filter(|d| *d >= 1) {
            out.push_str(params.get(d as usize - 1).map(String::as_str).unwrap_or(""));
            i += 2;
            continue;
        }
        if let Some(j) = chars[i + 1..].iter().position(|c| *c == '%').map(|p| p + i + 1) {
            let name: String = chars[i + 1..j].iter().collect();
            if name.is_empty() {
                out.push('%');
                i = j + 1;
                continue;
            }
            if let Some(v) = var(&name) {
                out.push_str(&v);
                i = j + 1;
                continue;
            }
        }
        out.push('%');
        i += 1;
    }
    out
}

fn builtin_var(name: &str) -> Option<String> {
    let now = Local::now();
    match name.to_ascii_lowercase().as_str() {
        "date" => Some(now.format("%Y-%m-%d").to_string()),
        "time" => Some(now.format("%I:%M:%S %p").to_string()),
        "fn_time" => Some(now.format("%H-%M-%S").to_string()),
        _ if !name.chars().any(char::is_whitespace) => std::env::var(name).ok(),
        _ => None,
    }
}

/// Case-insensitive `strip_prefix`.
fn strip_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s.is_char_boundary(prefix.len()) && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sides {
    Left,
    Right,
    All,
}

impl Sides {
    fn parse(s: &str) -> Option<Sides> {
        match s.to_ascii_lowercase().as_str() {
            "left" | "lt" => Some(Sides::Left),
            "right" | "rt" => Some(Sides::Right),
            "all" => Some(Sides::All),
            _ => None,
        }
    }
    fn has(self, left: bool) -> bool {
        match self {
            Sides::Left => left,
            Sides::Right => !left,
            Sides::All => true,
        }
    }
}

/// `left->right` → Some(true), `right->left` → Some(false).
fn direction(s: &str) -> Option<bool> {
    let (a, b) = s.split_once("->")?;
    match (Sides::parse(a)?, Sides::parse(b)?) {
        (Sides::Left, Sides::Right) => Some(true),
        (Sides::Right, Sides::Left) => Some(false),
        _ => None,
    }
}

/// Parses a timestamp leniently in local time: "12/31/2012 12:00:00 PM", "12/31/2012 12:00pm",
/// "12/31/2012", "2012-12-31 13:00:00", "2012-12-31", "Dec 31, 2012".
fn parse_timestamp(s: &str) -> Option<i64> {
    let mut t = s.trim().to_ascii_uppercase().replace('T', " ");
    for suffix in ["AM", "PM"] {
        if t.ends_with(suffix) && !t.ends_with(&format!(" {suffix}")) && t.len() > 2 {
            t.insert(t.len() - 2, ' ');
        }
    }
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    const DATETIME: &[&str] = &[
        "%m/%d/%Y %I:%M:%S %p",
        "%m/%d/%Y %I:%M %p",
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d %I:%M:%S %p",
        "%Y-%m-%d %I:%M %p",
        "%b %d, %Y %I:%M:%S %p",
        "%b %d, %Y %I:%M %p",
        "%b %d, %Y %H:%M:%S",
        "%b %d, %Y %H:%M",
        "%B %d, %Y %H:%M:%S",
    ];
    const DATE: &[&str] = &["%m/%d/%Y", "%Y-%m-%d", "%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y", "%Y/%m/%d"];
    let dt = DATETIME
        .iter()
        .find_map(|f| NaiveDateTime::parse_from_str(&t, f).ok())
        .or_else(|| DATE.iter().find_map(|f| NaiveDate::parse_from_str(&t, f).ok()).and_then(|d| d.and_hms_opt(0, 0, 0)))?;
    Local.from_local_datetime(&dt).earliest().map(|t| t.timestamp_millis())
}

/// Applies a DOS-style rename mask (`*.bak`, `???_old.*`) to a file name.
fn dos_rename(name: &str, mask: &str) -> String {
    let src: Vec<char> = name.chars().collect();
    let m: Vec<char> = mask.chars().collect();
    let mut out = String::new();
    let mut p = 0;
    let mut i = 0;
    while i < m.len() {
        match m[i] {
            '*' => match m.get(i + 1) {
                // Copy up to the last occurrence of the next mask character (or everything).
                Some(&c) => {
                    let end = src.iter().rposition(|x| *x == c).filter(|e| *e >= p).unwrap_or(src.len());
                    out.extend(&src[p..end]);
                    p = end;
                }
                None => {
                    out.extend(&src[p.min(src.len())..]);
                    p = src.len();
                }
            },
            '?' => {
                if let Some(c) = src.get(p) {
                    out.push(*c);
                }
                p += 1;
            }
            // A dot moves on to the source's extension.
            '.' => {
                out.push('.');
                p = src.iter().rposition(|x| *x == '.').map(|d| d + 1).unwrap_or(src.len());
            }
            c => {
                out.push(c);
                p += 1;
            }
        }
        i += 1;
    }
    out
}

/// Converts `$N` / `\N` group references to the regex crate's `${N}` form.
fn regex_replacement(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if (c == '$' || c == '\\') && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()) {
            out.push_str(&format!("${{{}}}", chars[i + 1]));
            i += 2;
        } else if c == '$' {
            out.push_str("$$");
            i += 1;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

fn elapsed(start: Instant) -> String {
    let e = start.elapsed();
    if e.as_millis() < 1 { "0".into() } else { format!("{:.2}", e.as_secs_f64()) }
}

fn parse_size(s: &str) -> Option<u64> {
    let u = s.trim().to_ascii_uppercase();
    let (num, mult) = [("TB", 1u64 << 40), ("GB", 1 << 30), ("MB", 1 << 20), ("KB", 1 << 10), ("B", 1)]
        .iter()
        .find_map(|(suf, m)| u.strip_suffix(suf).map(|n| (n.trim().to_string(), *m)))
        .unwrap_or((u.clone(), 1));
    let v: f64 = num.parse().ok()?;
    (v >= 0.0).then(|| (v * mult as f64).round() as u64)
}

// ---------------------------------------------------------------------------
// State

enum Fail {
    /// Ends the script, logging "Fatal Scripting Error: <msg>".
    Fatal(i32, String),
    /// Logged; ends the script only with `option stop-on-error`.
    Error(String),
    /// Ends the script; the reason has already been logged.
    Abort(i32),
}

type R = Result<(), Fail>;

fn syntax(msg: impl Into<String>) -> Fail {
    Fail::Fatal(EXIT_SYNTAX, msg.into())
}

enum Loaded {
    None,
    Folders { left: String, right: String, root: Node },
    Files { left: String, right: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Confirm {
    Prompt,
    YesToAll,
    NoToAll,
}

/// A node of the loaded comparison in display order, with its location on both sides.
struct Item<'n> {
    node: &'n Node,
    visible: bool,
    /// Path of the item on each side; for a missing side, where it would be created.
    lslot: PathBuf,
    rslot: PathBuf,
}

impl Item<'_> {
    fn has(&self, left: bool) -> bool {
        side(self.node, left).is_some()
    }
    fn slot(&self, left: bool) -> &Path {
        if left { &self.lslot } else { &self.rslot }
    }
}

fn side(n: &Node, left: bool) -> Option<&folder::Side> {
    if left { n.left.as_ref() } else { n.right.as_ref() }
}

/// Name of the item on one side, falling back to the other side's name.
fn name_on(n: &Node, left: bool) -> String {
    side(n, left).or_else(|| side(n, !left)).map(|s| s.name.clone()).unwrap_or_else(|| n.name.clone())
}

#[allow(clippy::too_many_arguments)]
fn collect<'n>(n: &'n Node, lp: &Path, rp: &Path, lbase: &str, rbase: &str, visible: bool, expanded: &HashSet<String>, out: &mut Vec<Item<'n>>) {
    for c in &n.children {
        let (lslot, rslot) = match (&c.left_path, &c.right_path) {
            (None, None) => (lp.join(name_on(c, true)), rp.join(name_on(c, false))),
            (l, r) => {
                let any = l.as_ref().or(r.as_ref()).cloned().unwrap_or_default();
                (folder::join_rel(lbase, l.as_ref().unwrap_or(&any)), folder::join_rel(rbase, r.as_ref().unwrap_or(&any)))
            }
        };
        out.push(Item { node: c, visible, lslot: lslot.clone(), rslot: rslot.clone() });
        if c.dir {
            collect(c, &lslot, &rslot, lbase, rbase, visible && expanded.contains(&c.rel), expanded, out);
        }
    }
}

fn items<'n>(root: &'n Node, lbase: &str, rbase: &str, expanded: &HashSet<String>) -> Vec<Item<'n>> {
    let mut out = vec![];
    collect(root, Path::new(lbase), Path::new(rbase), lbase, rbase, true, expanded, &mut out);
    out
}

/// Files below a folder (or the file itself) that exist on the given side, with their paths.
fn side_files<'n>(n: &'n Node, path: &Path, left: bool, out: &mut Vec<(&'n Node, PathBuf)>) {
    if !n.dir {
        if side(n, left).is_some() {
            out.push((n, path.to_path_buf()));
        }
        return;
    }
    for c in &n.children {
        if let Some(s) = side(c, left) {
            side_files(c, &path.join(&s.name), left, out);
        }
    }
}

fn all_dirs(n: &Node, out: &mut HashSet<String>) {
    for c in &n.children {
        if c.dir {
            out.insert(c.rel.clone());
            all_dirs(c, out);
        }
    }
}

fn find_mut<'n>(n: &'n mut Node, rel: &str) -> Option<&'n mut Node> {
    for c in n.children.iter_mut() {
        if c.rel == rel {
            return Some(c);
        }
        if c.dir && rel.starts_with(&format!("{}/", c.rel)) {
            return find_mut(c, rel);
        }
    }
    None
}

fn parent_rel(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

/// A selection mask: `[(left|right|all).][(exact|diff|newer|older|orphan|all).][(files|folders|all)]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Mask {
    sides: Sides,
    result: Res,
    files: bool,
    folders: bool,
    empty_folders: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Res {
    All,
    Exact,
    Diff,
    Newer,
    Older,
    Orphan,
}

fn parse_mask(s: &str) -> Option<Mask> {
    let l = s.to_ascii_lowercase();
    let mut m = Mask { sides: Sides::All, result: Res::All, files: true, folders: true, empty_folders: false };
    if l == "empty.folders" {
        m.empty_folders = true;
        m.files = false;
        return Some(m);
    }
    let mut stage = 0;
    for part in l.split('.') {
        loop {
            let ok = match stage {
                0 => Sides::parse(part).map(|s| m.sides = s).is_some(),
                1 => {
                    let r = match part {
                        "exact" => Some(Res::Exact),
                        "diff" => Some(Res::Diff),
                        "newer" => Some(Res::Newer),
                        "older" => Some(Res::Older),
                        "orphan" => Some(Res::Orphan),
                        "all" => Some(Res::All),
                        _ => None,
                    };
                    r.map(|r| m.result = r).is_some()
                }
                2 => match part {
                    "files" => {
                        m.folders = false;
                        true
                    }
                    "folders" => {
                        m.files = false;
                        true
                    }
                    "all" => true,
                    _ => false,
                },
                _ => return None,
            };
            stage += 1;
            if ok {
                break;
            }
        }
    }
    Some(m)
}

fn file_matches(n: &Node, left: bool, r: Res, timesize: bool) -> bool {
    let me = if left { "left" } else { "right" };
    match r {
        Res::All => true,
        Res::Exact => matches!(n.status, Status::Same | Status::Similar),
        Res::Diff => n.status == Status::Diff && !(timesize && n.newer.is_some()),
        Res::Newer => timesize && n.status == Status::Diff && n.newer.as_deref() == Some(me),
        Res::Older => timesize && n.status == Status::Diff && n.newer.as_deref().is_some_and(|x| x != me),
        Res::Orphan => n.status == if left { Status::Left } else { Status::Right },
    }
}

fn has_side_files(n: &Node, left: bool) -> bool {
    n.children.iter().any(|c| side(c, left).is_some() && (!c.dir || has_side_files(c, left)))
}

fn folder_matches(n: &Node, left: bool, r: Res, timesize: bool) -> bool {
    match r {
        Res::All => true,
        Res::Orphan => n.status == if left { Status::Left } else { Status::Right },
        _ => {
            let mut files = vec![];
            side_files(n, Path::new(""), left, &mut files);
            !files.is_empty() && files.iter().all(|(f, _)| file_matches(f, left, r, timesize))
        }
    }
}

pub struct Script<'a> {
    log: Logger,
    cwd: PathBuf,
    params: &'a [String],
    opts: FolderOptions,
    loaded: Loaded,
    expanded: HashSet<String>,
    /// Selected items as (left side?, relative path).
    selection: Vec<(bool, String)>,
    confirm: Confirm,
    stop_on_error: bool,
}

/// Runs a script file and returns the process exit code.
pub fn run(script: &str, params: &[String], silent: bool, cwd: &Path) -> i32 {
    let start = Instant::now();
    let mut path = cwd.join(script);
    if !path.exists() {
        let alt = sessions::config_dir().join("Scripts").join(script);
        if alt.exists() {
            path = alt;
        }
    }
    let text = match fs::read(&path) {
        Ok(b) => fileio::decode(&b).0,
        Err(e) => {
            eprintln!("Unable to load script \"{}\": {e}", path.display());
            return EXIT_SCRIPT_LOAD;
        }
    };
    let mut s = Script::new(params, silent, cwd);
    let code = s.run_text(&text);
    s.log.info(&format!("Script completed in {:.2} seconds", start.elapsed().as_secs_f64()));
    code
}

impl<'a> Script<'a> {
    fn new(params: &'a [String], silent: bool, cwd: &Path) -> Script<'a> {
        Script {
            log: Logger { file: None, level: Level::None, pending: vec![], banner: false, silent },
            cwd: cwd.to_path_buf(),
            params,
            opts: FolderOptions::default(),
            loaded: Loaded::None,
            expanded: HashSet::new(),
            selection: vec![],
            confirm: Confirm::Prompt,
            stop_on_error: false,
        }
    }

    fn run_text(&mut self, text: &str) -> i32 {
        let mut echo: Vec<String> = vec![];
        let mut stmt = String::new();
        for raw in text.split('\n') {
            let raw = raw.strip_suffix('\r').unwrap_or(raw);
            let line = expand_vars(raw, self.params, &builtin_var);
            echo.push(format!(">> {line}"));
            if stmt.is_empty() && line.trim_start().starts_with('#') {
                self.echo(&mut echo);
                continue;
            }
            if let Some(body) = line.trim_end().strip_suffix('&') {
                stmt.push_str(body);
                stmt.push(' ');
                continue;
            }
            stmt.push_str(&line);
            if let Some(code) = self.statement(&std::mem::take(&mut stmt), &mut echo) {
                return code;
            }
        }
        if !stmt.is_empty() {
            if let Some(code) = self.statement(&stmt, &mut echo) {
                return code;
            }
        }
        0
    }

    fn echo(&mut self, echo: &mut Vec<String>) {
        for e in std::mem::take(echo) {
            self.log.info(&e);
        }
    }

    /// Runs one (possibly continued) command line. Returns an exit code when the script ends.
    fn statement(&mut self, stmt: &str, echo: &mut Vec<String>) -> Option<i32> {
        let tokens = tokenize(stmt);
        let Some(first) = tokens.first() else {
            self.echo(echo);
            return None;
        };
        let cmd = first.to_ascii_lowercase();
        let args = &tokens[1..];
        // A log command's own line goes to the log it opens.
        let res = if cmd == "log" {
            // The line is written to the current log (if any) and to the one it opens.
            if self.log.file.is_some() {
                for e in echo.iter() {
                    self.log.store(Level::Normal, e);
                }
            }
            let r = self.cmd_log(args);
            for e in std::mem::take(echo) {
                self.log.store(Level::Normal, &e);
                if !self.log.silent {
                    println!("{e}");
                }
            }
            r
        } else {
            self.echo(echo);
            self.exec(&cmd, args)
        };
        match res {
            Ok(()) => None,
            Err(Fail::Fatal(code, msg)) => {
                self.log.error(&format!("Fatal Scripting Error: {msg}"));
                Some(code)
            }
            Err(Fail::Error(msg)) => {
                self.log.error(&format!("Script Error: {msg}"));
                self.stop_on_error.then_some(EXIT_ERROR)
            }
            Err(Fail::Abort(code)) => Some(code),
        }
    }

    /// Logs a non-fatal error; with stop-on-error the script ends.
    fn soft(&mut self, msg: String) -> R {
        self.log.error(&format!("Script Error: {msg}"));
        if self.stop_on_error { Err(Fail::Abort(EXIT_ERROR)) } else { Ok(()) }
    }

    fn warn(&mut self, msg: &str) {
        self.log.info(&format!("Warning: {msg}"));
    }

    fn abs(&self, p: &str) -> String {
        let pb = self.cwd.join(p.replace(if cfg!(windows) { '/' } else { '\\' }, std::path::MAIN_SEPARATOR_STR));
        let s = pb.to_string_lossy().into_owned();
        let trimmed = s.trim_end_matches(['/', '\\']);
        if trimmed.is_empty() || trimmed.ends_with(':') { s } else { trimmed.to_string() }
    }

    fn exec(&mut self, cmd: &str, args: &[String]) -> R {
        match cmd {
            "load" => self.cmd_load(args),
            "expand" => self.cmd_expand(args, true),
            "collapse" => self.cmd_expand(args, false),
            "select" => self.cmd_select(args),
            "criteria" => self.cmd_criteria(args),
            "filter" => self.cmd_filter(args),
            "option" => self.cmd_option(args),
            "compare" => self.cmd_compare(args),
            "copy" => self.cmd_copy(args, false),
            "move" => self.cmd_copy(args, true),
            "copyto" => self.cmd_copyto(args, false),
            "moveto" => self.cmd_copyto(args, true),
            "delete" => self.cmd_delete(args),
            "touch" => self.cmd_touch(args),
            "rename" => self.cmd_rename(args),
            "sync" => self.cmd_sync(args),
            "snapshot" => self.cmd_snapshot(args),
            "beep" => {
                eprint!("\x07");
                Ok(())
            }
            "attrib" => Err(Fail::Error("attrib is not supported on this platform".into())),
            "folder-report" => self.cmd_folder_report(args),
            "file-report" => self.cmd_file_report(args, None),
            "media-report" | "registry-report" | "version-report" => Err(Fail::Error(format!("{cmd} is not supported"))),
            _ => match report::report_kind(cmd) {
                Some(kind) => self.cmd_file_report(args, Some(kind)),
                None => Err(syntax(format!("Unknown command \"{cmd}\""))),
            },
        }
    }

    // -----------------------------------------------------------------------
    // Comparison state

    fn folders(&self) -> Result<(String, String, Node), Fail> {
        match &self.loaded {
            Loaded::Folders { left, right, root } => Ok((left.clone(), right.clone(), root.clone())),
            _ => Err(Fail::Error("No folder comparison is loaded".into())),
        }
    }

    fn timesize(&self) -> bool {
        self.opts.criteria == "timesize"
    }

    /// Re-compares the loaded folders (after file operations or option changes).
    fn refresh(&mut self) -> R {
        if let Loaded::Folders { left, right, .. } = &self.loaded {
            let (l, r) = (left.clone(), right.clone());
            match folder::compare_folders(&l, &r, &self.opts) {
                Ok(res) => self.loaded = Loaded::Folders { left: l, right: r, root: res.root },
                Err(e) => return Err(Fail::Error(format!("Unable to refresh the comparison: {e}"))),
            }
        }
        Ok(())
    }

    fn selected_set(&self) -> HashSet<(bool, String)> {
        self.selection.iter().cloned().collect()
    }

    /// Selected items on a side whose ancestors are not selected too, in display order.
    fn top_selected<'n>(&self, list: &'n [Item<'n>], left: bool) -> Vec<&'n Item<'n>> {
        let sel = self.selected_set();
        list.iter()
            .filter(|it| it.has(left) && sel.contains(&(left, it.node.rel.clone())))
            .filter(|it| {
                let mut p = parent_rel(&it.node.rel);
                while !p.is_empty() {
                    if sel.contains(&(left, p.to_string())) {
                        return false;
                    }
                    p = parent_rel(p);
                }
                true
            })
            .collect()
    }

    /// Distinct selected items (either side), in display order.
    fn selected_items<'n>(&self, list: &'n [Item<'n>]) -> Vec<&'n Item<'n>> {
        let sel = self.selected_set();
        list.iter().filter(|it| sel.contains(&(true, it.node.rel.clone())) || sel.contains(&(false, it.node.rel.clone()))).collect()
    }

    fn filter_lines(&self) -> Vec<String> {
        report::folder_filter_lines(&self.opts)
    }

    fn done(&mut self, verb: &str, n: usize, skipped: usize, start: Instant) {
        if n == 0 && skipped == 0 {
            return;
        }
        let skip = if skipped > 0 { format!("  {skipped} items skipped.") } else { String::new() };
        self.log.info(&format!("Successfully {verb} {n} items.{skip}  Completed in {} seconds.", elapsed(start)));
    }

    // -----------------------------------------------------------------------
    // Commands: setup

    fn cmd_log(&mut self, args: &[String]) -> R {
        let mut level = Level::Normal;
        let mut file: Option<&str> = None;
        for a in args {
            match a.to_ascii_lowercase().as_str() {
                "none" => level = Level::None,
                "normal" => level = Level::Normal,
                "verbose" => level = Level::Verbose,
                _ => file = Some(a),
            }
        }
        let (append, name) = match file {
            Some(f) => match strip_ci(f, "append:") {
                Some(rest) => (true, rest),
                None => (false, f),
            },
            None => (false, "Log.txt"),
        };
        let path = PathBuf::from(self.abs(name));
        self.log.open(&path, append, level).map_err(|e| Fail::Fatal(EXIT_ERROR, e))
    }

    fn cmd_option(&mut self, args: &[String]) -> R {
        for a in args {
            let l = a.to_ascii_lowercase();
            match l.as_str() {
                "stop-on-error" => self.stop_on_error = true,
                "confirm:prompt" => self.confirm = Confirm::Prompt,
                "confirm:yes-to-all" => self.confirm = Confirm::YesToAll,
                "confirm:no-to-all" => self.confirm = Confirm::NoToAll,
                _ => return Err(syntax(format!("Invalid option \"{a}\""))),
            }
        }
        Ok(())
    }

    fn cmd_load(&mut self, args: &[String]) -> R {
        let mut args: Vec<&str> = args.iter().map(String::as_str).collect();
        self.expanded.clear();
        self.selection.clear();
        if args.is_empty() {
            return Err(syntax("load requires a comparison"));
        }
        if args.len() == 1 && args[0].eq_ignore_ascii_case("<default>") {
            self.opts = FolderOptions::default();
            self.loaded = Loaded::None;
            return Ok(());
        }
        let mut create: Option<Sides> = None;
        if let Some(c) = strip_ci(args[0], "create:") {
            create = Some(Sides::parse(c).ok_or_else(|| syntax(format!("Invalid argument \"{}\"", args[0])))?);
            args.remove(0);
        }
        let (left, right) = match args.as_slice() {
            [one] => {
                let p = PathBuf::from(self.abs(one));
                if p.exists() {
                    return Err(syntax("load requires two paths or a session name"));
                }
                match sessions::find_by_name(one) {
                    Some(s) if s.paths.len() >= 2 => {
                        if let Some(v) = s.options.get("folder") {
                            if let Ok(o) = serde_json::from_value::<FolderOptions>(v.clone()) {
                                self.opts = o;
                            }
                        }
                        (s.paths[0].clone(), s.paths[1].clone())
                    }
                    _ => return self.load_failed(one, "", "Unable to load session"),
                }
            }
            [l, r] => (self.abs(l), self.abs(r)),
            _ => return Err(syntax("load requires two paths or a session name")),
        };
        for (p, left_side) in [(&left, true), (&right, false)] {
            if create.is_some_and(|c| c.has(left_side)) && !Path::new(p).exists() {
                let _ = fs::create_dir_all(p);
            }
        }
        let (lp, rp) = (Path::new(&left), Path::new(&right));
        self.log.info(&format!("Load comparison: {left} <-> {right}"));
        if lp.is_file() && rp.is_file() {
            self.loaded = Loaded::Files { left, right };
            return Ok(());
        }
        if !lp.is_dir() || !rp.is_dir() {
            self.loaded = Loaded::None;
            let which = if !lp.is_dir() { "base" } else { "comparison" };
            return Err(Fail::Fatal(EXIT_LOAD, format!("Unable to load {which} folder")));
        }
        match folder::compare_folders(&left, &right, &self.opts) {
            Ok(res) => {
                self.loaded = Loaded::Folders { left, right, root: res.root };
                Ok(())
            }
            Err(e) => Err(Fail::Fatal(EXIT_LOAD, format!("Unable to load folders: {e}"))),
        }
    }

    fn load_failed(&mut self, l: &str, r: &str, msg: &str) -> R {
        self.log.info(&format!("Load comparison: {l} <-> {r}"));
        self.loaded = Loaded::None;
        Err(Fail::Fatal(EXIT_LOAD, msg.to_string()))
    }

    fn cmd_expand(&mut self, args: &[String], expand: bool) -> R {
        let (_, _, root) = self.folders()?;
        if args.is_empty() {
            return Err(syntax(format!("{} requires arguments", if expand { "expand" } else { "collapse" })));
        }
        for a in args {
            if a.eq_ignore_ascii_case("all") {
                if expand {
                    all_dirs(&root, &mut self.expanded);
                } else {
                    self.expanded.clear();
                }
                continue;
            }
            let rel = a.replace('\\', "/").trim_matches('/').to_string();
            if expand {
                let mut p = rel.as_str();
                while !p.is_empty() {
                    self.expanded.insert(p.to_string());
                    p = parent_rel(p);
                }
            } else {
                let pre = format!("{rel}/");
                self.expanded.retain(|e| *e != rel && !e.starts_with(&pre));
            }
        }
        Ok(())
    }

    fn cmd_select(&mut self, args: &[String]) -> R {
        let (l, r, root) = self.folders()?;
        let masks: Vec<Mask> = args
            .iter()
            .map(|a| parse_mask(a).ok_or_else(|| syntax(format!("Invalid selection \"{a}\""))))
            .collect::<Result<_, _>>()?;
        if masks.is_empty() {
            return Err(syntax("select requires arguments"));
        }
        let ts = self.timesize();
        let list = items(&root, &l, &r, &self.expanded);
        let mut sel = vec![];
        for it in list.iter().filter(|it| it.visible) {
            for left in [true, false] {
                if !it.has(left) {
                    continue;
                }
                let n = it.node;
                let hit = masks.iter().any(|m| {
                    if !m.sides.has(left) {
                        return false;
                    }
                    if m.empty_folders {
                        return n.dir && !has_side_files(n, left);
                    }
                    if n.dir {
                        m.folders && folder_matches(n, left, m.result, ts)
                    } else {
                        m.files && file_matches(n, left, m.result, ts)
                    }
                });
                if hit {
                    sel.push((left, n.rel.clone()));
                }
            }
        }
        self.selection = sel;
        Ok(())
    }

    fn cmd_criteria(&mut self, args: &[String]) -> R {
        let mut o = FolderOptions { criteria: String::new(), time_tolerance_secs: 0, ignore_dst: false, ignore_tz: false, follow_symlinks: false, ..self.opts.clone() };
        let (mut ts, mut size) = (false, false);
        for a in args {
            let l = a.to_ascii_lowercase();
            if let Some(rest) = l.strip_prefix("timestamp") {
                ts = true;
                for part in rest.trim_start_matches(':').split([';', ':']).filter(|s| !s.is_empty()) {
                    if part == "ignoredst" {
                        o.ignore_dst = true;
                    } else if let Some(n) = part.strip_suffix("sec").and_then(|n| n.trim().parse::<i64>().ok()) {
                        o.time_tolerance_secs = n;
                    } else {
                        self.warn(&format!("Unsupported criteria \"{a}\""));
                    }
                }
                continue;
            }
            match l.as_str() {
                "size" => size = true,
                "crc" | "binary" => o.criteria = l.clone(),
                "rules-based" => o.criteria = "rules".into(),
                "timezone:ignore" => o.ignore_tz = true,
                "follow-symlinks" => o.follow_symlinks = true,
                _ => self.warn(&format!("Unsupported criteria \"{a}\"")),
            }
        }
        if ts {
            o.criteria = "timesize".into();
        } else if size && o.criteria.is_empty() {
            o.criteria = "size".into();
        }
        if o.criteria.is_empty() {
            o.criteria = "timesize".into();
            o.time_tolerance_secs = 2;
        }
        self.opts = o;
        self.refresh()
    }

    fn cmd_filter(&mut self, args: &[String]) -> R {
        let mut masks: Vec<&str> = vec![];
        for a in args {
            if let Some(v) = strip_ci(a, "cutoff:") {
                self.opts.other_filters.retain(|f| f.kind != "date");
                if v.eq_ignore_ascii_case("none") {
                    continue;
                }
                let (newer, v) = match v.chars().next() {
                    Some('>') => (true, &v[1..]),
                    Some('<') => (false, &v[1..]),
                    _ => (false, v),
                };
                let lv = v.to_ascii_lowercase();
                let days = lv.strip_suffix("days").or_else(|| lv.strip_suffix("day")).unwrap_or(&lv).trim().parse::<u32>().ok();
                let f = match days {
                    Some(d) => OtherFilter { kind: "date".into(), newer, days: Some(d), ..Default::default() },
                    None => match parse_timestamp(v) {
                        Some(ms) => OtherFilter { kind: "date".into(), newer, date: Some(ms), ..Default::default() },
                        None => return Err(syntax(format!("Invalid cutoff \"{v}\""))),
                    },
                };
                self.opts.other_filters.push(f);
            } else if let Some(v) = strip_ci(a, "size:") {
                self.opts.other_filters.retain(|f| f.kind != "size");
                if v.eq_ignore_ascii_case("none") {
                    continue;
                }
                let (larger, v) = match v.chars().next() {
                    Some('>') => (true, &v[1..]),
                    Some('<') => (false, &v[1..]),
                    _ => (true, v),
                };
                let size = parse_size(v).ok_or_else(|| syntax(format!("Invalid size \"{v}\"")))?;
                self.opts.other_filters.push(OtherFilter { kind: "size".into(), larger, size, ..Default::default() });
            } else if a.eq_ignore_ascii_case("exclude-protected") {
                self.opts.exclude_hidden = true;
            } else if strip_ci(a, "attrib:").is_some() || strip_ci(a, "unixtype:").is_some() {
                self.warn(&format!("Attribute filters are not supported: \"{a}\""));
            } else {
                masks.push(a);
            }
        }
        if !masks.is_empty() {
            self.opts.include = masks.join(";");
            self.opts.exclude.clear();
            self.opts.include_folders.clear();
        }
        self.refresh()
    }

    fn cmd_compare(&mut self, args: &[String]) -> R {
        let (l, r, mut root) = self.folders()?;
        let mut o = self.opts.clone();
        match args.first().map(|a| a.to_ascii_lowercase()).as_deref() {
            None => {}
            Some("crc") => o.criteria = "crc".into(),
            Some("binary") => o.criteria = "binary".into(),
            Some("rules-based") => o.criteria = "rules".into(),
            Some(a) => return Err(syntax(format!("Invalid argument \"{a}\""))),
        }
        let rels: Vec<String> = {
            let list = items(&root, &l, &r, &self.expanded);
            let mut out = vec![];
            for it in self.selected_items(&list) {
                let mut files = vec![];
                side_files(it.node, Path::new(""), true, &mut files);
                side_files(it.node, Path::new(""), false, &mut files);
                for (f, _) in files {
                    if f.left.is_some() && f.right.is_some() && !out.contains(&f.rel) {
                        out.push(f.rel.clone());
                    }
                }
            }
            out
        };
        for (rel, node) in rels.iter().zip(folder::compare_items(&l, &r, &rels, &o)) {
            if let (Some(n), Some(slot)) = (node, find_mut(&mut root, rel)) {
                slot.status = n.status;
                slot.newer = n.newer;
            }
        }
        self.loaded = Loaded::Folders { left: l, right: r, root };
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Commands: reports

    /// Splits report arguments into the spec and the trailing comparison paths.
    fn report_args(&mut self, args: &[String]) -> Result<(ReportSpec, Vec<String>), Fail> {
        let mut spec = ReportSpec::default();
        let mut rest = vec![];
        let list = |v: &str| v.split(',').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect::<Vec<_>>();
        for a in args {
            if let Some(v) = strip_ci(a, "layout:") {
                spec.layout = v.to_ascii_lowercase();
            } else if let Some(v) = strip_ci(a, "options:") {
                spec.options = list(v);
            } else if let Some(v) = strip_ci(a, "title:") {
                spec.title = Some(v.to_string());
            } else if let Some(v) = strip_ci(a, "output-to:") {
                spec.output_to = v.to_string();
            } else if let Some(v) = strip_ci(a, "output-options:") {
                for o in v.split(',').map(str::trim).filter(|o| !o.is_empty()) {
                    match strip_ci(o, "html-custom=") {
                        Some(url) => {
                            spec.output_options.push("html-custom".into());
                            spec.css = Some(url.trim_matches('"').to_string());
                        }
                        None => spec.output_options.push(o.to_ascii_lowercase()),
                    }
                }
            } else {
                rest.push(a.clone());
            }
        }
        if spec.output_to.is_empty() {
            return Err(syntax("Report requires output-to"));
        }
        if spec.has("stats-descriptive") {
            self.log.info("STATS-DESCRIPTIVE report is unavailable.  Switching to SUMMARY report.");
            spec.options.retain(|o| o != "stats-descriptive");
            spec.layout = "summary".into();
        }
        Ok((spec, rest))
    }

    fn deliver(&mut self, spec: &ReportSpec, out: Result<report::Output, String>) -> R {
        let out = out.map_err(Fail::Error)?;
        report::deliver(spec, &out, &self.cwd).map_err(Fail::Error)
    }

    fn cmd_folder_report(&mut self, args: &[String]) -> R {
        let (spec, rest) = self.report_args(args)?;
        // A folder report covers the loaded comparison only.
        if let Some(a) = rest.first() {
            return Err(syntax(&format!("Unexpected argument(s) \"{a}\"")));
        }
        let (l, r, root) = self.folders()?;
        let expanded = self.expanded.clone();
        let is_open = move |rel: &str| expanded.contains(rel);
        let cx = FolderCtx { root: &root, left_base: &l, right_base: &r, timesize: self.timesize(), expanded: &is_open, filters: self.filter_lines() };
        let out = report::folder_report(&spec, &cx);
        self.deliver(&spec, out)
    }

    fn cmd_file_report(&mut self, args: &[String], forced: Option<&str>) -> R {
        let (spec, rest) = self.report_args(args)?;
        if forced == Some("hex") && spec.has("display-context") {
            return Err(syntax("Unexpected argument(s) \"display-context\""));
        }
        if rest.len() == 2 {
            let (l, r) = (self.abs(&rest[0]), self.abs(&rest[1]));
            let kind = forced.map(str::to_string).unwrap_or_else(|| fileio::detect_kind(&l));
            let text = report::pair_report(&kind, &l, &r, &spec);
            return self.deliver(&spec, text);
        }
        if rest.len() == 1 {
            self.cmd_load(&rest)?;
        } else if !rest.is_empty() {
            return Err(syntax("Invalid report arguments"));
        }
        let (files, l, r) = match &self.loaded {
            Loaded::Files { left, right } => {
                let name = Path::new(left).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                (vec![FileItem { rel: name, left: Some(left.into()), right: Some(right.into()) }], String::new(), String::new())
            }
            Loaded::Folders { left, right, root } => {
                let list = items(root, left, right, &self.expanded);
                let mut out = vec![];
                for it in self.selected_items(&list) {
                    let mut fs_ = vec![];
                    side_files(it.node, Path::new(""), true, &mut fs_);
                    side_files(it.node, Path::new(""), false, &mut fs_);
                    let mut seen = HashSet::new();
                    for (f, _) in fs_ {
                        if !seen.insert(f.rel.clone()) || out.iter().any(|x: &FileItem| x.rel == f.rel) {
                            continue;
                        }
                        let fi = list.iter().find(|x| x.node.rel == f.rel);
                        let (lp, rp) = match fi {
                            Some(x) => (x.lslot.clone(), x.rslot.clone()),
                            None => (folder::join_rel(left, &f.rel), folder::join_rel(right, &f.rel)),
                        };
                        out.push(FileItem { rel: f.rel.clone(), left: f.left.as_ref().map(|_| lp), right: f.right.as_ref().map(|_| rp) });
                    }
                }
                (out, left.clone(), right.clone())
            }
            Loaded::None => return Err(Fail::Error("No comparison is loaded".into())),
        };
        let text = report::file_report(&spec, &files, &l, &r, forced);
        self.deliver(&spec, text)
    }

    // -----------------------------------------------------------------------
    // Commands: file operations

    fn sides_arg(args: &[String], i: usize, default: Sides) -> (Sides, usize) {
        match args.get(i).and_then(|a| Sides::parse(a)) {
            Some(s) => (s, i + 1),
            None => (default, i),
        }
    }

    fn cmd_copy(&mut self, args: &[String], mv: bool) -> R {
        let from_left = match args.first().and_then(|a| direction(a)) {
            Some(d) if args.len() == 1 => d,
            _ => return Err(syntax(format!("{} requires left->right or right->left", if mv { "move" } else { "copy" }))),
        };
        let (l, r, root) = self.folders()?;
        let list = items(&root, &l, &r, &self.expanded);
        let jobs: Vec<(PathBuf, PathBuf)> = self.top_selected(&list, from_left).iter().map(|it| (it.slot(from_left).to_path_buf(), it.slot(!from_left).to_path_buf())).collect();
        self.transfer(jobs, mv)?;
        self.refresh()
    }

    fn cmd_copyto(&mut self, args: &[String], mv: bool) -> R {
        let (sides, mut i) = Script::sides_arg(args, 0, Sides::All);
        let mut mode = "relative".to_string();
        if let Some(m) = args.get(i).and_then(|a| strip_ci(a, "path:")) {
            mode = m.to_ascii_lowercase();
            if !matches!(mode.as_str(), "relative" | "base" | "none") {
                return Err(syntax(format!("Invalid argument \"{}\"", args[i])));
            }
            i += 1;
        }
        let Some(dest) = args.get(i).filter(|_| args.len() == i + 1) else {
            return Err(syntax(format!("{} requires a destination folder", if mv { "moveto" } else { "copyto" })));
        };
        let dest = PathBuf::from(self.abs(dest));
        let (l, r, root) = self.folders()?;
        let list = items(&root, &l, &r, &self.expanded);
        let mut jobs = vec![];
        for left in [true, false] {
            if !sides.has(left) {
                continue;
            }
            let base = Path::new(if left { &l } else { &r });
            let tops = self.top_selected(&list, left);
            let rels: Vec<PathBuf> = tops.iter().map(|it| it.slot(left).strip_prefix(base).unwrap_or(it.slot(left)).to_path_buf()).collect();
            // Common parent folder of the selected items, for path:relative.
            let mut common: Option<PathBuf> = None;
            for rel in &rels {
                let parent = rel.parent().unwrap_or(Path::new("")).to_path_buf();
                common = Some(match common {
                    None => parent,
                    Some(c) => c.components().zip(parent.components()).take_while(|(a, b)| a == b).map(|(a, _)| a).collect(),
                });
            }
            let common = common.unwrap_or_default();
            for (it, rel) in tops.iter().zip(&rels) {
                let target = match mode.as_str() {
                    "none" => dest.join(rel.file_name().unwrap_or_default()),
                    "base" => dest.join(rel),
                    _ => dest.join(rel.strip_prefix(&common).unwrap_or(rel)),
                };
                jobs.push((it.slot(left).to_path_buf(), target));
            }
        }
        self.transfer(jobs, mv)?;
        self.refresh()
    }

    /// Copies or moves items, logging each one and the summary.
    fn transfer(&mut self, jobs: Vec<(PathBuf, PathBuf)>, mv: bool) -> R {
        let start = Instant::now();
        let mut count = 0;
        for (src, dst) in jobs {
            if dst.exists() && self.confirm == Confirm::NoToAll {
                continue;
            }
            let files = count_files(&src);
            let res = (|| -> std::io::Result<()> {
                if let Some(p) = dst.parent() {
                    fs::create_dir_all(p)?;
                }
                if mv {
                    if fs::rename(&src, &dst).is_err() {
                        folder::copy_recursive(&src, &dst)?;
                        remove_path(&src, false)?;
                    }
                    Ok(())
                } else {
                    folder::copy_recursive(&src, &dst)
                }
            })();
            let dir = dst.parent().unwrap_or(Path::new("")).display().to_string();
            match res {
                Ok(()) => {
                    count += files;
                    self.log.verbose(&format!("{} {} to {dir}", if mv { "Moved" } else { "Copied" }, src.display()));
                }
                Err(e) => self.soft(format!("Unable to {} {}: {e}", if mv { "move" } else { "copy" }, src.display()))?,
            }
        }
        self.done(if mv { "moved" } else { "copied" }, count, 0, start);
        Ok(())
    }

    fn cmd_delete(&mut self, args: &[String]) -> R {
        let mut recycle = false;
        let mut i = 0;
        if let Some(v) = args.first().and_then(|a| strip_ci(a, "recyclebin=")) {
            recycle = v.eq_ignore_ascii_case("yes");
            i = 1;
        }
        let Some(sides) = args.get(i).and_then(|a| Sides::parse(a)).filter(|_| args.len() == i + 1) else {
            return Err(syntax("delete requires left, right or all"));
        };
        let (l, r, root) = self.folders()?;
        let list = items(&root, &l, &r, &self.expanded);
        let mut targets = vec![];
        for left in [true, false] {
            if sides.has(left) {
                targets.extend(self.top_selected(&list, left).iter().map(|it| it.slot(left).to_path_buf()));
            }
        }
        let start = Instant::now();
        let mut count = 0;
        if self.confirm != Confirm::NoToAll {
            for p in targets {
                let n = count_items(&p);
                match remove_path(&p, recycle) {
                    Ok(()) => {
                        count += n;
                        self.log.verbose(&format!("Deleted {}", p.display()));
                    }
                    Err(e) => self.soft(format!("Unable to delete {}: {e}", p.display()))?,
                }
            }
        }
        self.done("deleted", count, 0, start);
        self.refresh()
    }

    fn cmd_touch(&mut self, args: &[String]) -> R {
        let arg = match args {
            [a] => a.as_str(),
            [a, b] => return self.cmd_touch(&[format!("{a} {b}")]),
            _ => return Err(syntax("touch requires one argument")),
        };
        let (l, r, root) = self.folders()?;
        let list = items(&root, &l, &r, &self.expanded);
        let start = Instant::now();
        let mut count = 0;
        if let Some(from_left) = direction(arg) {
            let jobs: Vec<(PathBuf, PathBuf)> = self
                .top_selected(&list, from_left)
                .iter()
                .filter(|it| it.has(!from_left))
                .map(|it| (it.slot(from_left).to_path_buf(), it.slot(!from_left).to_path_buf()))
                .collect();
            for (src, dst) in jobs {
                let res = fs::metadata(&src).and_then(|m| filetime::set_file_mtime(&dst, filetime::FileTime::from_last_modification_time(&m)));
                match res {
                    Ok(()) => {
                        count += 1;
                        self.log.verbose(&format!("Touched {}", dst.display()));
                    }
                    Err(e) => self.soft(format!("Unable to touch {}: {e}", dst.display()))?,
                }
            }
        } else {
            let (side_s, when) = arg.split_once(':').ok_or_else(|| syntax(format!("Invalid argument \"{arg}\"")))?;
            let sides = Sides::parse(side_s).ok_or_else(|| syntax(format!("Invalid argument \"{arg}\"")))?;
            let ms = if when.eq_ignore_ascii_case("now") {
                report::now_ms()
            } else {
                parse_timestamp(when).ok_or_else(|| Fail::Error(format!("Invalid timestamp \"{when}\"")))?
            };
            let ft = filetime::FileTime::from_unix_time(ms.div_euclid(1000), (ms.rem_euclid(1000) * 1_000_000) as u32);
            let mut paths = vec![];
            for left in [true, false] {
                if sides.has(left) {
                    for it in self.top_selected(&list, left) {
                        let mut files = vec![];
                        side_files(it.node, it.slot(left), left, &mut files);
                        paths.extend(files.into_iter().map(|(_, p)| p));
                    }
                }
            }
            for p in paths {
                match filetime::set_file_mtime(&p, ft) {
                    Ok(()) => {
                        count += 1;
                        self.log.verbose(&format!("Touched {}", p.display()));
                    }
                    Err(e) => self.soft(format!("Unable to touch {}: {e}", p.display()))?,
                }
            }
        }
        self.done("touched", count, 0, start);
        self.refresh()
    }

    fn cmd_rename(&mut self, args: &[String]) -> R {
        enum How {
            Regex(regex::Regex, String),
            Mask(String),
        }
        let how = match args {
            [kw, old, new] if kw.eq_ignore_ascii_case("regexpr") => {
                let re = regex::Regex::new(&format!("^(?:{old})$")).map_err(|e| syntax(format!("Invalid regular expression: {e}")))?;
                How::Regex(re, regex_replacement(new))
            }
            [mask] => How::Mask(mask.clone()),
            _ => return Err(syntax("rename requires a new name or regexpr <old> <new>")),
        };
        let (l, r, root) = self.folders()?;
        let list = items(&root, &l, &r, &self.expanded);
        let sel = self.selected_set();
        let mut picked: Vec<&Item> = list.iter().filter(|it| sel.contains(&(true, it.node.rel.clone())) || sel.contains(&(false, it.node.rel.clone()))).collect();
        // Rename deeper items first so their parent folders still exist.
        picked.sort_by_key(|it| std::cmp::Reverse(it.node.rel.matches('/').count()));
        let mut jobs = vec![];
        for it in picked {
            for left in [true, false] {
                if !(it.has(left) && sel.contains(&(left, it.node.rel.clone()))) {
                    continue;
                }
                let old = name_on(it.node, left);
                let new = match &how {
                    How::Regex(re, rep) => re.is_match(&old).then(|| re.replace(&old, rep.as_str()).into_owned()),
                    How::Mask(m) => Some(dos_rename(&old, m)),
                };
                jobs.push((left, it.node.rel.clone(), it.slot(left).to_path_buf(), new.filter(|n| *n != old && !n.is_empty())));
            }
        }
        let start = Instant::now();
        let (mut count, mut skipped) = (0, 0);
        let mut renamed: HashMap<(bool, String), String> = HashMap::new();
        for (left, rel, path, new) in jobs {
            let Some(new) = new else {
                skipped += 1;
                continue;
            };
            let dst = path.with_file_name(&new);
            if dst.exists() && !dst.to_string_lossy().eq_ignore_ascii_case(&path.to_string_lossy()) {
                self.soft(format!("Unable to rename {}: {} already exists", path.display(), dst.display()))?;
                continue;
            }
            match fs::rename(&path, &dst) {
                Ok(()) => {
                    count += 1;
                    self.log.verbose(&format!("Renamed {} to {new}", path.display()));
                    let parent = parent_rel(&rel);
                    renamed.insert((left, rel.clone()), if parent.is_empty() { new } else { format!("{parent}/{new}") });
                }
                Err(e) => self.soft(format!("Unable to rename {}: {e}", path.display()))?,
            }
        }
        for s in self.selection.iter_mut() {
            if let Some(n) = renamed.get(s) {
                s.1 = n.clone();
            }
        }
        self.done("renamed", count, skipped, start);
        self.refresh()
    }

    fn cmd_sync(&mut self, args: &[String]) -> R {
        let (mut visible, mut create_empty) = (false, false);
        let mut mode = None;
        for a in args {
            let l = a.to_ascii_lowercase();
            match l.as_str() {
                "visible" => visible = true,
                "create-empty" => create_empty = true,
                _ => {
                    let (kind, dir) = l.split_once(':').ok_or_else(|| syntax(format!("Invalid argument \"{a}\"")))?;
                    let target = match (kind, dir) {
                        (_, "all") => "both",
                        (_, d) => match direction(d) {
                            Some(true) => "right",
                            Some(false) => "left",
                            None => return Err(syntax(format!("Invalid argument \"{a}\""))),
                        },
                    };
                    mode = Some(match (kind, target) {
                        ("update", t) => format!("update-{t}"),
                        ("mirror", "both") => return Err(syntax("mirror requires a direction")),
                        ("mirror", t) => format!("mirror-{t}"),
                        _ => return Err(syntax(format!("Invalid argument \"{a}\""))),
                    });
                }
            }
        }
        let mode = mode.ok_or_else(|| syntax("sync requires update: or mirror:"))?;
        let (l, r, root) = self.folders()?;
        let shown = |rel: &str| {
            let mut p = parent_rel(rel);
            while !p.is_empty() {
                if !self.expanded.contains(p) {
                    return false;
                }
                p = parent_rel(p);
            }
            true
        };
        let actions: Vec<folder::Action> = folder::plan_sync(&root, &l, &r, &mode)
            .into_iter()
            .filter(|a| !visible || shown(&a.rel))
            .filter(|a| create_empty || a.op != "copy" || !a.dir || a.from.as_deref().is_some_and(|f| count_files(Path::new(f)) > 0))
            .collect();
        let start = Instant::now();
        let mut count = 0;
        for a in actions {
            let to = PathBuf::from(&a.to);
            if a.op == "copy" {
                let Some(from) = a.from.as_deref().map(PathBuf::from) else { continue };
                if to.exists() && self.confirm == Confirm::NoToAll {
                    continue;
                }
                let n = count_files(&from);
                let res = to.parent().map(fs::create_dir_all).unwrap_or(Ok(())).and_then(|_| folder::copy_recursive(&from, &to));
                match res {
                    Ok(()) => {
                        count += n.max(1);
                        self.log.verbose(&format!("Copied {} to {}", from.display(), to.parent().unwrap_or(Path::new("")).display()));
                    }
                    Err(e) => self.soft(format!("Unable to copy {}: {e}", from.display()))?,
                }
            } else if a.op == "delete" {
                if self.confirm == Confirm::NoToAll {
                    continue;
                }
                let n = count_items(&to);
                match remove_path(&to, false) {
                    Ok(()) => {
                        count += n;
                        self.log.verbose(&format!("Deleted {}", to.display()));
                    }
                    Err(e) => self.soft(format!("Unable to delete {}: {e}", to.display()))?,
                }
            }
        }
        self.done("synchronized", count, 0, start);
        self.refresh()
    }

    fn cmd_snapshot(&mut self, args: &[String]) -> R {
        let (mut crc, mut no_filters, mut empty) = (false, false, false);
        let mut sides = None;
        let mut out = None;
        for a in args {
            match a.to_ascii_lowercase().as_str() {
                "save-crc" => crc = true,
                "save" | "save-version" => {}
                "no-filters" => no_filters = true,
                "include-empty" | "create-empty" => empty = true,
                l => {
                    if let Some(s) = Sides::parse(l).filter(|s| *s != Sides::All) {
                        sides = Some(s);
                    } else if let Some(v) = strip_ci(a, "output:") {
                        out = Some(v.to_string());
                    } else {
                        return Err(syntax(format!("Invalid argument \"{a}\"")));
                    }
                }
            }
        }
        let left = sides.ok_or_else(|| syntax("snapshot requires left or right"))? == Sides::Left;
        let dir = match &self.loaded {
            Loaded::Folders { left: l, right: r, .. } => if left { l.clone() } else { r.clone() },
            _ => return Err(Fail::Error("No folder comparison is loaded".into())),
        };
        let mut path = match out {
            Some(o) => PathBuf::from(self.abs(&o)),
            None => {
                let name = Path::new(&dir).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "snapshot".into());
                self.cwd.join(format!("{name}_{}", Local::now().format("%Y-%m-%d")))
            }
        };
        if path.extension().is_none() {
            path.set_extension(snapshot::EXTENSION.trim_start_matches('.'));
        }
        let opts = self.opts.clone();
        snapshot::save_snapshot(&dir, &path.to_string_lossy(), crc, empty, (!no_filters).then_some(&opts))
            .map(|_| ())
            .map_err(|e| Fail::Error(format!("Unable to save snapshot {}: {e}", path.display())))
    }
}

fn count_files(p: &Path) -> usize {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => fs::read_dir(p).map(|rd| rd.flatten().map(|e| count_files(&e.path())).sum()).unwrap_or(0),
        Ok(_) => 1,
        Err(_) => 0,
    }
}

/// Files and folders at and below a path.
fn count_items(p: &Path) -> usize {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => 1 + fs::read_dir(p).map(|rd| rd.flatten().map(|e| count_items(&e.path())).sum()).unwrap_or(0),
        Ok(_) => 1,
        Err(_) => 0,
    }
}

fn remove_path(p: &Path, recycle: bool) -> std::io::Result<()> {
    if recycle {
        return trash::delete(p).map_err(|e| std::io::Error::other(e.to_string()));
    }
    if fs::symlink_metadata(p)?.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_quotes_inside_tokens() {
        assert_eq!(tokenize(r#"load "a b" c"#), ["load", "a b", "c"]);
        assert_eq!(tokenize(r#"x output-to:"My Report.txt" "-sub\""#), ["x", "output-to:My Report.txt", r"-sub\"]);
        assert_eq!(tokenize(r#"a """#), ["a", ""]);
        assert!(tokenize("   ").is_empty());
    }

    #[test]
    fn expands_parameters_and_variables() {
        let p = vec!["one".to_string(), "two".to_string()];
        let var = |n: &str| (n == "HOME").then(|| "/h".to_string());
        assert_eq!(expand_vars("load %1 %2 %3", &p, &var), "load one two ");
        assert_eq!(expand_vars("%HOME%/x %NOPE% 50%", &p, &var), "/h/x %NOPE% 50%");
        assert_eq!(expand_vars("100%% %1", &p, &var), "100% one");
        assert_eq!(builtin_var("date").unwrap().len(), 10);
        assert_eq!(builtin_var("fn_time").unwrap().len(), 8);
    }

    #[test]
    fn dos_rename_masks() {
        assert_eq!(dos_rename("y.md", "*.bak"), "y.bak");
        assert_eq!(dos_rename("a.tar.gz", "*.bak"), "a.tar.bak");
        assert_eq!(dos_rename("report.txt", "???_old.*"), "rep_old.txt");
        assert_eq!(dos_rename("name", "*.txt"), "name.txt");
        assert_eq!(dos_rename("abc.txt", "*"), "abc.txt");
    }

    #[test]
    fn regex_group_references() {
        assert_eq!(regex_replacement("$1.md"), "${1}.md");
        assert_eq!(regex_replacement(r"\2-\1"), "${2}-${1}");
        assert_eq!(regex_replacement("a$b"), "a$$b");
    }

    #[test]
    fn lenient_timestamps() {
        let ms = |s| parse_timestamp(s).map(|t| Local.timestamp_millis_opt(t).unwrap().format("%Y-%m-%d %H:%M:%S").to_string());
        assert_eq!(ms("10/01/2024 12:00:00 PM").unwrap(), "2024-10-01 12:00:00");
        assert_eq!(ms("12/31/2012 12:00pm").unwrap(), "2012-12-31 12:00:00");
        assert_eq!(ms("2020-01-02 03:04:05").unwrap(), "2020-01-02 03:04:05");
        assert_eq!(ms("Dec 31, 2012").unwrap(), "2012-12-31 00:00:00");
        assert_eq!(ms("01/01/2024").unwrap(), "2024-01-01 00:00:00");
        assert!(ms("not a date").is_none());
    }

    #[test]
    fn selection_masks() {
        let m = parse_mask("left.orphan.files").unwrap();
        assert_eq!((m.sides, m.result, m.files, m.folders), (Sides::Left, Res::Orphan, true, false));
        let m = parse_mask("lt.newer.files").unwrap();
        assert_eq!((m.sides, m.result), (Sides::Left, Res::Newer));
        let m = parse_mask("left.files").unwrap();
        assert_eq!((m.sides, m.result, m.folders), (Sides::Left, Res::All, false));
        let m = parse_mask("diff.folders").unwrap();
        assert_eq!((m.sides, m.result, m.files), (Sides::All, Res::Diff, false));
        assert!(parse_mask("empty.folders").unwrap().empty_folders);
        assert!(parse_mask("all").is_some());
        assert!(parse_mask("bogus").is_none());
        assert!(parse_mask("files.left").is_none());
    }

    #[test]
    fn sizes_and_directions() {
        assert_eq!(parse_size("1KB"), Some(1024));
        assert_eq!(parse_size("2mb"), Some(2 << 20));
        assert_eq!(parse_size("100"), Some(100));
        assert_eq!(direction("left->right"), Some(true));
        assert_eq!(direction("rt->lt"), Some(false));
        assert_eq!(direction("left->left"), None);
    }
}
