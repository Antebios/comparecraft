//! HTML rendering of reports: section tables, span highlighting and image attachments.

use super::*;
use std::sync::atomic::{AtomicI64, Ordering};

#[path = "report_css.rs"]
mod css;

/// A table cell: class names (without the wrap class) and HTML content.
pub(super) struct Cell(String, String);

fn cell(class: &str, html: impl Into<String>) -> Cell {
    Cell(class.to_string(), html.into())
}

fn nbsp(class: &str) -> Cell {
    cell(class, "&nbsp;")
}

pub(super) enum Tr {
    Row(&'static str, Vec<Cell>),
    Gap,
}

pub(super) enum Block {
    Lines(Vec<String>),
    Table(&'static str, Vec<Tr>),
    Raw(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Css {
    Text,
    Dir,
    Table,
    Hex,
    Pix,
}

pub(super) struct Doc {
    title: String,
    head: bool,
    stats: bool,
    css: Css,
    mono: bool,
    blocks: Vec<Block>,
    files: Vec<(String, Vec<u8>)>,
}

impl Doc {
    fn new(spec: &ReportSpec, title: &str, css: Css) -> Doc {
        Doc {
            title: spec.title.clone().unwrap_or_else(|| title.to_string()),
            head: true,
            stats: false,
            css,
            mono: spec.output_options.iter().any(|o| o == "html-mono"),
            blocks: vec![],
            files: vec![],
        }
    }
    fn attach(&mut self, name: &str, data: Vec<u8>) {
        if !self.files.iter().any(|(n, _)| n == name) {
            self.files.push((name.to_string(), data));
        }
    }
}

// ---------------------------------------------------------------------------
// Text conversion

fn spaces_mid(n: usize) -> String {
    match n {
        0 => String::new(),
        1 => " ".into(),
        n if n % 2 == 0 => "&nbsp; ".repeat(n / 2),
        n => format!("{}&nbsp;&nbsp; ", "&nbsp; ".repeat((n - 3) / 2)),
    }
}

/// Escaped text with runs of spaces made visible; `start`/`end` tell whether the text begins/ends its cell.
fn conv(text: &str, start: bool, end: bool) -> String {
    let esc = html_escape(text);
    let c: Vec<char> = esc.chars().collect();
    if c.is_empty() {
        return if start && end { "&nbsp;".into() } else { String::new() };
    }
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] != ' ' {
            out.push(c[i]);
            i += 1;
            continue;
        }
        let s = i;
        while i < c.len() && c[i] == ' ' {
            i += 1;
        }
        let (lead, trail, n) = (start && s == 0, end && i == c.len(), i - s);
        out.push_str(&match (lead, trail) {
            (true, true) if n == 1 => "&nbsp;".into(),
            (true, true) => format!("&nbsp;{}&nbsp;", spaces_mid(n - 2)),
            (true, false) => format!("&nbsp;{}", spaces_mid(n - 1)),
            (false, true) => format!("{}&nbsp;", spaces_mid(n - 1)),
            _ => spaces_mid(n),
        });
    }
    out
}

fn expand_tabs<T: Copy>(chars: &[(char, T)]) -> Vec<(char, T)> {
    let mut out = vec![];
    for &(c, t) in chars {
        if c == '\t' {
            let n = 8 - out.len() % 8;
            out.extend(std::iter::repeat_n((' ', t), n));
        } else {
            out.push((c, t));
        }
    }
    out
}

/// Renders classed text: consecutive characters with the same class share one span (None is plain).
fn spans(chars: &[(char, Option<&str>)]) -> String {
    let chars = expand_tabs(chars);
    if chars.is_empty() {
        return "&nbsp;".into();
    }
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let (s, k) = (i, chars[i].1);
        while i < chars.len() && chars[i].1 == k {
            i += 1;
        }
        let text: String = chars[s..i].iter().map(|c| c.0).collect();
        let body = conv(&text, s == 0, i == chars.len());
        match k {
            Some(k) => out.push_str(&format!("<span class=\"{k}\">{body}</span>")),
            None => out.push_str(&body),
        }
    }
    out
}

fn plain(text: &str) -> String {
    let c: Vec<(char, Option<&str>)> = text.chars().map(|c| (c, None)).collect();
    spans(&c)
}

// ---------------------------------------------------------------------------
// Sections

fn section_names(n: usize, split: Option<usize>) -> Vec<&'static str> {
    let mut v: Vec<&'static str> = match n {
        0 => vec![],
        1 => vec!["SectionAll"],
        n => (0..n).map(|i| if i == 0 { "SectionBegin" } else if i + 1 == n { "SectionEnd" } else { "SectionMiddle" }).collect(),
    };
    if let Some(k) = split.filter(|&k| k > 0 && k < n) {
        v[k - 1] = if k == 1 { "SubsectionAll" } else { "SubsectionEnd" };
    }
    v
}

fn push_section(out: &mut Vec<Tr>, rows: Vec<Vec<Cell>>, split: Option<usize>) {
    let names = section_names(rows.len(), split);
    out.extend(names.into_iter().zip(rows).map(|(s, r)| Tr::Row(s, r)));
}

/// Sections for every shown piece, with gaps where hidden pieces lie between them.
fn sectioned(ps: &[Piece], mut f: impl FnMut(&Piece) -> (Vec<Vec<Cell>>, Option<usize>)) -> Vec<Tr> {
    let mut out = vec![];
    let mut gap = false;
    for p in ps {
        if !p.shown {
            gap = true;
            continue;
        }
        if gap && !out.is_empty() {
            out.push(Tr::Gap);
        }
        gap = false;
        let (rows, split) = f(p);
        push_section(&mut out, rows, split);
    }
    out
}

// ---------------------------------------------------------------------------
// Rendering

fn css_block(kind: Css, mono: bool) -> &'static str {
    match (kind, mono) {
        (Css::Text, false) => css::TEXT_COLOR,
        (Css::Text, true) => css::TEXT_MONO,
        (Css::Dir, false) => css::DIR_COLOR,
        (Css::Dir, true) => css::DIR_MONO,
        (Css::Table, false) => css::TABLE_COLOR,
        (Css::Table, true) => css::TABLE_MONO,
        (Css::Hex, false) => css::HEX_COLOR,
        (Css::Hex, true) => css::HEX_MONO,
        (Css::Pix, false) => css::PIX_COLOR,
        (Css::Pix, true) => css::PIX_MONO,
    }
}

fn render(doc: &Doc, spec: &ReportSpec) -> String {
    let wrap = !spec.output_options.iter().any(|o| o == "wrap-word");
    let mut s = String::from("<!DOCTYPE HTML>\n<html>\n<head>\n<meta http-equiv=\"Content-Type\" content=\"text/html; charset=UTF-8\">\n");
    match &spec.css {
        Some(url) => s.push_str(&format!("<link rel=\"stylesheet\" type=\"text/css\" href=\"{url}\">\n")),
        None => {
            s.push_str("<style>\n");
            s.push_str(css::CSS_ALIGN);
            if wrap {
                s.push_str(css::CSS_WRAP);
            }
            s.push_str(css::CSS_COMMON);
            s.push_str(css_block(doc.css, doc.mono));
            s.push_str("</style>\n");
        }
    }
    s.push_str(&format!("<title>{}</title>\n</head>\n<body>\n", doc.title));
    let mut first = true;
    for b in &doc.blocks {
        match b {
            Block::Lines(lines) => {
                for (i, l) in lines.iter().enumerate() {
                    if first && doc.head && i < 2 {
                        s.push_str(l);
                        s.push_str("<br>\n");
                    } else {
                        s.push_str(&conv(l, true, true));
                        s.push_str(" &nbsp;\n<br>\n");
                    }
                }
            }
            Block::Raw(r) => s.push_str(r),
            Block::Table(class, rows) => {
                s.push_str(&format!("<table class=\"{class}\" cellspacing=\"0\" cellpadding=\"0\">\n"));
                let cols = rows.iter().find_map(|r| if let Tr::Row(_, c) = r { Some(c.len()) } else { None }).unwrap_or(1);
                for r in rows {
                    match r {
                        Tr::Gap => s.push_str(&format!("<tr class=\"SectionGap\"><td colspan=\"{cols}\">&nbsp;</td></tr>\n")),
                        Tr::Row(sec, cells) => {
                            s.push_str(&format!("<tr class=\"{sec}\">\n"));
                            for Cell(c, h) in cells {
                                let c = if wrap { format!("{c} Wrap") } else { c.clone() };
                                s.push_str(&format!("<td class=\"{c}\">{h}</td>\n"));
                            }
                            s.push_str("</tr>\n");
                        }
                    }
                }
                s.push_str("</table>\n<br>\n");
            }
        }
        first = false;
    }
    if !doc.stats && !matches!(doc.blocks.last(), Some(Block::Table(..))) {
        s.push_str("<br>\n");
    }
    s.push_str("</body>\n</html>\n");
    s
}

fn output(doc: Doc, spec: &ReportSpec) -> Output {
    let content = render(&doc, spec);
    Output { content, files: doc.files }
}

/// A unique attachment time stamp, distinct for every call in this process.
fn stamp() -> String {
    static LAST: AtomicI64 = AtomicI64::new(0);
    let now = now_ms();
    let ms = loop {
        let prev = LAST.load(Ordering::SeqCst);
        let next = now.max(prev + 1);
        if LAST.compare_exchange(prev, next, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            break next;
        }
    };
    Local.timestamp_millis_opt(ms).earliest().map(|t| t.format("%Y-%m-%d_%H-%M-%S-%3f").to_string()).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Images

fn png(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            rgba.extend_from_slice(&f(x, y));
        }
    }
    pix::encode_png(w, h, &rgba).unwrap_or_default()
}

const CLEAR: [u8; 4] = [0, 0, 0, 0];
const BLACK: [u8; 4] = [0, 0, 0, 255];
const WHITE: [u8; 4] = [255, 255, 255, 255];

fn shade(c: [u8; 3], f: f32) -> [u8; 4] {
    let ch = |v: u8| if f >= 1.0 { (v as f32 + (255.0 - v as f32) * (f - 1.0)).round() as u8 } else { (v as f32 * f).round() as u8 };
    [ch(c[0]), ch(c[1]), ch(c[2]), 255]
}

/// A 16x16 folder: closed, or open with its front flap tilted forward.
fn folder_icon(state: &str, open: bool, mono: bool) -> Vec<u8> {
    // (fill, outline); `None` fill draws a hollow folder.
    let (fill, edge): (Option<[u8; 3]>, [u8; 3]) = match (state, mono) {
        ("Same", _) => (Some([0x60, 0x60, 0x60]), [0x14, 0x14, 0x14]),
        (_, true) => (None, [0x80, 0x80, 0x80]),
        ("Diff" | "Newer", _) => (Some([0xf0, 0x70, 0x70]), [0x5b, 0x37, 0x37]),
        ("Orphan", _) => (Some([0x98, 0x50, 0xe0]), [0x3a, 0x1c, 0x5a]),
        _ => (Some([0xa8, 0xa8, 0xa8]), [0x50, 0x50, 0x50]),
    };
    let edge = [edge[0], edge[1], edge[2], 255];
    let body = move |y: u32| match fill {
        Some(c) => shade(c, 1.25 - y as f32 * 0.04),
        None => CLEAR,
    };
    png(16, 16, move |x, y| {
        let (x, y) = (x as i32, y as i32);
        // Tab across the top left, then the back panel.
        if (1..=3).contains(&y) && x <= 6 - (y == 1) as i32 {
            return if y == 1 || x == 0 || x == 6 - (y == 1) as i32 { edge } else { body(y as u32) };
        }
        if !open {
            if !(3..=13).contains(&y) || x > 14 {
                return CLEAR;
            }
            return if y == 13 || x == 0 || x == 14 || (y == 3 && x >= 6) || y == 4 { edge } else { body(y as u32) };
        }
        if (3..=5).contains(&y) && x <= 13 {
            return if x == 0 || x == 13 || (y == 3 && x >= 6) { edge } else { body(y as u32 + 2) };
        }
        // Front flap: a parallelogram leaning right by one pixel every two rows.
        if (5..=13).contains(&y) {
            let lean = (13 - y) / 2;
            let (l, r) = (lean, 13 + lean.min(2));
            if x == 0 && y < 13 {
                return edge;
            }
            if x < l || x > r {
                return CLEAR;
            }
            return if y == 5 || y == 13 || x == l || x == r { edge } else { body(y as u32 + 2) };
        }
        CLEAR
    })
}

/// A 28x16 content comparison glyph: optional "01" binary mark and the verdict sign.
fn content_icon(kind: &str, mono: bool) -> Vec<u8> {
    let binary = kind.ends_with("Binary");
    let sign = kind.trim_start_matches("Content").trim_end_matches("Binary");
    let gray = [0x80, 0x80, 0x80, 255];
    let ink = match (sign, mono) {
        ("Different", false) => [0xff, 0, 0, 255],
        ("Different", true) => [0x55, 0x55, 0x55, 255],
        ("Similar", _) => [0x84, 0x84, 0x84, 255],
        _ => BLACK,
    };
    let glyph = move |x: i32, y: i32| -> bool {
        let bar = |y0: i32| (11..=18).contains(&x) && (y0..=y0 + 1).contains(&y);
        match sign {
            "Same" => bar(5) || bar(8),
            "Different" => bar(5) || bar(8) || (3..=11).contains(&y) && x == 17 - (y - 3) / 2,
            // Two tildes, each two pixels thick.
            _ => {
                const OFF: [i32; 8] = [0, -1, -1, 0, 0, 1, 1, 0];
                let wave = |y0: i32| (11..=18).contains(&x) && (0..=1).contains(&(y - y0 - OFF[(x - 11) as usize]));
                wave(5) || wave(8)
            }
        }
    };
    png(28, 16, move |x, y| {
        let (x, y) = (x as i32, y as i32);
        if glyph(x, y) {
            return ink;
        }
        if (-1..=1).any(|dx| (-1..=1).any(|dy| glyph(x + dx, y + dy))) {
            return WHITE;
        }
        if binary {
            let zero = (1..=4).contains(&x) && (4..=12).contains(&y) && (x == 1 || x == 4 || y == 4 || y == 12);
            let one = (x == 7 && (4..=12).contains(&y)) || (x == 6 && y == 5) || (y == 12 && (6..=8).contains(&x));
            if zero || one {
                return gray;
            }
        }
        CLEAR
    })
}

fn icon(name: &str, mono: bool) -> Vec<u8> {
    match name {
        "LINE_I" => png(12, 20, |x, _| if x == 5 { BLACK } else { CLEAR }),
        "LINE_T" => png(12, 20, |x, y| if x == 5 || (y == 10 && (6..=10).contains(&x)) { BLACK } else { CLEAR }),
        "LINE_L" => png(12, 20, |x, y| if (x == 5 && y <= 10) || (y == 10 && (6..=10).contains(&x)) { BLACK } else { CLEAR }),
        "LINE_NONE" => png(12, 20, |_, _| CLEAR),
        "BOX_PLUS" | "BOX_MINUS" => {
            let plus = name == "BOX_PLUS";
            png(10, 20, move |x, y| {
                let (bx, by) = (x as i32, y as i32 - 5);
                if !(0..9).contains(&bx) || !(0..9).contains(&by) {
                    CLEAR
                } else if bx == 0 || bx == 8 || by == 0 || by == 8 || (by == 4 && (2..=6).contains(&bx)) || (plus && bx == 4 && (2..=6).contains(&by)) {
                    BLACK
                } else {
                    CLEAR
                }
            })
        }
        "TableHeaderSigMod" | "TableHeaderSigAdd" => {
            let fill = if name == "TableHeaderSigMod" { [230, 60, 60, 255] } else { [150, 80, 220, 255] };
            png(10, 10, move |x, y| if x == 0 || y == 0 || x == 9 || y == 9 { WHITE } else { fill })
        }
        n if n.starts_with("Content") => content_icon(n, mono),
        n if n.starts_with("Dir") => folder_icon(n.trim_start_matches("Dir").trim_end_matches("Expanded"), n.ends_with("Expanded"), mono),
        _ => vec![],
    }
}

fn attach_icons(doc: &mut Doc, names: &[&str]) {
    for n in names {
        let data = icon(n, doc.mono);
        doc.attach(&format!("BcImages/{n}.png"), data);
    }
}

const FOLDER_ICONS: [&str; 6] = ["BOX_MINUS", "BOX_PLUS", "LINE_I", "LINE_L", "LINE_NONE", "LINE_T"];
const TABLE_ICONS: [&str; 2] = ["TableHeaderSigAdd", "TableHeaderSigMod"];

// ---------------------------------------------------------------------------
// Text

#[derive(Clone, Copy, PartialEq, Eq)]
enum Hl {
    None,
    Sig,
    Insig,
}

fn text_cell_html(line: &str, ranges: &[[u32; 2]], k: Kind, orphan: bool) -> String {
    if k == Kind::Same && !orphan {
        return plain(line);
    }
    let mut marks: Vec<(char, bool)> = vec![];
    let mut u = 0u32;
    let whole = orphan || ranges.is_empty();
    for c in line.chars() {
        let on = whole || ranges.iter().any(|r| u >= r[0] && u < r[1]);
        marks.push((c, on));
        u += c.len_utf16() as u32;
    }
    // Whitespace between two highlighted ranges is highlighted too.
    let n = marks.len();
    let mut i = 0;
    while i < n {
        if marks[i].1 {
            i += 1;
            continue;
        }
        let s = i;
        while i < n && !marks[i].1 {
            i += 1;
        }
        if s > 0 && i < n && marks[s..i].iter().all(|m| m.0.is_whitespace()) {
            for m in &mut marks[s..i] {
                m.1 = true;
            }
        }
    }
    let unimp = k == Kind::Unimportant;
    let chars: Vec<(char, Option<&str>)> = marks
        .iter()
        .map(|&(c, on)| {
            let h = if !on {
                Hl::None
            } else if unimp || c.is_whitespace() {
                Hl::Insig
            } else {
                Hl::Sig
            };
            (
                c,
                match h {
                    Hl::None => None,
                    Hl::Sig => Some("TextSegSigDiff"),
                    Hl::Insig => Some("TextSegInsigDiff"),
                },
            )
        })
        .collect();
    spans(&chars)
}

fn text_item(row: &Row, left: bool, lines: &[String], style: Option<&str>) -> Cell {
    let side = if left { row.l } else { row.r };
    let Some(i) = side else { return nbsp("TextItemSame") };
    let orphan = matches!(row.k, Kind::Left | Kind::Right);
    let line = &lines[i as usize];
    let ranges = if left { &row.ls } else { &row.rs };
    let html = text_cell_html(line, ranges, row.k, orphan);
    let level = match row.k {
        Kind::Same => return cell("TextItemSame", html),
        Kind::Unimportant => "Insig",
        _ => "Sig",
    };
    cell(&format!("TextItem{level}{}", style.unwrap_or("Mod")), html)
}

fn num_cell(class: &str, n: Option<u32>) -> Cell {
    match n {
        Some(n) => cell(class, (n + 1).to_string()),
        None => nbsp(class),
    }
}

fn text_table(t: &TextCmp, spec: &ReportSpec) -> Vec<Tr> {
    let iu = spec.iu();
    let ln = spec.has("line-numbers");
    let diffs: Vec<bool> = t.rows.iter().map(|r| text_row_diff(r.k, iu)).collect();
    let ps = pieces(&diffs, spec.display());
    if spec.layout == "interleaved" {
        let (ls, rs) = if spec.has("strikeout-left-diffs") {
            (Some("Del"), Some("Add"))
        } else if spec.has("strikeout-right-diffs") {
            (Some("Add"), Some("Del"))
        } else {
            (None, None)
        };
        return sectioned(&ps, |p| {
            let rows = &t.rows[p.start..p.end];
            if p.diff {
                let left: Vec<Vec<Cell>> = rows
                    .iter()
                    .filter(|r| r.l.is_some())
                    .map(|r| vec![num_cell("TextItemNum AlignRight", r.l), nbsp("TextItemNum AlignRight"), text_item(r, true, &t.left.lines, ls)])
                    .collect();
                let right: Vec<Vec<Cell>> = rows
                    .iter()
                    .filter(|r| r.r.is_some())
                    .map(|r| vec![nbsp("TextItemNum AlignRight"), num_cell("TextItemNum AlignRight", r.r), text_item(r, false, &t.right.lines, rs)])
                    .collect();
                let split = (!left.is_empty() && !right.is_empty()).then_some(left.len());
                (left.into_iter().chain(right).collect(), split)
            } else {
                let cells = rows
                    .iter()
                    .map(|r| {
                        let item = if r.l.is_some() { text_item(r, true, &t.left.lines, None) } else { text_item(r, false, &t.right.lines, None) };
                        vec![num_cell("TextItemNum AlignRight", r.l), num_cell("TextItemNum AlignRight", r.r), item]
                    })
                    .collect();
                (cells, None)
            }
        });
    }
    sectioned(&ps, |p| {
        let marker = if p.diff { row_side_marker(&t.rows[p.start..p.end]) } else { "=" };
        let rows = (p.start..p.end)
            .map(|i| {
                let r = &t.rows[i];
                let mut c = vec![];
                if ln {
                    c.push(num_cell("TextItemNum AlignRight", r.l));
                }
                c.push(text_item(r, true, &t.left.lines, None));
                c.push(cell("AlignCenter", if i == p.start { html_escape(marker) } else { "&nbsp;".into() }));
                if ln {
                    c.push(num_cell("TextItemNum AlignRight", r.r));
                }
                c.push(text_item(r, false, &t.right.lines, None));
                c
            })
            .collect();
        (rows, None)
    })
}

// ---------------------------------------------------------------------------
// Hex

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tok {
    Plain,
    Diff,
    Missing,
}

fn hex_cell_html(r: &HexRow, left: bool) -> String {
    let side = |c: &HexPos| if left { c.l } else { c.r };
    let toks: Vec<(Tok, Option<u8>)> = (0..8)
        .map(|i| match r.cols.get(i) {
            None => (Tok::Missing, None),
            Some(c) => match side(c) {
                None => (Tok::Missing, None),
                Some(b) => (if c.diff { Tok::Diff } else { Tok::Plain }, Some(b)),
            },
        })
        .collect();
    let mut segs: Vec<(Tok, String)> = vec![];
    let mut push = |t: Tok, s: &str| match segs.last_mut() {
        Some((lt, ls)) if *lt == t => ls.push_str(s),
        _ => segs.push((t, s.to_string())),
    };
    for (i, &(t, b)) in toks.iter().enumerate() {
        if i > 0 {
            let p = toks[i - 1].0;
            let st = if p == Tok::Missing || t == Tok::Missing {
                Tok::Missing
            } else if p == Tok::Diff && t == Tok::Diff {
                Tok::Diff
            } else {
                Tok::Plain
            };
            push(st, " ");
        }
        push(t, &b.map(|b| format!("{b:02X}")).unwrap_or_else(|| "  ".into()));
    }
    push(Tok::Plain, "  ");
    for &(t, b) in &toks {
        let ch = b.map(|b| if (0x20..0x7f).contains(&b) { b as char } else { '.' }).unwrap_or(' ');
        push(t, &ch.to_string());
    }
    let n = segs.len();
    segs.iter()
        .enumerate()
        .map(|(i, (t, s))| {
            let body = conv(s, i == 0, i + 1 == n);
            match t {
                Tok::Plain => body,
                Tok::Diff => format!("<span class=\"HexSegDiff\">{body}</span>"),
                Tok::Missing => format!("<span class=\"\">{body}</span>"),
            }
        })
        .collect()
}

fn hex_num(r: &HexRow, left: bool, show: bool) -> Cell {
    if show && r.has(left) {
        cell("HexItemNum AlignRight", format!("{:08X}", if left { r.lo } else { r.ro }))
    } else {
        nbsp("HexItemNum AlignRight")
    }
}

fn hex_table(h: &HexCmp, spec: &ReportSpec) -> Vec<Tr> {
    let ln = spec.has("line-numbers");
    let (rows, ps) = hex_layout(h, spec.display());
    if spec.layout == "interleaved" {
        return sectioned(&ps, |p| {
            let rs = &rows[p.start..p.end];
            if p.diff {
                let left: Vec<Vec<Cell>> =
                    rs.iter().filter(|r| r.has(true)).map(|r| vec![hex_num(r, true, true), nbsp("HexItemNum AlignRight"), cell("HexItemSame", hex_cell_html(r, true))]).collect();
                let right: Vec<Vec<Cell>> =
                    rs.iter().filter(|r| r.has(false)).map(|r| vec![nbsp("HexItemNum AlignRight"), hex_num(r, false, true), cell("HexItemSame", hex_cell_html(r, false))]).collect();
                let split = (!left.is_empty() && !right.is_empty()).then_some(left.len());
                (left.into_iter().chain(right).collect(), split)
            } else {
                (rs.iter().map(|r| vec![hex_num(r, true, true), hex_num(r, false, true), cell("HexItemSame", hex_cell_html(r, true))]).collect(), None)
            }
        });
    }
    sectioned(&ps, |p| {
        let m = hex_marker(&rows, p);
        let out = (p.start..p.end)
            .map(|i| {
                let r = &rows[i];
                let mut c = vec![];
                if ln {
                    c.push(hex_num(r, true, true));
                }
                c.push(cell("HexItemSame", hex_cell_html(r, true)));
                c.push(cell("HexItemSame AlignCenter", if i == p.start { html_escape(m) } else { "&nbsp;".into() }));
                if ln {
                    c.push(hex_num(r, false, true));
                }
                c.push(cell("HexItemSame", hex_cell_html(r, false)));
                c
            })
            .collect();
        (out, None)
    })
}

// ---------------------------------------------------------------------------
// Table

fn img_col(name: &str) -> String {
    format!("<img src=\"BcImages/{name}.png\" width=\"10\" height=\"10\" alt=\"<COL>\" align=\"middle\">")
}

/// Character range of `a` that differs from `b` (common prefix and suffix removed).
fn changed_range(a: &str, b: &str) -> (usize, usize) {
    let (x, y): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let p = x.iter().zip(&y).take_while(|(m, n)| m == n).count();
    let s = x[p..].iter().rev().zip(y[p..].iter().rev()).take_while(|(m, n)| m == n).count();
    (p, x.len() - s)
}

fn table_value(v: &str, hl: Option<(usize, usize)>, class: &str) -> String {
    let chars: Vec<(char, Option<&str>)> = v.chars().enumerate().map(|(i, c)| (c, hl.filter(|&(s, e)| i >= s && i < e).map(|_| class))).collect();
    spans(&chars)
}

fn table_cells(t: &table::TableResult, r: &table::TableRow, left: bool, sbs: bool) -> Vec<Cell> {
    let (rows, other) = if left { (&t.left, &t.right) } else { (&t.right, &t.left) };
    let (me, them) = if left { (r.l, r.r) } else { (r.r, r.l) };
    let Some(i) = me else { return (0..t.columns).map(|_| nbsp("TableItemSame AlignLeft")).collect() };
    let orphan = them.is_none();
    (0..t.columns)
        .map(|c| {
            let v = cell_at(rows, Some(i), c).unwrap_or("");
            let align = if sbs && is_num(v) { "AlignRight" } else { "AlignLeft" };
            let differs = r.cells.contains(&(c as u32));
            let minor = r.minor.contains(&(c as u32));
            if orphan {
                cell(&format!("TableItemSigOrphan {align}"), table_value(v, Some((0, usize::MAX)), "TableSegSigDiff"))
            } else if differs {
                let o = cell_at(other, them, c).unwrap_or("");
                let (lvl, seg) = if minor { ("Insig", "TableSegInsigDiff") } else { ("Sig", "TableSegSigDiff") };
                cell(&format!("TableItem{lvl}Diff {align}"), table_value(v, Some(changed_range(v, o)), seg))
            } else {
                cell(&format!("TableItemSame {align}"), plain(v))
            }
        })
        .collect()
}

fn table_num(r: &table::TableRow, left: bool) -> Cell {
    let (me, them) = if left { (r.l, r.r) } else { (r.r, r.l) };
    let Some(n) = me else { return nbsp("TableItemNum AlignRight") };
    let html = if them.is_none() {
        format!("{} {}", img_col("TableHeaderSigAdd"), n + 1)
    } else if r.k != "same" {
        format!("{} {}", img_col("TableHeaderSigMod"), n + 1)
    } else {
        (n + 1).to_string()
    };
    cell("TableItemNum AlignRight", html)
}

fn table_html(t: &table::TableResult, spec: &ReportSpec) -> Vec<Tr> {
    let iu = spec.iu();
    let ln = spec.has("line-numbers");
    let diffs: Vec<bool> = t.rows.iter().map(|r| table_row_diff(&r.k, iu)).collect();
    let ps = pieces(&diffs, spec.display());
    let shown = table_shown(&ps, t.rows.len());
    let marked: Vec<bool> = (0..t.columns).map(|c| t.rows.iter().any(|r| r.l.is_some() && r.r.is_some() && r.cells.contains(&(c as u32)))).collect();
    let letters = || -> Vec<Cell> {
        (0..t.columns)
            .map(|c| cell("TableItemNum", if marked[c] { format!("{} {}", img_col("TableHeaderSigMod"), col_letter(c)) } else { col_letter(c) }))
            .collect()
    };
    let mut out = vec![];
    if spec.layout == "interleaved" {
        let mut h = vec![nbsp("TableItemNum"), nbsp("TableItemNum")];
        h.extend(letters());
        out.push(Tr::Row("SectionAll", h));
        for &i in &shown {
            let r = &t.rows[i];
            let line = |left: bool| {
                let mut c = vec![if left { table_num(r, true) } else { nbsp("TableItemNum AlignRight") }, if left { nbsp("TableItemNum AlignRight") } else { table_num(r, false) }];
                c.extend(table_cells(t, r, left, false));
                c
            };
            match (r.l, r.r) {
                (Some(_), Some(_)) if r.k == "same" || !table_row_diff(&r.k, iu) => {
                    let mut c = vec![table_num(r, true), table_num(r, false)];
                    c.extend(table_cells(t, r, true, false));
                    out.push(Tr::Row("SectionAll", c));
                }
                (Some(_), Some(_)) => {
                    out.push(Tr::Row("SectionBegin", line(true)));
                    out.push(Tr::Row("SectionEnd", line(false)));
                }
                (Some(_), None) => out.push(Tr::Row("SectionAll", line(true))),
                _ => out.push(Tr::Row("SectionAll", line(false))),
            }
        }
        return out;
    }
    let mut h = vec![];
    if ln {
        h.push(nbsp("TableItemNum AlignRight"));
    }
    h.extend(letters());
    h.push(nbsp("TableItemNum"));
    if ln {
        h.push(nbsp("TableItemNum AlignRight"));
    }
    h.extend(letters());
    out.push(Tr::Row("SectionAll", h));
    for (n, &i) in shown.iter().enumerate() {
        let r = &t.rows[i];
        let mut c = vec![];
        if ln {
            c.push(table_num(r, true));
        }
        c.extend(table_cells(t, r, true, true));
        c.push(cell("AlignCenter", html_escape(table_marker(&r.k, iu))));
        if ln {
            c.push(table_num(r, false));
        }
        c.extend(table_cells(t, r, false, true));
        out.push(Tr::Row(if n + 1 == shown.len() { "SectionEnd" } else { "SectionMiddle" }, c));
    }
    out
}

// ---------------------------------------------------------------------------
// Pair and file reports

fn css_of(kind: &str) -> Css {
    match kind {
        "hex" => Css::Hex,
        "table" => Css::Table,
        "picture" => Css::Pix,
        _ => Css::Text,
    }
}

/// Body blocks of one file pair (after the header lines), with any attachments added to `doc`.
fn pair_blocks(doc: &mut Doc, kind: &str, l: &str, r: &str, spec: &ReportSpec) -> Result<Vec<Block>, String> {
    if spec.summary() {
        return Ok(vec![Block::Lines(body(kind, l, r, spec)?)]);
    }
    Ok(match kind {
        "hex" => vec![Block::Table("fc", hex_table(&load_hex_cmp(l, r)?, spec))],
        "table" => {
            attach_icons(doc, &TABLE_ICONS);
            vec![Block::Table("fc", table_html(&load_table_cmp(l, r)?, spec))]
        }
        "picture" => {
            let load = |p: &str| if fs::metadata(p).map(|m| m.len() == 0).unwrap_or(true) { Ok(empty_picture()) } else { pix::load_picture(p) };
            let (a, b) = (load(l)?, load(r)?);
            let o = pix::PixOptions { ignore_unimportant: spec.iu(), ..Default::default() };
            let (w, h, rgba) = pix::render(&a, &b, &o);
            let name = format!("BcImages/Pix{}.png", stamp());
            if w > 0 && h > 0 {
                doc.attach(&name, pix::encode_png(w, h, &rgba)?);
            }
            vec![Block::Raw(format!("<img src=\"{name}\" class=\"AutoScale\" alt=\"<IMG>\" align=\"middle\">&nbsp; &nbsp;\n<br>\n"))]
        }
        _ => vec![Block::Table("fc", text_table(&load_text_cmp(l, r)?, spec))],
    })
}

pub(super) fn pair(kind: &str, l: &str, r: &str, files: String, spec: &ReportSpec) -> Result<Output, String> {
    let title = default_title(kind);
    let mut doc = Doc::new(spec, title, css_of(kind));
    if kind == "text" && matches!(spec.layout.as_str(), "patch" | "statistics") {
        let mut lines = text_report_lines(l, r, spec)?;
        doc.mono = true;
        if spec.layout == "patch" {
            doc.head = false;
        } else {
            doc.stats = true;
        }
        if lines.last().is_some_and(|x| x.is_empty()) {
            lines.pop();
        }
        doc.blocks.push(Block::Lines(lines));
        return Ok(output(doc, spec));
    }
    if spec.summary() {
        doc.mono = true;
    }
    let mut head = file_header(spec, title);
    head.push(files);
    doc.blocks.push(Block::Lines(head));
    let blocks = pair_blocks(&mut doc, kind, l, r, spec)?;
    doc.blocks.extend(blocks);
    Ok(output(doc, spec))
}

pub(super) fn file_report(spec: &ReportSpec, items: &[(String, String, String, String)], left_base: &str, right_base: &str) -> Result<Output, String> {
    let kind = items.first().map(|i| i.0.as_str()).unwrap_or("text");
    let title = default_title(kind);
    let mut doc = Doc::new(spec, title, css_of(kind));
    if spec.summary() {
        doc.mono = true;
    }
    let mut head = file_header(spec, title);
    head.push(format!("Left base folder: {left_base}"));
    head.push(format!("Right base folder: {right_base}"));
    doc.blocks.push(Block::Lines(head));
    for (kind, rel, l, r) in items {
        doc.blocks.push(Block::Lines(vec![String::new(), format!("File: {rel}")]));
        let blocks = pair_blocks(&mut doc, kind, l, r, spec)?;
        doc.blocks.extend(blocks);
    }
    // Consecutive line blocks render identically to one merged block.
    Ok(output(doc, spec))
}

// ---------------------------------------------------------------------------
// Folder reports

fn conn_img(c: Conn) -> String {
    let (name, alt) = match c {
        Conn::I => ("LINE_I", "|"),
        Conn::T => ("LINE_T", "+"),
        Conn::L => ("LINE_L", "\\"),
        Conn::None => ("LINE_NONE", " "),
    };
    format!("<img src=\"BcImages/{name}.png\" class=\"AutoScale\" alt=\"{alt}\" align=\"middle\">")
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum DState {
    Same,
    Orphan,
    Newer,
    Older,
    Diff,
}

impl DState {
    fn name(self) -> &'static str {
        match self {
            DState::Same => "Same",
            DState::Orphan => "Orphan",
            DState::Newer => "Newer",
            DState::Older => "Older",
            DState::Diff => "Diff",
        }
    }
}

/// State of a folder seen from one side: its worst descendant.
fn dir_state(n: &Node, left: bool, timesize: bool) -> DState {
    let (me, other) = if left { (n.left.is_some(), n.right.is_some()) } else { (n.right.is_some(), n.left.is_some()) };
    if me && !other {
        return DState::Orphan;
    }
    let mut worst = DState::Same;
    for c in &n.children {
        let s = if c.dir {
            let here = if left { c.left.is_some() } else { c.right.is_some() };
            if !here {
                DState::Same
            } else {
                dir_state(c, left, timesize)
            }
        } else {
            match (file_class(c, timesize), left) {
                (FClass::Same, _) => DState::Same,
                (FClass::Diff, _) => DState::Diff,
                (FClass::LOrphan, true) | (FClass::ROrphan, false) => DState::Orphan,
                (FClass::LOrphan, false) | (FClass::ROrphan, true) => DState::Same,
                (FClass::LNewer, true) | (FClass::RNewer, false) => DState::Newer,
                (FClass::LNewer, false) | (FClass::RNewer, true) => DState::Older,
            }
        };
        if s > worst {
            worst = s;
        }
    }
    worst
}

fn file_item_class(c: FClass, left: bool) -> &'static str {
    match (c, left) {
        (FClass::Same, _) => "DirItemSame",
        (FClass::Diff, _) => "DirItemDiff",
        (FClass::LOrphan | FClass::ROrphan, _) => "DirItemOrphan",
        (FClass::LNewer, true) | (FClass::RNewer, false) => "DirItemNewer",
        _ => "DirItemOlder",
    }
}

fn col_align(c: Col) -> &'static str {
    if c == Col::Size { "AlignRight" } else { "AlignLeft" }
}

fn link_report(spec: &ReportSpec, v: &Vis, doc: &mut Doc) -> Option<String> {
    let empty = empty_file().to_string_lossy().into_owned();
    let l = v.lpath.as_ref().map(|p| p.to_string_lossy().into_owned());
    let r = v.rpath.as_ref().map(|p| p.to_string_lossy().into_owned());
    let any = l.as_ref().or(r.as_ref())?.clone();
    let kind = match fileio::detect_kind(&any).as_str() {
        k @ ("hex" | "table" | "picture") => k.to_string(),
        _ => "text".into(),
    };
    let files = match (&l, &r) {
        (Some(a), Some(b)) => files_line(a, b),
        _ => format!("File: {any}"),
    };
    let sub = ReportSpec {
        layout: "side-by-side".into(),
        options: vec!["display-all".into()],
        title: None,
        output_to: String::new(),
        output_options: spec.output_options.clone(),
        css: spec.css.clone(),
    };
    let out = pair(&kind, l.as_deref().unwrap_or(&empty), r.as_deref().unwrap_or(&empty), files, &sub).ok()?;
    let name = format!("BcFiles/Dir{}.html", stamp());
    doc.attach(&name, out.content.into_bytes());
    for (n, d) in out.files {
        doc.attach(&format!("BcFiles/{n}"), d);
    }
    Some(name)
}

fn content_icon_name(c: Content) -> &'static str {
    match c {
        Content::SameBinary => "ContentSameBinary",
        Content::Same => "ContentSame",
        Content::Similar => "ContentSimilar",
        Content::Different => "ContentDifferent",
        Content::DifferentBinary => "ContentDifferentBinary",
    }
}

pub(super) fn folder_sbs(spec: &ReportSpec, cx: &FolderCtx) -> Output {
    let (accept, mode) = folder_display(spec);
    let cols = folder_columns(spec);
    let links = spec.has("include-file-links");
    let tree = visible(cx.root, Some(Path::new(cx.left_base)), Some(Path::new(cx.right_base)), cx, accept, mode == "All");
    let mut flat = vec![];
    flatten(&tree, 1, &mut flat);
    let mut conns = vec![];
    connectors(&tree, 1, [&[], &[]], &mut conns);
    let mut doc = Doc::new(spec, "Folder Compare", Css::Dir);
    attach_icons(&mut doc, &FOLDER_ICONS);
    if links {
        for n in FOLDER_ICONS.iter().chain(&TABLE_ICONS) {
            let data = icon(n, doc.mono);
            doc.attach(&format!("BcFiles/BcImages/{n}.png"), data);
        }
    }
    let mut header = vec![cell("DirItemHeader", "Name")];
    header.extend(cols.iter().map(|&c| cell("DirItemHeader", col_label(c))));
    let mut hrow: Vec<Cell> = header.iter().map(|c| cell(&c.0, c.1.clone())).collect();
    hrow.push(nbsp("DirItemHeader AlignLeft"));
    hrow.extend(header);
    let mut rows: Vec<Vec<Cell>> = vec![];
    for (i, (v, _)) in flat.iter().enumerate() {
        let link = if links && !v.node.dir { link_report(spec, v, &mut doc) } else { None };
        let mut row = vec![];
        for left in [true, false] {
            let prefix: String = conns[i][if left { 0 } else { 1 }].iter().map(|&c| conn_img(c)).collect();
            let path = if left { v.lpath.as_deref() } else { v.rpath.as_deref() };
            let side = if left { v.node.left.as_ref() } else { v.node.right.as_ref() };
            match (side, side_values(v.node, path, left, &cols)) {
                (Some(s), Some(vals)) => {
                    let name = html_escape(&s.name);
                    if v.node.dir {
                        let icon_name = format!("Dir{}{}", dir_state(v.node, left, cx.timesize).name(), if (cx.expanded)(&v.node.rel) { "Expanded" } else { "" });
                        let data = icon(&icon_name, doc.mono);
                        doc.attach(&format!("BcImages/{icon_name}.png"), data);
                        let img = format!("<img src=\"BcImages/{icon_name}.png\" width=\"16\" height=\"16\" alt=\"<DIR>\" align=\"middle\">");
                        row.push(cell("DirItemDefault AlignLeft", format!("{prefix}{img} {name}")));
                        for (k, val) in vals.iter().enumerate() {
                            let html = if val.is_empty() { "&nbsp;".into() } else { format!("<span class=\"DirSegInfo\">{}</span>", conv(val, true, true)) };
                            row.push(cell(&format!("DirItemDefault {}", col_align(cols[k])), html));
                        }
                    } else {
                        let class = file_item_class(v.class.unwrap_or(FClass::Same), left);
                        let name = match &link {
                            Some(h) => format!("<a href=\"{h}\">{name}</a>"),
                            None => name,
                        };
                        row.push(cell(&format!("{class} AlignLeft"), format!("{prefix}{name}")));
                        for (k, val) in vals.iter().enumerate() {
                            row.push(cell(&format!("{class} {}", col_align(cols[k])), conv(val, true, true)));
                        }
                    }
                }
                _ => {
                    row.push(cell("DirItemDefault AlignLeft", if prefix.is_empty() { "&nbsp;".into() } else { prefix }));
                    for &c in &cols {
                        row.push(nbsp(&format!("DirItemDefault {}", col_align(c))));
                    }
                }
            }
            if left {
                match v.node.content.filter(|_| !v.node.dir) {
                    Some(c) => {
                        let name = content_icon_name(c);
                        let data = icon(name, doc.mono);
                        doc.attach(&format!("BcImages/{name}.png"), data);
                        row.push(cell("DirItemDefault AlignLeft", format!("<img src=\"BcImages/{name}.png\" width=\"28\" height=\"16\" alt=\"<CC>\" align=\"middle\"> ")));
                    }
                    None => row.push(nbsp("DirItemDefault AlignLeft")),
                }
            }
        }
        rows.push(row);
    }
    let mut table = vec![Tr::Row("SectionAll", hrow)];
    push_section(&mut table, rows, None);
    doc.blocks.push(Block::Lines(folder_header(spec, cx, mode)));
    doc.blocks.push(Block::Table("dc", table));
    output(doc, spec)
}

pub(super) fn folder_summary(spec: &ReportSpec, cx: &FolderCtx, groups: Vec<(String, Vec<(String, Vec<String>, Option<Vec<String>>)>)>, mode: &str) -> Output {
    let cols = folder_columns(spec);
    let mut doc = Doc::new(spec, "Folder Compare", Css::Dir);
    doc.mono = true;
    let mut table = vec![];
    for (title, entries) in groups {
        let mut h = vec![cell("DirItemHeader", conv(&title, true, true))];
        h.extend(cols.iter().map(|&c| cell("DirItemHeader", col_label(c))));
        table.push(Tr::Row("SectionAll", h));
        let mut rows = vec![];
        for (rel, first, second) in entries {
            let line = |name: &str, vals: &[String]| {
                let mut c = vec![cell("AlignLeft", conv(name, true, true))];
                c.extend(vals.iter().enumerate().map(|(k, v)| cell(col_align(cols[k]), conv(v, true, true))));
                c
            };
            rows.push(line(&rel, &first));
            if let Some(s) = second.filter(|_| !cols.is_empty()) {
                rows.push(line("", &s));
            }
        }
        if !rows.is_empty() {
            push_section(&mut table, rows, None);
        }
    }
    doc.blocks.push(Block::Lines(folder_header(spec, cx, mode)));
    doc.blocks.push(Block::Table("dc", table));
    output(doc, spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icon_sizes() {
        let size = |n: &str, mono: bool| {
            let img = image::load_from_memory(&icon(n, mono)).unwrap();
            (img.width(), img.height())
        };
        for mono in [false, true] {
            for n in ["ContentSameBinary", "ContentSame", "ContentSimilar", "ContentDifferent", "ContentDifferentBinary"] {
                assert_eq!(size(n, mono), (28, 16), "{n}");
            }
            for n in ["DirSame", "DirDiffExpanded", "DirNewerExpanded", "DirOlder", "DirOrphanExpanded"] {
                assert_eq!(size(n, mono), (16, 16), "{n}");
            }
            for n in ["LINE_I", "LINE_T", "LINE_L", "LINE_NONE"] {
                assert_eq!(size(n, mono), (12, 20), "{n}");
            }
        }
        // The mono palette draws the "different" sign in gray instead of red.
        assert_ne!(icon("ContentDifferent", false), icon("ContentDifferent", true));
        assert_eq!(icon("ContentSame", false), icon("ContentSame", true));
    }

    #[test]
    fn space_runs() {
        assert_eq!(conv("Mode:  All", true, true), "Mode:&nbsp; All");
        assert_eq!(conv("a     b", true, true), "a&nbsp; &nbsp;&nbsp; b");
        assert_eq!(conv("", true, true), "&nbsp;");
        assert_eq!(conv("   ", false, true), "&nbsp; &nbsp;");
        assert_eq!(conv("         ", false, false), "&nbsp; &nbsp; &nbsp; &nbsp;&nbsp; ");
        assert_eq!(conv("a b", true, true), "a b");
        assert_eq!(conv("<&>", true, true), "&lt;&amp;&gt;");
    }

    #[test]
    fn sections() {
        assert_eq!(section_names(1, None), ["SectionAll"]);
        assert_eq!(section_names(4, Some(2)), ["SectionBegin", "SubsectionEnd", "SectionMiddle", "SectionEnd"]);
        assert_eq!(section_names(2, Some(1)), ["SubsectionAll", "SectionEnd"]);
    }
}
