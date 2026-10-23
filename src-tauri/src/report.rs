//! Plain text, XML and HTML reports of file and folder comparisons (used by scripts).

use crate::diff::{self, Kind, Row};
use crate::folder::{Content, FolderOptions, Node, OtherFilter, Status};
use serde::Deserialize;
use std::cell::RefCell;
use crate::{fileio, hex, pix, quick, table};
use chrono::{Local, TimeZone};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[path = "report_html.rs"]
mod html;

/// Lines of context around differences in the "with context" display mode.
const CONTEXT: usize = 6;
/// Lines of context in unified and context patches.
const PATCH_CONTEXT: usize = 3;

pub fn fmt_time(ms: i64) -> String {
    Local.timestamp_millis_opt(ms).earliest().map(|t| t.format("%m/%d/%Y %I:%M:%S %p").to_string()).unwrap_or_default()
}

pub fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

fn patch_time(ms: Option<i64>) -> String {
    ms.and_then(|ms| Local.timestamp_millis_opt(ms).earliest())
        .map(|t| t.format("%Y-%m-%d %H:%M:%S%.9f").to_string())
        .unwrap_or_default()
}

/// Arguments shared by all report commands.
#[derive(Debug, Clone, Default)]
pub struct ReportSpec {
    pub layout: String,
    pub options: Vec<String>,
    pub title: Option<String>,
    pub output_to: String,
    pub output_options: Vec<String>,
    /// Style sheet URL of `html-custom`.
    pub css: Option<String>,
}

/// A finished report and the files it references, relative to the report's folder.
#[derive(Debug, Clone, Default)]
pub struct Output {
    pub content: String,
    pub files: Vec<(String, Vec<u8>)>,
}

impl ReportSpec {
    pub fn has(&self, o: &str) -> bool {
        self.options.iter().any(|x| x == o)
    }
    pub fn html(&self) -> bool {
        self.output_options.iter().any(|o| o.starts_with("html-"))
    }
    fn iu(&self) -> bool {
        self.has("ignore-unimportant")
    }
    fn summary(&self) -> bool {
        self.layout == "summary"
    }
    fn display(&self) -> Display {
        let mut d = Display::All;
        for o in &self.options {
            d = match o.as_str() {
                "display-all" => Display::All,
                "display-mismatches" => Display::Mismatches,
                "display-context" => Display::Context,
                "display-matches" => Display::Matches,
                "display-none" => Display::None,
                _ => d,
            };
        }
        d
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Display {
    All,
    Mismatches,
    Context,
    Matches,
    None,
}

fn mode_name(d: Display, iu: bool) -> String {
    let base = match d {
        Display::All => "All",
        Display::Mismatches => "Differences",
        Display::Context => "Differences, With Context",
        Display::Matches => "Same",
        Display::None => "None",
    };
    if iu { format!("{base}, Ignoring Unimportant") } else { base.to_string() }
}

/// Title, production time and display mode lines of a file comparison report.
fn file_header(spec: &ReportSpec, default_title: &str) -> Vec<String> {
    let mut out = vec![spec.title.clone().unwrap_or_else(|| default_title.to_string()), format!("Produced: {}", fmt_time(now_ms())), String::new()];
    // Picture reports state no display mode.
    if !spec.summary() && default_title != self::default_title("picture") {
        out.push(format!("Mode:  {}", mode_name(spec.display(), spec.iu())));
    } else if spec.iu() {
        out.push("Ignoring Unimportant".into());
    }
    out
}

fn files_line(l: &str, r: &str) -> String {
    if l == r {
        return format!("File: {l}");
    }
    format!("Left file: {l}     Right file: {r}")
}

fn digits(n: usize) -> usize {
    n.max(1).to_string().len()
}

fn chars(s: &str) -> usize {
    s.chars().count()
}

fn xml_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            c => o.push(c),
        }
    }
    o
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

// ---------------------------------------------------------------------------
// Sections

/// A run of rows that are all the same or all different, possibly split for context display.
#[derive(Debug, Clone, Copy)]
struct Piece {
    diff: bool,
    start: usize,
    end: usize,
    shown: bool,
}

fn pieces(diff: &[bool], d: Display) -> Vec<Piece> {
    let mut runs = vec![];
    let mut i = 0;
    while i < diff.len() {
        let (k, s) = (diff[i], i);
        while i < diff.len() && diff[i] == k {
            i += 1;
        }
        runs.push((k, s, i));
    }
    let any_diff = runs.iter().any(|r| r.0);
    let mut out = vec![];
    let mut push = |diff: bool, start: usize, end: usize, shown: bool| {
        if start < end {
            out.push(Piece { diff, start, end, shown });
        }
    };
    for (idx, &(k, s, e)) in runs.iter().enumerate() {
        match d {
            Display::All => push(k, s, e, true),
            Display::Mismatches => push(k, s, e, k),
            Display::Matches => push(k, s, e, !k),
            Display::None => push(k, s, e, false),
            Display::Context => {
                if k {
                    push(k, s, e, true);
                    continue;
                }
                let (before, after) = (idx > 0, idx + 1 < runs.len());
                let len = e - s;
                if !any_diff {
                    push(k, s, e, false);
                } else if before && after {
                    if len <= 2 * CONTEXT {
                        push(k, s, e, true);
                    } else {
                        push(k, s, s + CONTEXT, true);
                        push(k, s + CONTEXT, e - CONTEXT, false);
                        push(k, e - CONTEXT, e, true);
                    }
                } else if before {
                    push(k, s, (s + CONTEXT).min(e), true);
                    push(k, (s + CONTEXT).min(e), e, false);
                } else {
                    push(k, s, e.saturating_sub(CONTEXT).max(s), false);
                    push(k, e.saturating_sub(CONTEXT).max(s), e, true);
                }
            }
        }
    }
    out
}

/// Emits the rendered pieces from the first shown to the last shown one, each followed by a dash line.
fn emit(ps: &[Piece], rendered: &[Option<Vec<String>>], dash: usize) -> Vec<String> {
    let mut out = vec![];
    let (Some(first), Some(last)) = (ps.iter().position(|p| p.shown), ps.iter().rposition(|p| p.shown)) else {
        return out;
    };
    for r in &rendered[first..=last] {
        if let Some(lines) = r {
            out.extend(lines.iter().map(|l| l.trim_end().to_string()));
        }
        out.push("-".repeat(dash));
    }
    out
}

fn shown_rows(ps: &[Piece]) -> impl Iterator<Item = usize> + '_ {
    ps.iter().filter(|p| p.shown).flat_map(|p| p.start..p.end)
}

fn sbs_line(l: &str, lw: usize, m: &str, mw: usize, r: &str) -> String {
    format!("{l:<lw$} {m:<mw$} {r}")
}

// ---------------------------------------------------------------------------
// Text

/// In-memory state of an open viewer, used instead of the files on disk when reporting from it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ViewState {
    pub left: Option<Vec<String>>,
    pub right: Option<Vec<String>>,
    pub rules: Option<diff::Rules>,
    pub table: Option<table::TableOptions>,
}

thread_local! {
    static VIEW: RefCell<Option<ViewState>> = const { RefCell::new(None) };
}

/// Runs `f` with pair reports reflecting the given viewer state.
pub fn with_view<T>(v: ViewState, f: impl FnOnce() -> T) -> T {
    VIEW.with(|c| *c.borrow_mut() = Some(v));
    let out = f();
    VIEW.with(|c| *c.borrow_mut() = None);
    out
}

fn view<T>(f: impl FnOnce(&ViewState) -> Option<T>) -> Option<T> {
    VIEW.with(|c| c.borrow().as_ref().and_then(f))
}

struct TextCmp {
    left: fileio::TextFile,
    right: fileio::TextFile,
    rows: Vec<Row>,
}

fn load_text_cmp(l: &str, r: &str) -> Result<TextCmp, String> {
    let load = |p: &str, lines: Option<Vec<String>>| -> Result<fileio::TextFile, String> {
        match lines {
            None => fileio::load_text(p).map_err(|e| format!("{p}: {e}")),
            Some(lines) => {
                let mut f = fileio::load_text(p).unwrap_or_else(|_| fileio::TextFile {
                    path: p.into(),
                    lines: vec![],
                    encoding: "utf-8".into(),
                    bom: false,
                    eol: "\n".into(),
                    final_newline: true,
                    size: 0,
                    modified: None,
                    binary: false,
                    read_only: false,
                });
                f.lines = lines;
                Ok(f)
            }
        }
    };
    let left = load(l, view(|v| v.left.clone()))?;
    let right = load(r, view(|v| v.right.clone()))?;
    let rules = view(|v| v.rules.clone()).unwrap_or_default();
    let rows = diff::diff_lines(&left.lines, &right.lines, &rules).rows;
    Ok(TextCmp { left, right, rows })
}

fn text_row_diff(k: Kind, iu: bool) -> bool {
    match k {
        Kind::Same => false,
        Kind::Unimportant => !iu,
        _ => true,
    }
}

fn row_side_marker(rows: &[Row]) -> &'static str {
    if rows.iter().all(|r| r.r.is_none()) {
        "+-"
    } else if rows.iter().all(|r| r.l.is_none()) {
        "-+"
    } else {
        "<>"
    }
}

fn text_sbs(t: &TextCmp, spec: &ReportSpec) -> Vec<String> {
    let iu = spec.iu();
    let ln = spec.has("line-numbers");
    let diffs: Vec<bool> = t.rows.iter().map(|r| text_row_diff(r.k, iu)).collect();
    let ps = pieces(&diffs, spec.display());
    let wl = digits(shown_rows(&ps).filter_map(|i| t.rows[i].l).max().map_or(0, |n| n as usize + 1));
    let wr = digits(shown_rows(&ps).filter_map(|i| t.rows[i].r).max().map_or(0, |n| n as usize + 1));
    let cell = |side: Option<u32>, lines: &[String], w: usize| match side {
        Some(i) if ln => format!("{:>w$} {}", i + 1, lines[i as usize]),
        Some(i) => lines[i as usize].clone(),
        None => String::new(),
    };
    let marker = |p: &Piece| if p.diff { row_side_marker(&t.rows[p.start..p.end]) } else { "=" };
    let lw = shown_rows(&ps).map(|i| chars(&cell(t.rows[i].l, &t.left.lines, wl))).max().unwrap_or(0);
    let rw = shown_rows(&ps).map(|i| chars(&cell(t.rows[i].r, &t.right.lines, wr))).max().unwrap_or(0);
    let mw = ps.iter().filter(|p| p.shown).map(|p| marker(p).len()).max().unwrap_or(0);
    let rendered: Vec<Option<Vec<String>>> = ps
        .iter()
        .map(|p| {
            p.shown.then(|| {
                (p.start..p.end)
                    .map(|i| {
                        let row = &t.rows[i];
                        let m = if i == p.start { marker(p) } else { "" };
                        sbs_line(&cell(row.l, &t.left.lines, wl), lw, m, mw, &cell(row.r, &t.right.lines, wr))
                    })
                    .collect()
            })
        })
        .collect();
    emit(&ps, &rendered, lw + 1 + mw + 1 + rw)
}

fn text_interleaved(t: &TextCmp, spec: &ReportSpec) -> Vec<String> {
    let iu = spec.iu();
    let diffs: Vec<bool> = t.rows.iter().map(|r| text_row_diff(r.k, iu)).collect();
    let ps = pieces(&diffs, spec.display());
    let wl = digits(shown_rows(&ps).filter_map(|i| t.rows[i].l).max().map_or(0, |n| n as usize + 1));
    let wr = digits(shown_rows(&ps).filter_map(|i| t.rows[i].r).max().map_or(0, |n| n as usize + 1));
    let left = |i: u32| format!("{:>wl$} {:>wr$} {}", i + 1, "", t.left.lines[i as usize]);
    let right = |i: u32| format!("{:>wl$} {:>wr$} {}", "", i + 1, t.right.lines[i as usize]);
    let rendered: Vec<Option<Vec<String>>> = ps
        .iter()
        .map(|p| {
            p.shown.then(|| {
                let rows = &t.rows[p.start..p.end];
                if p.diff {
                    rows.iter().filter_map(|r| r.l.map(left)).chain(rows.iter().filter_map(|r| r.r.map(right))).collect()
                } else {
                    rows.iter()
                        .map(|r| match (r.l, r.r) {
                            (Some(a), Some(b)) => format!("{:>wl$} {:>wr$} {}", a + 1, b + 1, t.left.lines[a as usize]),
                            (Some(a), None) => left(a),
                            (None, Some(b)) => right(b),
                            (None, None) => String::new(),
                        })
                        .collect()
                }
            })
        })
        .collect();
    let dash = rendered.iter().flatten().flatten().map(|l| chars(l)).max().unwrap_or(0);
    emit(&ps, &rendered, dash)
}

fn text_summary(t: &TextCmp, spec: &ReportSpec) -> Vec<String> {
    let iu = spec.iu();
    let count = |k: Kind| t.rows.iter().filter(|r| r.k == k).count();
    let mut out = vec![];
    let mut add = |n: usize, what: &str| {
        if n > 0 {
            out.push(format!("{n} {what}"));
        }
    };
    add(count(Kind::Same), "same line(s)");
    add(count(Kind::Unimportant), if iu { "ignored unimportant difference line(s)" } else { "unimportant difference line(s)" });
    add(count(Kind::Left), "important left orphan line(s)");
    add(count(Kind::Right), "important right orphan line(s)");
    add(count(Kind::Changed), "important difference line(s)");
    let diffs: Vec<bool> = t.rows.iter().map(|r| text_row_diff(r.k, iu)).collect();
    let sections = pieces(&diffs, Display::All).iter().filter(|p| p.diff).count();
    if sections > 0 {
        out.push(String::new());
        out.push(format!("{sections} difference section(s)"));
    }
    out
}

fn text_statistics(t: &TextCmp, l: &str, r: &str, spec: &ReportSpec) -> Vec<String> {
    let n = |f: &dyn Fn(&Row) -> bool| t.rows.iter().filter(|r| f(r)).count();
    let unimp = |l: bool, r: bool| n(&|x: &Row| x.k == Kind::Unimportant && x.l.is_some() == l && x.r.is_some() == r);
    vec![
        spec.title.clone().unwrap_or_else(|| "Text Compare".into()),
        format!("Produced: {}", fmt_time(now_ms())),
        "SourceFile,CompareFile,IOriginal,IAdded,IDeleted,IChanged,UOriginal,UAdded,UDeleted,UChanged,SourceError,CompareError,Error".into(),
        format!(
            "{l},{r},{},{},{},{},0,{},{},{}",
            t.left.lines.len(),
            n(&|x| x.k == Kind::Right),
            n(&|x| x.k == Kind::Left),
            n(&|x| x.k == Kind::Changed),
            unimp(false, true),
            unimp(true, false),
            unimp(true, true),
        ),
    ]
}

/// Runs of changed rows as (start, end) row indices.
fn change_runs(t: &TextCmp, iu: bool) -> Vec<(usize, usize)> {
    let mut runs = vec![];
    let mut i = 0;
    while i < t.rows.len() {
        if text_row_diff(t.rows[i].k, iu) {
            let s = i;
            while i < t.rows.len() && text_row_diff(t.rows[i].k, iu) {
                i += 1;
            }
            runs.push((s, i));
        } else {
            i += 1;
        }
    }
    runs
}

/// Number of left (or right) lines in rows before `i`.
fn lines_before(t: &TextCmp, i: usize, left: bool) -> usize {
    t.rows[..i].iter().filter(|r| if left { r.l.is_some() } else { r.r.is_some() }).count()
}

fn side_lines(t: &TextCmp, s: usize, e: usize, left: bool) -> Vec<u32> {
    t.rows[s..e].iter().filter_map(|r| if left { r.l } else { r.r }).collect()
}

fn normal_range(a: usize, b: usize) -> String {
    if a == b { a.to_string() } else { format!("{a},{b}") }
}

fn patch_normal(t: &TextCmp, l: &str, r: &str, iu: bool) -> Vec<String> {
    let mut out = vec![format!("diff -r {l} {r}")];
    for (s, e) in change_runs(t, iu) {
        let (ll, rl) = (side_lines(t, s, e, true), side_lines(t, s, e, false));
        let (lb, rb) = (lines_before(t, s, true), lines_before(t, s, false));
        let lr = || normal_range(lb + 1, lb + ll.len());
        let rr = || normal_range(rb + 1, rb + rl.len());
        out.push(if ll.is_empty() {
            format!("{lb}a{}", rr())
        } else if rl.is_empty() {
            format!("{}d{rb}", lr())
        } else {
            format!("{}c{}", lr(), rr())
        });
        out.extend(ll.iter().map(|&i| format!("< {}", t.left.lines[i as usize])));
        if !ll.is_empty() && !rl.is_empty() {
            out.push("---".into());
        }
        out.extend(rl.iter().map(|&i| format!("> {}", t.right.lines[i as usize])));
    }
    out
}

/// Hunks for unified/context patches: (row start, row end, change runs inside).
fn patch_hunks(t: &TextCmp, iu: bool) -> Vec<(usize, usize, Vec<(usize, usize)>)> {
    let mut hunks: Vec<(usize, usize, Vec<(usize, usize)>)> = vec![];
    for (s, e) in change_runs(t, iu) {
        if let Some(h) = hunks.last_mut() {
            let last_end = h.2.last().map_or(0, |r| r.1);
            if s - last_end <= 2 * PATCH_CONTEXT {
                h.1 = (e + PATCH_CONTEXT).min(t.rows.len());
                h.2.push((s, e));
                continue;
            }
        }
        hunks.push((s.saturating_sub(PATCH_CONTEXT), (e + PATCH_CONTEXT).min(t.rows.len()), vec![(s, e)]));
    }
    hunks
}

fn hunk_range(t: &TextCmp, s: usize, e: usize, left: bool, unified: bool) -> String {
    let before = lines_before(t, s, left);
    let n = side_lines(t, s, e, left).len();
    match (n, unified) {
        (0, true) => format!("{before},0"),
        (0, false) => before.to_string(),
        (1, true) => (before + 1).to_string(),
        (1, false) => (before + 1).to_string(),
        (n, true) => format!("{},{n}", before + 1),
        (n, false) => format!("{},{}", before + 1, before + n),
    }
}

fn patch_unified(t: &TextCmp, l: &str, r: &str, iu: bool) -> Vec<String> {
    let hunks = patch_hunks(t, iu);
    if hunks.is_empty() {
        return vec![];
    }
    let mut out = vec![format!("--- {l}\t{} ", patch_time(t.left.modified)), format!("+++ {r}\t{} ", patch_time(t.right.modified))];
    for (hs, he, runs) in hunks {
        out.push(format!("@@ -{} +{} @@", hunk_range(t, hs, he, true, true), hunk_range(t, hs, he, false, true)));
        let mut i = hs;
        for (s, e) in runs.iter().copied().chain(std::iter::once((he, he))) {
            for row in &t.rows[i..s] {
                if let Some(a) = row.l {
                    out.push(format!(" {}", t.left.lines[a as usize]));
                }
            }
            out.extend(side_lines(t, s, e, true).iter().map(|&a| format!("-{}", t.left.lines[a as usize])));
            out.extend(side_lines(t, s, e, false).iter().map(|&b| format!("+{}", t.right.lines[b as usize])));
            i = e;
        }
    }
    out
}

fn patch_context(t: &TextCmp, l: &str, r: &str, iu: bool) -> Vec<String> {
    let hunks = patch_hunks(t, iu);
    if hunks.is_empty() {
        return vec![];
    }
    let mut out = vec![format!("*** {l}\t{} ", patch_time(t.left.modified)), format!("--- {r}\t{} ", patch_time(t.right.modified))];
    for (hs, he, runs) in hunks {
        out.push("***************".into());
        for left in [true, false] {
            let range = hunk_range(t, hs, he, left, false);
            out.push(if left { format!("*** {range} ****") } else { format!("--- {range} ----") });
            if !runs.iter().any(|&(s, e)| !side_lines(t, s, e, left).is_empty()) {
                continue;
            }
            for i in hs..he {
                let row = &t.rows[i];
                let Some(n) = (if left { row.l } else { row.r }) else { continue };
                let text = if left { &t.left.lines[n as usize] } else { &t.right.lines[n as usize] };
                let prefix = match runs.iter().find(|&&(s, e)| i >= s && i < e) {
                    None => "  ",
                    Some(&(s, e)) if !side_lines(t, s, e, true).is_empty() && !side_lines(t, s, e, false).is_empty() => "! ",
                    Some(_) if left => "- ",
                    Some(_) => "+ ",
                };
                out.push(format!("{prefix}{text}"));
            }
        }
    }
    out
}

fn text_xml(t: &TextCmp, l: &str, r: &str) -> Vec<String> {
    let created = fmt_time(now_ms());
    let mut out = vec![
        r#"<?xml version="1.0" encoding="UTF-8"?>"#.to_string(),
        format!(r#"<bcreport created="{created}">"#),
        "\t<ltpath/>".into(),
        "\t<rtpath/>".into(),
        format!(r#"	<filecomparison created="{created}">"#),
        format!("\t\t<filename1>{}</filename1>", xml_escape(l)),
        format!("\t\t<filename2>{}</filename2>", xml_escape(r)),
    ];
    for row in &t.rows {
        let status = match (row.k, row.l.is_some(), row.r.is_some()) {
            (Kind::Same, ..) => "same",
            (Kind::Changed, ..) => "different",
            (Kind::Left, ..) => "leftorphan",
            (Kind::Right, ..) => "rightorphan",
            (Kind::Unimportant, true, true) => "similar",
            (Kind::Unimportant, true, false) => "leftsimilar",
            (Kind::Unimportant, ..) => "rightsimilar",
        };
        out.push(format!(r#"		<linecomp status="{status}">"#));
        match (row.k, row.l, row.r) {
            (Kind::Same, Some(a), Some(b)) => {
                out.push(format!(r#"			<text ltid="{}" rtid="{}">{}</text>"#, a + 1, b + 1, xml_escape(&t.left.lines[a as usize])))
            }
            (_, a, b) => {
                if let Some(a) = a {
                    out.push(format!(r#"			<text ltid="{}">{}</text>"#, a + 1, xml_escape(&t.left.lines[a as usize])));
                }
                if let Some(b) = b {
                    out.push(format!(r#"			<text rtid="{}">{}</text>"#, b + 1, xml_escape(&t.right.lines[b as usize])));
                }
            }
        }
        out.push("\t\t</linecomp>".into());
    }
    out.push("\t</filecomparison>".into());
    out.push("</bcreport>".into());
    out
}

fn text_body(t: &TextCmp, spec: &ReportSpec) -> Vec<String> {
    match spec.layout.as_str() {
        "summary" => text_summary(t, spec),
        "interleaved" | "over-under" | "composite" => text_interleaved(t, spec),
        _ => text_sbs(t, spec),
    }
}

// ---------------------------------------------------------------------------
// Hex

/// One aligned byte position: the left and right bytes (None for an orphan gap) and whether they differ.
#[derive(Clone, Copy)]
struct HexPos {
    l: Option<u8>,
    r: Option<u8>,
    diff: bool,
}

struct HexRow {
    cols: Vec<HexPos>,
    lo: u64,
    ro: u64,
    diff: bool,
}

impl HexRow {
    fn has(&self, left: bool) -> bool {
        self.cols.iter().any(|c| if left { c.l.is_some() } else { c.r.is_some() })
    }
}

struct HexCmp {
    pos: Vec<HexPos>,
    /// File offsets of the next left/right byte at each position (plus one past the end).
    lo_at: Vec<u64>,
    ro_at: Vec<u64>,
    counts: [u64; 4],
}

/// Bytes of difference context kept on each side of a difference in mismatch displays.
const HEX_CONTEXT: usize = 16;

fn load_hex_cmp(l: &str, r: &str) -> Result<HexCmp, String> {
    let a = fs::read(l).map_err(|e| format!("{l}: {e}"))?;
    let b = fs::read(r).map_err(|e| format!("{r}: {e}"))?;
    let al = hex::hex_align(l, r, hex::HexAlign::Complete).map_err(|e| e.to_string())?;
    let (mut ia, mut ib) = (0usize, 0usize);
    let (mut pos, mut lo_at, mut ro_at) = (vec![], vec![], vec![]);
    for &(k, n) in &al.map {
        for _ in 0..n {
            lo_at.push(ia as u64);
            ro_at.push(ib as u64);
            let mut p = HexPos { l: None, r: None, diff: k != hex::SAME };
            if k != hex::RIGHT_ONLY {
                p.l = Some(a.get(ia).copied().unwrap_or(0));
                ia += 1;
            }
            if k != hex::LEFT_ONLY {
                p.r = Some(b.get(ib).copied().unwrap_or(0));
                ib += 1;
            }
            pos.push(p);
        }
    }
    lo_at.push(ia as u64);
    ro_at.push(ib as u64);
    Ok(HexCmp { pos, lo_at, ro_at, counts: al.counts })
}

/// Rows of eight positions laid out from the start of each displayed region, with their pieces.
/// Mismatch displays keep 16 positions of context around differences; match displays show each
/// run of identical bytes; regions are separated by hidden pieces.
fn hex_layout(h: &HexCmp, d: Display) -> (Vec<HexRow>, Vec<Piece>) {
    let n = h.pos.len();
    let mut regions: Vec<(usize, usize)> = vec![];
    match d {
        Display::All => regions.push((0, n)),
        Display::None => {}
        Display::Matches => {
            let mut i = 0;
            while i < n {
                if h.pos[i].diff {
                    i += 1;
                    continue;
                }
                let s = i;
                while i < n && !h.pos[i].diff {
                    i += 1;
                }
                regions.push((s, i));
            }
        }
        Display::Mismatches | Display::Context => {
            for (i, p) in h.pos.iter().enumerate() {
                if !p.diff {
                    continue;
                }
                let (s, e) = (i.saturating_sub(HEX_CONTEXT), (i + HEX_CONTEXT + 1).min(n));
                match regions.last_mut() {
                    Some(last) if s <= last.1 => last.1 = last.1.max(e),
                    _ => regions.push((s, e)),
                }
            }
        }
    }
    let (mut rows, mut ps) = (vec![], vec![]);
    for (ri, &(s, e)) in regions.iter().enumerate() {
        if ri > 0 {
            ps.push(Piece { diff: false, start: rows.len(), end: rows.len(), shown: false });
        }
        let first = rows.len();
        let mut i = s;
        while i < e {
            let j = (i + 8).min(e);
            let cols = h.pos[i..j].to_vec();
            rows.push(HexRow { diff: cols.iter().any(|c| c.diff), cols, lo: h.lo_at[i], ro: h.ro_at[i] });
            i = j;
        }
        let mut k = first;
        while k < rows.len() {
            let (dk, st) = (rows[k].diff, k);
            while k < rows.len() && rows[k].diff == dk {
                k += 1;
            }
            ps.push(Piece { diff: dk, start: st, end: k, shown: true });
        }
    }
    (rows, ps)
}

fn hex_cell(r: &HexRow, left: bool) -> String {
    if !r.has(left) {
        return String::new();
    }
    let side = |c: &HexPos| if left { c.l } else { c.r };
    let hex: Vec<String> = r.cols.iter().map(|c| side(c).map(|b| format!("{b:02X}")).unwrap_or_else(|| "  ".into())).collect();
    let ascii: String = r.cols.iter().map(|c| side(c).map(|b| if (0x20..0x7f).contains(&b) { b as char } else { '.' }).unwrap_or(' ')).collect();
    format!("{:<23}  {:<8}", hex.join(" "), ascii)
}

fn hex_marker(rows: &[HexRow], p: &Piece) -> &'static str {
    if !p.diff {
        "="
    } else if rows[p.start..p.end].iter().all(|r| !r.has(true)) {
        "-+"
    } else if rows[p.start..p.end].iter().all(|r| !r.has(false)) {
        "+-"
    } else {
        "<>"
    }
}

fn hex_sbs(h: &HexCmp, spec: &ReportSpec) -> Vec<String> {
    let ln = spec.has("line-numbers");
    let (rows, ps) = hex_layout(h, spec.display());
    let cell = |r: &HexRow, left: bool| {
        let c = hex_cell(r, left);
        if c.is_empty() {
            c
        } else if ln {
            format!("{:08X} {c}", if left { r.lo } else { r.ro })
        } else {
            c
        }
    };
    let lw = shown_rows(&ps).map(|i| chars(&cell(&rows[i], true))).max().unwrap_or(0);
    let rw = shown_rows(&ps).map(|i| chars(&cell(&rows[i], false))).max().unwrap_or(0);
    let mw = ps.iter().filter(|p| p.shown).map(|p| hex_marker(&rows, p).len()).max().unwrap_or(0);
    let rendered: Vec<Option<Vec<String>>> = ps
        .iter()
        .map(|p| {
            p.shown.then(|| {
                (p.start..p.end)
                    .map(|i| sbs_line(&cell(&rows[i], true), lw, if i == p.start { hex_marker(&rows, p) } else { "" }, mw, &cell(&rows[i], false)))
                    .collect()
            })
        })
        .collect();
    emit(&ps, &rendered, lw + 1 + mw + 1 + rw)
}

fn hex_interleaved(h: &HexCmp, spec: &ReportSpec) -> Vec<String> {
    let (rows, ps) = hex_layout(h, spec.display());
    let rendered: Vec<Option<Vec<String>>> = ps
        .iter()
        .map(|p| {
            p.shown.then(|| {
                let rs = &rows[p.start..p.end];
                if p.diff {
                    let left = rs.iter().filter(|r| r.has(true)).map(|r| format!("{:08X}{:10}{}", r.lo, "", hex_cell(r, true)));
                    let right = rs.iter().filter(|r| r.has(false)).map(|r| format!("{:9}{:08X} {}", "", r.ro, hex_cell(r, false)));
                    left.chain(right).collect()
                } else {
                    rs.iter().map(|r| format!("{:08X} {:08X} {}", r.lo, r.ro, hex_cell(r, true))).collect()
                }
            })
        })
        .collect();
    let dash = rendered.iter().flatten().flatten().map(|l| chars(l)).max().unwrap_or(0);
    emit(&ps, &rendered, dash)
}

fn hex_summary(h: &HexCmp) -> Vec<String> {
    let names = ["same byte(s)", "left orphan byte(s)", "right orphan byte(s)", "difference byte(s)"];
    let order = [hex::SAME, hex::LEFT_ONLY, hex::RIGHT_ONLY, hex::DIFF];
    order.iter().zip(names).filter(|(&k, _)| h.counts[k as usize] > 0).map(|(&k, n)| format!("{} {n}", h.counts[k as usize])).collect()
}

fn hex_body(h: &HexCmp, spec: &ReportSpec) -> Vec<String> {
    match spec.layout.as_str() {
        "summary" => hex_summary(h),
        "interleaved" => hex_interleaved(h, spec),
        _ => hex_sbs(h, spec),
    }
}

// ---------------------------------------------------------------------------
// Table

fn load_table_cmp(l: &str, r: &str) -> Result<table::TableResult, String> {
    let opts = view(|v| v.table.clone()).unwrap_or(table::TableOptions { header: false, keys: vec![], ..Default::default() });
    table::compare_tables(l, r, &opts).map_err(|e| e.to_string())
}

fn col_letter(mut i: usize) -> String {
    let mut s = vec![];
    loop {
        s.push((b'A' + (i % 26) as u8) as char);
        if i < 26 {
            break;
        }
        i = i / 26 - 1;
    }
    s.iter().rev().collect()
}

fn is_num(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t.parse::<f64>().is_ok()
}

fn table_row_diff(k: &str, iu: bool) -> bool {
    match k {
        "same" => false,
        "unimportant" => !iu,
        _ => true,
    }
}

fn table_marker(k: &str, iu: bool) -> &'static str {
    match k {
        "same" => "=",
        "left" => "+-",
        "right" => "-+",
        "unimportant" if iu => "=",
        _ => "<>",
    }
}

/// Shown row indices; the first table row is always shown.
fn table_shown(ps: &[Piece], n: usize) -> Vec<usize> {
    let mut v: Vec<usize> = shown_rows(ps).collect();
    if n > 0 && v.first() != Some(&0) {
        v.insert(0, 0);
    }
    v
}

fn cell_at(rows: &[Vec<String>], i: Option<u32>, c: usize) -> Option<&str> {
    i.and_then(|i| rows.get(i as usize)).map(|r| r.get(c).map(String::as_str).unwrap_or(""))
}

fn table_sbs(t: &table::TableResult, spec: &ReportSpec) -> Vec<String> {
    let iu = spec.iu();
    let ln = spec.has("line-numbers");
    let diffs: Vec<bool> = t.rows.iter().map(|r| table_row_diff(&r.k, iu)).collect();
    let ps = pieces(&diffs, spec.display());
    let shown = table_shown(&ps, t.rows.len());
    let n = t.columns;
    let widths = |cells: &[Vec<String>], left: bool| -> Vec<usize> {
        (0..n)
            .map(|c| {
                let vals = shown.iter().filter_map(|&i| cell_at(cells, if left { t.rows[i].l } else { t.rows[i].r }, c));
                vals.map(chars).chain(std::iter::once(chars(&col_letter(c)))).max().unwrap_or(0)
            })
            .collect()
    };
    let (wl, wr) = (widths(&t.left, true), widths(&t.right, false));
    let nl = digits(shown.iter().filter_map(|&i| t.rows[i].l).max().map_or(0, |n| n as usize + 1));
    let nr = digits(shown.iter().filter_map(|&i| t.rows[i].r).max().map_or(0, |n| n as usize + 1));
    let side = |cells: &[Vec<String>], i: Option<u32>, w: &[usize], nw: usize| -> String {
        let Some(row) = i else { return String::new() };
        let mut parts: Vec<String> = (0..n)
            .map(|c| {
                let v = cell_at(cells, Some(row), c).unwrap_or("");
                if is_num(v) { format!("{v:>w$}", w = w[c]) } else { format!("{v:<w$}", w = w[c]) }
            })
            .collect();
        if ln {
            parts.insert(0, format!("{:>nw$}", row + 1));
        }
        parts.join(" ")
    };
    let header = |w: &[usize], nw: usize| {
        let mut parts: Vec<String> = (0..n).map(|c| format!("{:<w$}", col_letter(c), w = w[c])).collect();
        if ln {
            parts.insert(0, " ".repeat(nw));
        }
        parts.join(" ")
    };
    let (hl, hr) = (header(&wl, nl), header(&wr, nr));
    let (lw, rw) = (chars(&hl), chars(&hr));
    let mw = shown.iter().map(|&i| table_marker(&t.rows[i].k, iu).len()).max().unwrap_or(0);
    let dash = "-".repeat(lw + 1 + mw + 1 + rw);
    let mut out = vec![sbs_line(&hl, lw, "", mw, &hr).trim_end().to_string(), dash.clone()];
    for &i in &shown {
        let r = &t.rows[i];
        out.push(sbs_line(&side(&t.left, r.l, &wl, nl), lw, table_marker(&r.k, iu), mw, &side(&t.right, r.r, &wr, nr)).trim_end().to_string());
    }
    if !shown.is_empty() {
        out.push(dash);
    }
    out
}

fn table_interleaved(t: &table::TableResult, spec: &ReportSpec) -> Vec<String> {
    let iu = spec.iu();
    let diffs: Vec<bool> = t.rows.iter().map(|r| table_row_diff(&r.k, iu)).collect();
    let ps = pieces(&diffs, spec.display());
    let shown = table_shown(&ps, t.rows.len());
    let n = t.columns;
    let w: Vec<usize> = (0..n)
        .map(|c| {
            let l = shown.iter().filter_map(|&i| cell_at(&t.left, t.rows[i].l, c));
            let r = shown.iter().filter_map(|&i| cell_at(&t.right, t.rows[i].r, c));
            l.chain(r).map(chars).chain(std::iter::once(chars(&col_letter(c)))).max().unwrap_or(0)
        })
        .collect();
    let nl = digits(shown.iter().filter_map(|&i| t.rows[i].l).max().map_or(0, |n| n as usize + 1));
    let nr = digits(shown.iter().filter_map(|&i| t.rows[i].r).max().map_or(0, |n| n as usize + 1));
    let cells = |rows: &[Vec<String>], i: u32| (0..n).map(|c| format!("{:<w$}", cell_at(rows, Some(i), c).unwrap_or(""), w = w[c])).collect::<Vec<_>>().join(" ");
    let total = w.iter().sum::<usize>() + n.saturating_sub(1);
    let dash = "-".repeat(nl + 1 + nr + 1 + total);
    let letters = (0..n).map(|c| format!("{:<w$}", col_letter(c), w = w[c])).collect::<Vec<_>>().join(" ");
    let mut out = vec![format!("{}{letters}", " ".repeat(nl + 1 + nr + 1)).trim_end().to_string(), dash.clone()];
    let line = |l: Option<u32>, r: Option<u32>, text: String| {
        format!("{:>nl$} {:>nr$} {text}", l.map(|x| (x + 1).to_string()).unwrap_or_default(), r.map(|x| (x + 1).to_string()).unwrap_or_default())
            .trim_end()
            .to_string()
    };
    for &i in &shown {
        let r = &t.rows[i];
        match (r.l, r.r) {
            (Some(a), Some(b)) if !table_row_diff(&r.k, iu) => out.push(line(Some(a), Some(b), cells(&t.left, a))),
            (a, b) => {
                if let Some(a) = a {
                    out.push(line(Some(a), None, cells(&t.left, a)));
                }
                if let Some(b) = b {
                    out.push(line(None, Some(b), cells(&t.right, b)));
                }
            }
        }
        out.push(dash.clone());
    }
    out
}

fn table_summary(t: &table::TableResult, spec: &ReportSpec) -> Vec<String> {
    let count = |k: &str| t.rows.iter().filter(|r| r.k == k).count();
    let mut out = vec![];
    let mut add = |n: usize, what: &str| {
        if n > 0 {
            out.push(format!("{n} {what}"));
        }
    };
    add(count("same"), "same row(s)");
    add(count("unimportant"), if spec.iu() { "ignored unimportant difference row(s)" } else { "unimportant difference row(s)" });
    add(count("left"), "important left orphan row(s)");
    add(count("right"), "important right orphan row(s)");
    add(count("changed"), "important difference row(s)");
    out
}

fn table_body(t: &table::TableResult, spec: &ReportSpec) -> Vec<String> {
    match spec.layout.as_str() {
        "summary" => table_summary(t, spec),
        "interleaved" => table_interleaved(t, spec),
        _ => table_sbs(t, spec),
    }
}

// ---------------------------------------------------------------------------
// Picture

struct PixCmp {
    counts: pix::PixCounts,
}

fn empty_picture() -> pix::Picture {
    pix::Picture { width: 0, height: 0, rgba: vec![], format: String::new(), has_alpha: false }
}

fn pix_body(p: &PixCmp, spec: &ReportSpec) -> Vec<String> {
    let mut out = vec![];
    if !spec.summary() {
        return out;
    }
    let c = &p.counts;
    for (n, what) in [
        (c.same, "same pixel(s)"),
        (c.unimportant, if spec.iu() { "ignored unimportant difference pixel(s)" } else { "unimportant difference pixel(s)" }),
        (c.left_orphan, "left orphan pixel(s)"),
        (c.right_orphan, "right orphan pixel(s)"),
        (c.important, "important difference pixel(s)"),
    ] {
        if n > 0 {
            out.push(format!("{n} {what}"));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Single-file-pair reports

/// The file viewer used for a report: "text" | "hex" | "table" | "picture".
pub fn report_kind(cmd: &str) -> Option<&'static str> {
    Some(match cmd {
        "text-report" => "text",
        "hex-report" => "hex",
        "data-report" | "table-report" => "table",
        "picture-report" => "picture",
        _ => return None,
    })
}

fn default_title(kind: &str) -> &'static str {
    match kind {
        "hex" => "Hex Compare",
        "table" => "Table Compare",
        "picture" => "Picture Compare",
        _ => "Text Compare",
    }
}

/// Report body for one pair of files (missing sides are compared with empty content).
fn body(kind: &str, l: &str, r: &str, spec: &ReportSpec) -> Result<Vec<String>, String> {
    Ok(match kind {
        "hex" => hex_body(&load_hex_cmp(l, r)?, spec),
        "table" => table_body(&load_table_cmp(l, r)?, spec),
        "picture" => {
            let load = |p: &str| if fs::metadata(p).map(|m| m.len() == 0).unwrap_or(true) { Ok(empty_picture()) } else { pix::load_picture(p) };
            let (a, b) = (load(l)?, load(r)?);
            let o = pix::PixOptions { ignore_unimportant: spec.iu(), ..Default::default() };
            let counts = pix::pix_stats(&a, &b, &o);
            pix_body(&PixCmp { counts }, spec)
        }
        _ => text_body(&load_text_cmp(l, r)?, spec),
    })
}

/// Lines of the text-only layouts (patch, statistics, xml).
fn text_report_lines(l: &str, r: &str, spec: &ReportSpec) -> Result<Vec<String>, String> {
    let t = load_text_cmp(l, r)?;
    let iu = spec.iu();
    Ok(match spec.layout.as_str() {
        "patch" if spec.has("patch-unified") => patch_unified(&t, l, r, iu),
        "patch" if spec.has("patch-context") => patch_context(&t, l, r, iu),
        "patch" => patch_normal(&t, l, r, iu),
        "statistics" => text_statistics(&t, l, r, spec),
        _ => text_xml(&t, l, r),
    })
}

fn plain_output(spec: &ReportSpec, lines: Vec<String>) -> Output {
    Output { content: finish(spec, lines), files: vec![] }
}

/// A complete report comparing two files with the given viewer.
pub fn pair_report(kind: &str, l: &str, r: &str, spec: &ReportSpec) -> Result<Output, String> {
    let text_only = kind == "text" && matches!(spec.layout.as_str(), "patch" | "statistics" | "xml");
    if spec.html() && spec.layout != "xml" {
        return html::pair(kind, l, r, files_line(l, r), spec);
    }
    if text_only {
        return Ok(plain_output(spec, text_report_lines(l, r, spec)?));
    }
    let mut out = file_header(spec, default_title(kind));
    out.push(files_line(l, r));
    out.extend(body(kind, l, r, spec)?);
    Ok(plain_output(spec, out))
}

/// A selected file of a folder comparison.
pub struct FileItem {
    pub rel: String,
    pub left: Option<PathBuf>,
    pub right: Option<PathBuf>,
}

/// Path of an empty file standing in for a missing side.
pub fn empty_file() -> PathBuf {
    let p = std::env::temp_dir().join(format!("comparecraft-empty-{}", std::process::id()));
    if !p.exists() {
        let _ = fs::write(&p, b"");
    }
    p
}

/// Reports every selected file, using `forced` or each file's associated viewer.
pub fn file_report(spec: &ReportSpec, files: &[FileItem], left_base: &str, right_base: &str, forced: Option<&str>) -> Result<Output, String> {
    let empty = empty_file();
    let path_of = |p: &Option<PathBuf>| p.clone().unwrap_or_else(|| empty.clone()).to_string_lossy().into_owned();
    let kind_of = |f: &FileItem| -> String {
        if let Some(k) = forced {
            return k.to_string();
        }
        let p = f.left.as_ref().or(f.right.as_ref()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        match fileio::detect_kind(&p).as_str() {
            k @ ("hex" | "table" | "picture") => k.to_string(),
            _ => "text".into(),
        }
    };
    if spec.html() {
        let items: Vec<(String, String, String, String)> = files.iter().map(|f| (kind_of(f), f.rel.clone(), path_of(&f.left), path_of(&f.right))).collect();
        return html::file_report(spec, &items, left_base, right_base);
    }
    let title = files.first().map(|f| default_title(&kind_of(f))).unwrap_or_else(|| default_title(forced.unwrap_or("text")));
    let mut out = file_header(spec, title);
    out.push(format!("Left base folder: {left_base}"));
    out.push(format!("Right base folder: {right_base}"));
    for f in files {
        out.push(String::new());
        out.push(format!("File: {}", f.rel));
        out.extend(body(&kind_of(f), &path_of(&f.left), &path_of(&f.right), spec)?);
    }
    Ok(plain_output(spec, out))
}

// ---------------------------------------------------------------------------
// Folder reports

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FClass {
    Same,
    LOrphan,
    ROrphan,
    LNewer,
    RNewer,
    Diff,
}

pub fn file_class(n: &Node, timesize: bool) -> FClass {
    match n.status {
        Status::Same => FClass::Same,
        Status::Left => FClass::LOrphan,
        Status::Right => FClass::ROrphan,
        Status::Diff if timesize && n.newer.as_deref() == Some("left") => FClass::LNewer,
        Status::Diff if timesize && n.newer.as_deref() == Some("right") => FClass::RNewer,
        _ => FClass::Diff,
    }
}

/// Classes accepted by a folder report display filter, with the mode name.
fn folder_display(spec: &ReportSpec) -> (&'static [FClass], &'static str) {
    use FClass::*;
    let mut d: (&'static [FClass], &'static str) = (&[Same, LOrphan, ROrphan, LNewer, RNewer, Diff], "All");
    for o in &spec.options {
        d = match o.as_str() {
            "display-all" => (&[Same, LOrphan, ROrphan, LNewer, RNewer, Diff], "All"),
            "display-mismatches" => (&[LOrphan, ROrphan, LNewer, RNewer, Diff], "Differences"),
            "display-no-orphans" => (&[Same, LNewer, RNewer, Diff], "No Orphans"),
            "display-mismatches-no-orphans" => (&[LNewer, RNewer, Diff], "Differences but No Orphans"),
            "display-orphans" => (&[LOrphan, ROrphan], "Orphans"),
            "display-left-newer" => (&[LNewer], "Left Newer"),
            "display-right-newer" => (&[RNewer], "Right Newer"),
            "display-left-newer-orphans" => (&[LNewer, LOrphan], "Left Newer and Left Orphans"),
            "display-right-newer-orphans" => (&[RNewer, ROrphan], "Right Newer and Right Orphans"),
            "display-left-orphans" => (&[LOrphan], "Left Orphans"),
            "display-right-orphans" => (&[ROrphan], "Right Orphans"),
            "display-matches" => (&[Same], "Same"),
            "display-none" => (&[], "None"),
            _ => d,
        };
    }
    d
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Col {
    Size,
    Crc,
    Modified,
    Attributes,
}

fn folder_columns(spec: &ReportSpec) -> Vec<Col> {
    let cols: Vec<&str> = spec.options.iter().filter_map(|o| o.strip_prefix("column-")).collect();
    if cols.is_empty() {
        return vec![Col::Size, Col::Modified];
    }
    let mut out = vec![];
    for (name, c) in [("size", Col::Size), ("crc", Col::Crc), ("timestamp", Col::Modified), ("attributes", Col::Attributes)] {
        if cols.contains(&name) {
            out.push(c);
        }
    }
    out
}

fn col_label(c: Col) -> &'static str {
    match c {
        Col::Size => "Size",
        Col::Crc => "CRC",
        Col::Modified => "Modified",
        Col::Attributes => "Attributes",
    }
}

fn describe_filter(f: &OtherFilter) -> Option<String> {
    match f.kind.as_str() {
        "date" => {
            let rel = if f.newer { "newer" } else { "older" };
            if let Some(d) = f.days {
                Some(format!("Files {rel} than {d} day(s) ago are excluded."))
            } else {
                f.date.map(|ms| format!("Files {rel} than {} are excluded.", fmt_time(ms)))
            }
        }
        "size" => Some(format!("Files {} than {} bytes are excluded.", if f.larger { "larger" } else { "smaller" }, f.size)),
        _ => None,
    }
}

/// Report lines describing the name and other filters of a folder comparison.
pub fn folder_filter_lines(opts: &FolderOptions) -> Vec<String> {
    let mut out = vec![];
    let inc = opts.include.trim();
    if !inc.is_empty() && inc != "*" {
        out.push(format!("Filters:  {inc}"));
    }
    let d: Vec<String> = opts.other_filters.iter().filter(|f| f.enabled).filter_map(describe_filter).collect();
    if !d.is_empty() {
        out.push(format!("Filters:  {}", d.join("  ")));
    }
    out
}

/// The loaded folder comparison and its presentation state.
pub struct FolderCtx<'a> {
    pub root: &'a Node,
    pub left_base: &'a str,
    pub right_base: &'a str,
    pub timesize: bool,
    pub expanded: &'a dyn Fn(&str) -> bool,
    /// Lines describing the active filters, placed after the mode line.
    pub filters: Vec<String>,
}

/// A visible row of the folder report tree.
struct Vis<'a> {
    node: &'a Node,
    lpath: Option<PathBuf>,
    rpath: Option<PathBuf>,
    class: Option<FClass>,
    children: Vec<Vis<'a>>,
}

/// An orphan folder is itself an orphan item, shown even when empty.
fn orphan_dir(n: &Node, accept: &[FClass]) -> bool {
    match n.status {
        Status::Left => accept.contains(&FClass::LOrphan),
        Status::Right => accept.contains(&FClass::ROrphan),
        _ => false,
    }
}

fn has_accepted(n: &Node, accept: &[FClass], timesize: bool) -> bool {
    n.children.iter().any(|c| if c.dir { orphan_dir(c, accept) || has_accepted(c, accept, timesize) } else { accept.contains(&file_class(c, timesize)) })
}

fn visible<'a>(n: &'a Node, lp: Option<&Path>, rp: Option<&Path>, cx: &FolderCtx, accept: &[FClass], all: bool) -> Vec<Vis<'a>> {
    let mut out = vec![];
    for c in &n.children {
        let lpath = c.left.as_ref().and_then(|s| lp.map(|p| p.join(&s.name)));
        let rpath = c.right.as_ref().and_then(|s| rp.map(|p| p.join(&s.name)));
        if c.dir {
            if !all && !orphan_dir(c, accept) && !has_accepted(c, accept, cx.timesize) {
                continue;
            }
            let children = if (cx.expanded)(&c.rel) { visible(c, lpath.as_deref(), rpath.as_deref(), cx, accept, all) } else { vec![] };
            out.push(Vis { node: c, lpath, rpath, class: None, children });
        } else {
            let class = file_class(c, cx.timesize);
            if accept.contains(&class) {
                out.push(Vis { node: c, lpath, rpath, class: Some(class), children: vec![] });
            }
        }
    }
    out
}

fn flatten<'v, 'a>(items: &'v [Vis<'a>], depth: usize, out: &mut Vec<(&'v Vis<'a>, usize)>) {
    for v in items {
        out.push((v, depth));
        flatten(&v.children, depth + 1, out);
    }
}

/// Tree connector drawn before a nested folder report name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Conn {
    /// An ancestor with later siblings.
    I,
    /// An item with later siblings.
    T,
    /// The last item of its folder.
    L,
    None,
}

impl Conn {
    fn ch(self) -> char {
        match self {
            Conn::I => '|',
            Conn::T => '+',
            Conn::L => '\\',
            Conn::None => ' ',
        }
    }
}

/// Per-side connectors of every flattened row; each side links only the items present on it.
fn connectors(items: &[Vis], depth: usize, anc: [&[bool]; 2], out: &mut Vec<[Vec<Conn>; 2]>) {
    for (i, v) in items.iter().enumerate() {
        let mut row: [Vec<Conn>; 2] = [vec![], vec![]];
        let mut next: [Vec<bool>; 2] = [vec![], vec![]];
        for (s, left) in [(0, true), (1, false)] {
            let present = |n: &Node| if left { n.left.is_some() } else { n.right.is_some() };
            next[s] = anc[s].to_vec();
            if depth >= 2 {
                let later = items[i + 1..].iter().any(|x| present(x.node));
                // A missing item still shows the line running on to its later siblings.
                let own = match (present(v.node), later) {
                    (true, true) => Conn::T,
                    (true, false) => Conn::L,
                    (false, true) => Conn::I,
                    (false, false) => Conn::None,
                };
                row[s] = anc[s].iter().map(|&c| if c { Conn::I } else { Conn::None }).chain(std::iter::once(own)).collect();
                next[s].push(later);
            }
        }
        out.push(row);
        connectors(&v.children, depth + 1, [&next[0], &next[1]], out);
    }
}

fn side_tree_files(n: &Node, left: bool) -> (u64, usize) {
    let mut size = 0;
    let mut count = 0;
    for c in &n.children {
        if c.dir {
            let (s, k) = side_tree_files(c, left);
            size += s;
            count += k;
        } else if let Some(s) = if left { &c.left } else { &c.right } {
            size += s.size;
            count += 1;
        }
    }
    (size, count)
}

#[cfg(unix)]
fn attributes(p: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    let Ok(m) = fs::symlink_metadata(p) else { return String::new() };
    let mode = m.permissions().mode();
    let kind = if m.file_type().is_symlink() {
        'l'
    } else if m.is_dir() {
        'd'
    } else {
        '-'
    };
    let mut s = String::from(kind);
    for shift in [6, 3, 0] {
        let bits = (mode >> shift) & 7;
        s.push(if bits & 4 != 0 { 'r' } else { '-' });
        s.push(if bits & 2 != 0 { 'w' } else { '-' });
        s.push(if bits & 1 != 0 { 'x' } else { '-' });
    }
    s
}

#[cfg(not(unix))]
fn attributes(p: &Path) -> String {
    let Ok(m) = fs::symlink_metadata(p) else { return String::new() };
    let mut s = String::new();
    if m.is_dir() {
        s.push('d');
    }
    s.push(if m.permissions().readonly() { 'r' } else { '-' });
    s
}

/// Column values of one side of an item.
fn side_values(n: &Node, path: Option<&Path>, left: bool, cols: &[Col]) -> Option<Vec<String>> {
    let side = if left { n.left.as_ref() } else { n.right.as_ref() }?;
    Some(
        cols.iter()
            .map(|c| match c {
                Col::Size => thousands(if n.dir { side_tree_files(n, left).0 } else { side.size }),
                Col::Crc => {
                    if n.dir {
                        if side_tree_files(n, left).1 > 0 { String::new() } else { "00000000".into() }
                    } else {
                        path.and_then(|p| quick::crc32_file(p).ok()).map(|c| format!("{c:08X}")).unwrap_or_default()
                    }
                }
                Col::Modified => side.modified.map(fmt_time).unwrap_or_default(),
                Col::Attributes => path.map(attributes).unwrap_or_default(),
            })
            .collect(),
    )
}

/// A byte count with comma thousands separators.
pub fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

fn pad_col(v: &str, c: Col, w: usize) -> String {
    if c == Col::Size { format!("{v:>w$}") } else { format!("{v:<w$}") }
}

fn folder_header(spec: &ReportSpec, cx: &FolderCtx, mode: &str) -> Vec<String> {
    let mut out = vec![
        spec.title.clone().unwrap_or_else(|| "Folder Compare".into()),
        format!("Produced: {}", fmt_time(now_ms())),
        String::new(),
        format!("Mode:  {mode}"),
    ];
    out.extend(cx.filters.iter().cloned());
    out.push(format!("Left base folder: {}", cx.left_base));
    out.push(format!("Right base folder: {}", cx.right_base));
    out
}

fn class_marker(c: Option<FClass>) -> &'static str {
    match c {
        None => "",
        Some(FClass::Same) => "=",
        Some(FClass::Diff) => "<>",
        Some(FClass::LNewer | FClass::LOrphan) => ">>",
        Some(FClass::RNewer | FClass::ROrphan) => "<<",
    }
}

fn folder_sbs(spec: &ReportSpec, cx: &FolderCtx) -> Vec<String> {
    let (accept, mode) = folder_display(spec);
    let all = mode == "All";
    let cols = folder_columns(spec);
    let tree = visible(cx.root, Some(Path::new(cx.left_base)), Some(Path::new(cx.right_base)), cx, accept, all);
    let mut flat = vec![];
    flatten(&tree, 1, &mut flat);
    let mut conns = vec![];
    connectors(&tree, 1, [&[], &[]], &mut conns);
    let prefix = |i: usize, left: bool| -> String { conns[i][if left { 0 } else { 1 }].iter().map(|c| c.ch()).collect() };
    // Cells per side: name followed by the column values.
    let cells = |left: bool| -> Vec<Option<Vec<String>>> {
        flat.iter()
            .enumerate()
            .map(|(i, (v, _))| {
                let side = if left { v.node.left.as_ref() } else { v.node.right.as_ref() }?;
                let path = if left { v.lpath.as_deref() } else { v.rpath.as_deref() };
                let mut c = vec![format!("{}{}", prefix(i, left), side.name)];
                c.extend(side_values(v.node, path, left, &cols)?);
                Some(c)
            })
            .collect()
    };
    let (lc, rc) = (cells(true), cells(false));
    let labels: Vec<&str> = std::iter::once("Name").chain(cols.iter().map(|&c| col_label(c))).collect();
    let widths = |cs: &[Option<Vec<String>>]| -> Vec<usize> {
        (0..labels.len()).map(|i| cs.iter().flatten().map(|c| chars(&c[i])).chain(std::iter::once(labels[i].len())).max().unwrap_or(0)).collect()
    };
    let (wl, wr) = (widths(&lc), widths(&rc));
    let join = |c: &[String], w: &[usize]| -> String {
        c.iter().enumerate().map(|(i, v)| if i == 0 { format!("{v:<w$}", w = w[0]) } else { pad_col(v, cols[i - 1], w[i]) }).collect::<Vec<_>>().join(" ")
    };
    // Column labels are all left-aligned.
    let head = |w: &[usize]| -> String { labels.iter().zip(w).map(|(l, &w)| format!("{l:<w$}")).collect::<Vec<_>>().join(" ") };
    let (hl, hr) = (head(&wl), head(&wr));
    let (lw, rw) = (chars(&hl), chars(&hr));
    let mw = flat.iter().map(|(v, _)| class_marker(v.class).len()).max().unwrap_or(0);
    let dash = "-".repeat(lw + 1 + mw + 1 + rw);
    let mut out = folder_header(spec, cx, mode);
    out.push(sbs_line(&hl, lw, "", mw, &hr).trim_end().to_string());
    out.push(dash.clone());
    for (i, (v, _)) in flat.iter().enumerate() {
        let l = lc[i].as_ref().map(|c| join(c, &wl)).unwrap_or_else(|| prefix(i, true));
        let r = rc[i].as_ref().map(|c| join(c, &wr)).unwrap_or_else(|| prefix(i, false));
        out.push(sbs_line(&l, lw, class_marker(v.class), mw, &r).trim_end().to_string());
    }
    if !flat.is_empty() {
        out.push(dash);
    }
    out
}

/// A folder summary entry: relative path, first values and optional second-side values.
type SumEntry = (String, Vec<String>, Option<Vec<String>>);

fn summary_groups(spec: &ReportSpec, cx: &FolderCtx) -> (&'static str, Vec<(String, Vec<SumEntry>)>) {
    use FClass::*;
    let (accept, mode) = folder_display(spec);
    let cols = folder_columns(spec);
    let everything = [Same, LOrphan, ROrphan, LNewer, RNewer, Diff];
    let tree = visible(cx.root, Some(Path::new(cx.left_base)), Some(Path::new(cx.right_base)), cx, &everything, false);
    let mut flat = vec![];
    flatten(&tree, 1, &mut flat);
    let groups = [
        (Same, "Same Files"),
        (LOrphan, "Left Orphan Files"),
        (ROrphan, "Right Orphan Files"),
        (LNewer, "Left Newer Files"),
        (RNewer, "Right Newer Files"),
        (Diff, "Difference Files"),
    ];
    let mut shown: Vec<(String, Vec<SumEntry>)> = vec![];
    for (class, name) in groups {
        if !accept.contains(&class) {
            continue;
        }
        let entries: Vec<SumEntry> = flat
            .iter()
            .filter(|(v, _)| v.class == Some(class))
            .map(|(v, _)| {
                let l = side_values(v.node, v.lpath.as_deref(), true, &cols);
                let r = side_values(v.node, v.rpath.as_deref(), false, &cols);
                let (first, second) = match class {
                    ROrphan => (r.unwrap_or_default(), None),
                    Same | LOrphan => (l.unwrap_or_default(), None),
                    _ => (l.unwrap_or_default(), r),
                };
                (v.node.rel.clone(), first, second)
            })
            .collect();
        shown.push((format!("{name} ({})", entries.len()), entries));
    }
    (mode, shown)
}

fn folder_summary(spec: &ReportSpec, cx: &FolderCtx) -> Vec<String> {
    let cols = folder_columns(spec);
    let (mode, shown) = summary_groups(spec, cx);
    let nw = shown.iter().flat_map(|(t, es)| std::iter::once(chars(t)).chain(es.iter().map(|e| chars(&e.0)))).max().unwrap_or(0);
    let cw: Vec<usize> = cols
        .iter()
        .enumerate()
        .map(|(i, &c)| {
            let vals = shown.iter().flat_map(|(_, es)| es.iter().flat_map(|e| std::iter::once(&e.1).chain(e.2.as_ref())).map(move |v| chars(&v[i])));
            vals.chain(std::iter::once(col_label(c).len())).max().unwrap_or(0)
        })
        .collect();
    let row = |name: &str, vals: &[String], head: bool| -> String {
        let mut s = format!("{name:<nw$}");
        for (i, v) in vals.iter().enumerate() {
            s.push(' ');
            s.push_str(&if head { format!("{v:<w$}", w = cw[i]) } else { pad_col(v, cols[i], cw[i]) });
        }
        s.trim_end().to_string()
    };
    let labels: Vec<String> = cols.iter().map(|&c| col_label(c).to_string()).collect();
    let dash = "-".repeat(nw + cw.iter().map(|w| w + 1).sum::<usize>());
    let mut out = folder_header(spec, cx, mode);
    for (title, entries) in &shown {
        out.push(String::new());
        out.push(row(title, &labels, true));
        out.push(dash.clone());
        for e in entries {
            out.push(row(&e.0, &e.1, false));
            if let Some(s) = &e.2 {
                if !cols.is_empty() {
                    out.push(row("", s, false));
                }
            }
        }
        if !entries.is_empty() {
            out.push(dash.clone());
        }
    }
    out
}

fn folder_xml(spec: &ReportSpec, cx: &FolderCtx) -> Vec<String> {
    let (accept, mode) = folder_display(spec);
    let tree = visible(cx.root, Some(Path::new(cx.left_base)), Some(Path::new(cx.right_base)), cx, accept, mode == "All");
    let mut out = vec![
        r#"<?xml version="1.0" encoding="UTF-8"?>"#.to_string(),
        format!(r#"<bcreport created="{}">"#, fmt_time(now_ms())),
        "\t<foldercomp>".into(),
        format!("\t\t<ltpath>{}</ltpath>", xml_escape(cx.left_base)),
        format!("\t\t<rtpath>{}</rtpath>", xml_escape(cx.right_base)),
    ];
    fn side(out: &mut Vec<String>, tag: &str, n: &Node, left: bool, ind: &str) {
        let Some(s) = (if left { &n.left } else { &n.right }) else { return };
        let size = if n.dir { side_tree_files(n, left).0 } else { s.size };
        out.push(format!("{ind}<{tag}>"));
        out.push(format!("{ind}\t<name>{}</name>", xml_escape(&s.name)));
        out.push(format!("{ind}\t<size>{}</size>", thousands(size)));
        out.push(format!("{ind}\t<modified>{}</modified>", s.modified.map(fmt_time).unwrap_or_default()));
        out.push(format!("{ind}</{tag}>"));
    }
    fn walk(out: &mut Vec<String>, items: &[Vis], depth: usize) {
        let ind = "\t".repeat(depth);
        let inner = "\t".repeat(depth + 1);
        for v in items {
            if v.node.dir {
                out.push(format!("{ind}<foldercomp>"));
                side(out, "lt", v.node, true, &inner);
                side(out, "rt", v.node, false, &inner);
                walk(out, &v.children, depth + 1);
                out.push(format!("{ind}</foldercomp>"));
            } else {
                let status = match v.class {
                    Some(FClass::Same) => "same",
                    Some(FClass::LNewer) => "ltnewer",
                    Some(FClass::RNewer) => "rtnewer",
                    Some(FClass::LOrphan) => "ltonly",
                    Some(FClass::ROrphan) => "rtonly",
                    _ => "diff",
                };
                out.push(format!(r#"{ind}<filecomp status="{status}">"#));
                side(out, "lt", v.node, true, &inner);
                side(out, "rt", v.node, false, &inner);
                out.push(format!("{ind}</filecomp>"));
            }
        }
    }
    walk(&mut out, &tree, 2);
    out.push("\t</foldercomp>".into());
    out.push("</bcreport>".into());
    out
}

pub fn folder_report(spec: &ReportSpec, cx: &FolderCtx) -> Result<Output, String> {
    if spec.html() && spec.layout != "xml" {
        return Ok(if spec.summary() {
            let (mode, groups) = summary_groups(spec, cx);
            html::folder_summary(spec, cx, groups, mode)
        } else {
            html::folder_sbs(spec, cx)
        });
    }
    let lines = match spec.layout.as_str() {
        "summary" => folder_summary(spec, cx),
        "xml" => folder_xml(spec, cx),
        _ => folder_sbs(spec, cx),
    };
    Ok(plain_output(spec, lines))
}

// ---------------------------------------------------------------------------
// Output

fn finish(_spec: &ReportSpec, lines: Vec<String>) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut s = lines.join("\n");
    s.push('\n');
    s
}

fn pipe_to(cmds: &[(&str, &[&str])], content: &str) -> Result<(), String> {
    for (cmd, args) in cmds {
        let Ok(mut child) = Command::new(cmd).args(*args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else {
            continue;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(content.as_bytes());
        }
        if child.wait().map(|s| s.success()).unwrap_or(false) {
            return Ok(());
        }
    }
    Err(format!("none of {} is available", cmds.iter().map(|c| c.0).collect::<Vec<_>>().join(", ")))
}

/// Sends a finished report to a file, the clipboard or the printer.
pub fn deliver(spec: &ReportSpec, out: &Output, cwd: &Path) -> Result<(), String> {
    let content = out.content.as_str();
    match spec.output_to.to_ascii_lowercase().as_str() {
        "clipboard" => {
            let cmds: &[(&str, &[&str])] = if cfg!(windows) {
                &[("clip", &[])]
            } else if cfg!(target_os = "macos") {
                &[("pbcopy", &[])]
            } else {
                &[("wl-copy", &[]), ("xclip", &["-selection", "clipboard"]), ("xsel", &["-ib"])]
            };
            pipe_to(cmds, content).map_err(|e| format!("Unable to copy the report to the clipboard: {e}"))
        }
        "printer" => {
            let cmds: &[(&str, &[&str])] = if cfg!(windows) { &[("notepad", &["/p"])] } else { &[("lp", &[]), ("lpr", &[])] };
            pipe_to(cmds, content).map_err(|e| format!("Unable to print the report: {e}"))
        }
        "" => Err("Missing output-to".into()),
        _ => {
            let p = cwd.join(&spec.output_to);
            if let Some(parent) = p.parent() {
                let _ = fs::create_dir_all(parent);
            }
            fs::write(&p, content).map_err(|e| format!("Unable to write {}: {e}", p.display()))?;
            let dir = p.parent().unwrap_or(Path::new("."));
            for (rel, data) in &out.files {
                let f = dir.join(rel);
                if let Some(parent) = f.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                fs::write(&f, data).map_err(|e| format!("Unable to write {}: {e}", f.display()))?;
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters() {
        assert_eq!(col_letter(0), "A");
        assert_eq!(col_letter(25), "Z");
        assert_eq!(col_letter(26), "AA");
        assert_eq!(col_letter(27), "AB");
        assert_eq!(col_letter(52), "BA");
    }

    #[test]
    fn context_pieces() {
        let mut d = vec![false; 40];
        d[19] = true;
        let ps = pieces(&d, Display::Context);
        let shown: Vec<(usize, usize)> = ps.iter().filter(|p| p.shown).map(|p| (p.start, p.end)).collect();
        assert_eq!(shown, vec![(13, 19), (19, 20), (20, 26)]);
        assert!(pieces(&[false, false], Display::Context).iter().all(|p| !p.shown));
    }

    #[test]
    fn display_none_hides_everything() {
        assert!(pieces(&[true, false, true], Display::None).iter().all(|p| !p.shown));
    }

    #[test]
    fn filter_lines() {
        let mut o = FolderOptions::default();
        o.include = "*".into();
        assert!(folder_filter_lines(&o).is_empty());
        o.include = "*.rs;*.toml".into();
        assert_eq!(folder_filter_lines(&o), vec!["Filters:  *.rs;*.toml".to_string()]);
    }

    #[test]
    fn view_state_overrides_file_contents() {
        let dir = std::env::temp_dir().join(format!("cc-report-view-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (l, r) = (dir.join("l.txt"), dir.join("r.txt"));
        std::fs::write(&l, "alpha\nbeta\n").unwrap();
        std::fs::write(&r, "alpha\nbeta\n").unwrap();
        let spec = ReportSpec { layout: "side-by-side".into(), options: vec!["display-all".into()], ..ReportSpec::default() };
        let (ls, rs) = (l.to_string_lossy().into_owned(), r.to_string_lossy().into_owned());
        let saved = pair_report("text", &ls, &rs, &spec).unwrap().content;
        assert!(!saved.contains("edited"));
        let view = ViewState { left: Some(vec!["alpha".into(), "edited".into()]), ..ViewState::default() };
        let unsaved = with_view(view, || pair_report("text", &ls, &rs, &spec)).unwrap().content;
        assert!(unsaved.contains("edited"), "{unsaved}");
        // The override applies only inside with_view.
        assert_eq!(pair_report("text", &ls, &rs, &spec).unwrap().content.contains("edited"), false);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
