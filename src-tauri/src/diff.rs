//! Line-based text comparison with "important" vs "unimportant" difference rules
//! and intra-line (token level) highlighting.

use serde::{Deserialize, Serialize};
use similar::{capture_diff_slices, Algorithm, DiffTag};
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::align;

/// A "replacement" rule: text on either side that matches `from` is treated
/// as `to` when lines are aligned, so such differences become unimportant.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Replacement {
    pub from: String,
    pub to: String,
    pub regex: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Rules {
    pub ignore_case: bool,
    pub ignore_leading_ws: bool,
    pub ignore_trailing_ws: bool,
    pub ignore_embedded_ws: bool,
    pub ignore_blank_lines: bool,
    /// Line alignment: "standard", "none" (unaligned), "patience" or "myers".
    pub algorithm: String,
    /// How many lines ahead the standard alignment looks for matching runs.
    pub skew_tolerance: i32,
    /// Pair unmatched lines by character similarity.
    pub use_closeness: bool,
    /// Never pair differing lines; show them as orphans instead.
    pub never_align_diffs: bool,
    pub replacements: Vec<Replacement>,
    #[serde(skip)]
    pub(crate) compiled: OnceLock<Vec<(regex::Regex, String)>>,
}

impl Default for Rules {
    fn default() -> Self {
        Rules {
            ignore_case: true,
            ignore_leading_ws: true,
            ignore_trailing_ws: true,
            ignore_embedded_ws: true,
            ignore_blank_lines: true,
            algorithm: "standard".into(),
            skew_tolerance: 2000,
            use_closeness: true,
            never_align_diffs: false,
            replacements: Vec::new(),
            compiled: OnceLock::new(),
        }
    }
}

impl Rules {
    /// Algorithm used by modules that rely on a plain sequence diff (merge).
    pub fn algo(&self) -> Algorithm {
        match self.algorithm.as_str() {
            "myers" => Algorithm::Myers,
            "lcs" => Algorithm::Lcs,
            _ => Algorithm::Patience,
        }
    }

    pub fn align_options(&self) -> align::Options {
        align::Options {
            kind: align::AlignKind::parse(&self.algorithm),
            skew_tolerance: self.skew_tolerance.max(1),
            use_closeness: self.use_closeness,
            never_align_diffs: self.never_align_diffs,
            orphans_always_sig: !self.ignore_blank_lines,
        }
    }

    fn apply_replacements(&self, line: &str) -> String {
        let mut t = line.to_string();
        for (re, to) in self.replacers() {
            t = re.replace_all(&t, to.as_str()).into_owned();
        }
        t
    }

    /// Replacement rules compiled once per comparison; invalid patterns are skipped.
    fn replacers(&self) -> &[(regex::Regex, String)] {
        self.compiled.get_or_init(|| {
            self.replacements
                .iter()
                .filter(|r| !r.from.is_empty())
                .filter_map(|r| {
                    let pat = if r.regex { r.from.clone() } else { regex::escape(&r.from) };
                    let to = if r.regex { r.to.clone() } else { r.to.replace('$', "$$") };
                    regex::RegexBuilder::new(&pat).case_insensitive(self.ignore_case).build().ok().map(|re| (re, to))
                })
                .collect()
        })
    }
}

pub fn normalize(line: &str, r: &Rules) -> String {
    let replaced;
    let mut s: &str = line;
    if !r.replacements.is_empty() {
        let mut t = line.to_string();
        for (re, to) in r.replacers() {
            t = re.replace_all(&t, to.as_str()).into_owned();
        }
        replaced = t;
        s = &replaced;
    }
    if r.ignore_leading_ws {
        s = s.trim_start();
    }
    if r.ignore_trailing_ws {
        s = s.trim_end();
    }
    let mut out = if r.ignore_embedded_ws {
        let mut o = String::with_capacity(s.len());
        let mut in_ws = false;
        for c in s.chars() {
            if c.is_whitespace() {
                if !in_ws {
                    o.push(' ');
                }
                in_ws = true;
            } else {
                o.push(c);
                in_ws = false;
            }
        }
        o
    } else {
        s.to_string()
    };
    if r.ignore_case {
        out = out.to_lowercase();
    }
    out
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Same,
    Unimportant,
    Changed,
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize)]
pub struct Row {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub l: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r: Option<u32>,
    pub k: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h: Option<u32>,
    /// Highlighted UTF-16 ranges on the left line.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ls: Vec<[u32; 2]>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rs: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub start: u32,
    pub end: u32,
    pub important: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub rows: Vec<Row>,
    pub hunks: Vec<Hunk>,
    pub important: u32,
    pub unimportant: u32,
    pub same_lines: u32,
    pub identical: bool,
}

/// Important text of a line under `rules`.
///
/// Characters are classified as leading whitespace, embedded whitespace,
/// trailing whitespace or other text (only space and tab count as whitespace).
/// Returns `(key, text)`: `text` holds the important characters as written and
/// `key` is the same text case-folded when case is unimportant.
fn important_text(line: &str, rules: &Rules) -> (String, String) {
    let is_ws = |c: char| c == ' ' || c == '\t';
    let chars: Vec<char> = line.chars().collect();
    let mut text = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        if !is_ws(chars[i]) {
            text.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && is_ws(chars[i]) {
            i += 1;
        }
        let ignored = if start == 0 {
            rules.ignore_leading_ws
        } else if i < chars.len() {
            rules.ignore_embedded_ws
        } else {
            rules.ignore_trailing_ws
        };
        if !ignored {
            text.extend(&chars[start..i]);
        }
    }
    let key = if rules.ignore_case {
        text.chars()
            .map(|c| {
                let mut up = c.to_uppercase();
                match (up.next(), up.next()) {
                    (Some(u), None) => u,
                    _ => c,
                }
            })
            .collect()
    } else {
        text.clone()
    };
    (key, text)
}

/// Splits a line into word / whitespace-run / single punctuation tokens.
pub fn tokenize(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut prev: Option<u8> = None;
    for (i, c) in s.char_indices() {
        let class = if c.is_alphanumeric() || c == '_' {
            1
        } else if c.is_whitespace() {
            2
        } else {
            3
        };
        if let Some(p) = prev {
            if p != class || class == 3 {
                out.push(&s[start..i]);
                start = i;
            }
        }
        prev = Some(class);
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// Returns highlighted UTF-16 ranges for both lines.
pub fn intraline(a: &str, b: &str, rules: &Rules) -> (Vec<[u32; 2]>, Vec<[u32; 2]>) {
    if a.len() > 4000 || b.len() > 4000 {
        return (vec![[0, utf16_len(a)]], vec![[0, utf16_len(b)]]);
    }
    let ta = tokenize(a);
    let tb = tokenize(b);
    let key = |t: &&str| -> String {
        if t.trim().is_empty() && (rules.ignore_embedded_ws) {
            " ".into()
        } else if rules.ignore_case {
            t.to_lowercase()
        } else {
            t.to_string()
        }
    };
    let ka: Vec<String> = ta.iter().map(key).collect();
    let kb: Vec<String> = tb.iter().map(key).collect();
    let pa = prefix_offsets(&ta);
    let pb = prefix_offsets(&tb);
    let ops = capture_diff_slices(Algorithm::Myers, &ka, &kb);
    let (mut ls, mut rs) = (Vec::new(), Vec::new());
    for op in ops {
        let (tag, o, n) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            for (x, y) in o.clone().zip(n.clone()) {
                if ta[x] != tb[y] {
                    push_range(&mut ls, pa[x], pa[x + 1]);
                    push_range(&mut rs, pb[y], pb[y + 1]);
                }
            }
            continue;
        }
        if !o.is_empty() {
            push_range(&mut ls, pa[o.start], pa[o.end]);
        }
        if !n.is_empty() {
            push_range(&mut rs, pb[n.start], pb[n.end]);
        }
    }
    (ls, rs)
}

fn prefix_offsets(tokens: &[&str]) -> Vec<u32> {
    let mut v = Vec::with_capacity(tokens.len() + 1);
    let mut acc = 0u32;
    v.push(0);
    for t in tokens {
        acc += utf16_len(t);
        v.push(acc);
    }
    v
}

fn push_range(v: &mut Vec<[u32; 2]>, a: u32, b: u32) {
    if a >= b {
        return;
    }
    if let Some(last) = v.last_mut() {
        if last[1] == a {
            last[1] = b;
            return;
        }
    }
    v.push([a, b]);
}

struct LineInfo {
    key: String,
    text: String,
    sig: bool,
}

fn line_infos(lines: &[String], rules: &Rules) -> Vec<LineInfo> {
    lines
        .iter()
        .map(|l| {
            let (key, text) = important_text(l, rules);
            LineInfo { sig: !key.is_empty(), key, text }
        })
        .collect()
}

/// Aligns two texts line by line and classifies each row.
pub fn align_lines(left: &[String], right: &[String], rules: &Rules) -> Vec<(Option<usize>, Option<usize>)> {
    let li = line_infos(left, rules);
    let ri = line_infos(right, rules);
    align_infos(left, right, &li, &ri, rules)
}

fn align_infos(
    left: &[String],
    right: &[String],
    li: &[LineInfo],
    ri: &[LineInfo],
    rules: &Rules,
) -> Vec<(Option<usize>, Option<usize>)> {
    // Lines match when their important text is equal; lines without any
    // important text match on their full text.
    let has_reps = !rules.replacers().is_empty();
    let mut ids: HashMap<String, u32> = HashMap::new();
    ids.insert(String::new(), align::EMPTY_HASH);
    let mut side = |lines: &[String], infos: &[LineInfo]| {
        let mut hash = Vec::with_capacity(lines.len());
        let mut weight = Vec::with_capacity(lines.len());
        let mut full_len = Vec::with_capacity(lines.len());
        for (line, info) in lines.iter().zip(infos) {
            let key = if !info.sig {
                line.clone()
            } else if has_reps {
                important_text(&rules.apply_replacements(line), rules).0
            } else {
                info.key.clone()
            };
            let n = ids.len() as u32 - 1;
            hash.push(*ids.entry(key).or_insert(n));
            weight.push(align::weight_of(line.is_empty(), info.sig));
            full_len.push(line.len());
        }
        (hash, weight, full_len)
    };
    let (ha, wa, fa) = side(left, li);
    let (hb, wb, fb) = side(right, ri);
    let ca: Vec<&[u8]> = left.iter().zip(li).map(|(l, i)| if i.text.is_empty() { l.as_bytes() } else { i.text.as_bytes() }).collect();
    let cb: Vec<&[u8]> = right.iter().zip(ri).map(|(l, i)| if i.text.is_empty() { l.as_bytes() } else { i.text.as_bytes() }).collect();
    let sa: Vec<bool> = li.iter().map(|i| i.sig).collect();
    let sb: Vec<bool> = ri.iter().map(|i| i.sig).collect();
    let a = align::Side { hash: &ha, sig: &sa, weight: &wa, close: &ca, full_len: &fa };
    let b = align::Side { hash: &hb, sig: &sb, weight: &wb, close: &cb, full_len: &fb };
    align::align(&a, &b, &rules.align_options())
}

pub fn diff_lines(left: &[String], right: &[String], rules: &Rules) -> DiffResult {
    let li = line_infos(left, rules);
    let ri = line_infos(right, rules);
    let pairs = align_infos(left, right, &li, &ri, rules);
    let oas = !rules.ignore_blank_lines;
    let has_reps = !rules.replacers().is_empty();

    let mut rows: Vec<Row> = Vec::with_capacity(pairs.len());
    for (l, r) in pairs {
        let kind = match (l, r) {
            (Some(a), Some(b)) => {
                if left[a] == right[b] {
                    Kind::Same
                } else if li[a].key == ri[b].key
                    || (has_reps
                        && important_text(&rules.apply_replacements(&left[a]), rules).0
                            == important_text(&rules.apply_replacements(&right[b]), rules).0)
                {
                    Kind::Unimportant
                } else {
                    Kind::Changed
                }
            }
            (Some(a), None) => {
                if li[a].sig || oas {
                    Kind::Left
                } else {
                    Kind::Unimportant
                }
            }
            (None, Some(b)) => {
                if ri[b].sig || oas {
                    Kind::Right
                } else {
                    Kind::Unimportant
                }
            }
            _ => continue,
        };
        let (ls, rs) = match (l, r, kind) {
            (Some(a), Some(b), Kind::Changed | Kind::Unimportant) => intraline(&left[a], &right[b], rules),
            _ => (vec![], vec![]),
        };
        rows.push(Row { l: l.map(|v| v as u32), r: r.map(|v| v as u32), k: kind, h: None, ls, rs });
    }

    // Group contiguous non-same rows into hunks.
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut same_lines = 0u32;
    let mut idx = 0usize;
    while idx < rows.len() {
        if rows[idx].k == Kind::Same {
            same_lines += 1;
            idx += 1;
            continue;
        }
        let start = idx;
        let mut important = false;
        while idx < rows.len() && rows[idx].k != Kind::Same {
            important |= matches!(rows[idx].k, Kind::Changed | Kind::Left | Kind::Right);
            idx += 1;
        }
        let h = hunks.len() as u32;
        for row in rows.iter_mut().take(idx).skip(start) {
            row.h = Some(h);
        }
        hunks.push(Hunk { start: start as u32, end: idx as u32, important });
    }
    let important = hunks.iter().filter(|h| h.important).count() as u32;
    let unimportant = hunks.len() as u32 - important;
    DiffResult { identical: hunks.is_empty(), rows, hunks, important, unimportant, same_lines }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn identical_inputs() {
        let r = diff_lines(&v(&["a", "b"]), &v(&["a", "b"]), &Rules::default());
        assert!(r.identical);
        assert_eq!(r.rows.len(), 2);
    }

    #[test]
    fn classifies_changes() {
        let r = diff_lines(&v(&["a", "b", "c"]), &v(&["a", "B x", "c", "d"]), &Rules::default());
        let kinds: Vec<Kind> = r.rows.iter().map(|r| r.k).collect();
        assert_eq!(kinds, vec![Kind::Same, Kind::Changed, Kind::Same, Kind::Right]);
        assert_eq!(r.important, 2);
    }

    #[test]
    fn whitespace_is_unimportant() {
        let r = diff_lines(&v(&["int  x;", "y"]), &v(&["  int x; ", "y"]), &Rules::default());
        assert_eq!(r.rows[0].k, Kind::Unimportant);
        assert_eq!(r.important, 0);
        assert_eq!(r.unimportant, 1);
    }

    #[test]
    fn blank_lines_unimportant() {
        let r = diff_lines(&v(&["a", "b"]), &v(&["a", "", "b"]), &Rules::default());
        let kinds: Vec<Kind> = r.rows.iter().map(|r| r.k).collect();
        assert_eq!(kinds, vec![Kind::Same, Kind::Unimportant, Kind::Same]);
        let strict = Rules { ignore_blank_lines: false, ..Rules::default() };
        let r = diff_lines(&v(&["a", "b"]), &v(&["a", "", "b"]), &strict);
        assert_eq!(r.rows[1].k, Kind::Right);
        assert_eq!(r.important, 1);
    }

    #[test]
    fn aligns_similar_lines_in_block() {
        let r = diff_lines(
            &v(&["start", "let alpha = 1;", "end"]),
            &v(&["start", "// new comment", "let alpha = 2;", "end"]),
            &Rules::default(),
        );
        let kinds: Vec<Kind> = r.rows.iter().map(|r| r.k).collect();
        assert_eq!(kinds, vec![Kind::Same, Kind::Right, Kind::Changed, Kind::Same]);
    }

    #[test]
    fn intraline_highlights_token() {
        let (l, r) = intraline("let x = 1;", "let x = 22;", &Rules::default());
        assert_eq!(l, vec![[8, 9]]);
        assert_eq!(r, vec![[8, 10]]);
    }

    #[test]
    fn replacements_make_differences_unimportant() {
        let rules = Rules {
            replacements: vec![
                Replacement { from: "colour".into(), to: "color".into(), regex: false },
                Replacement { from: r"v\d+".into(), to: "vN".into(), regex: true },
            ],
            ..Rules::default()
        };
        let r = diff_lines(&v(&["the colour", "api v1"]), &v(&["the color", "api v2"]), &rules);
        let kinds: Vec<Kind> = r.rows.iter().map(|r| r.k).collect();
        assert_eq!(kinds, vec![Kind::Unimportant, Kind::Unimportant]);
        assert_eq!(r.important, 0);
        let plain = diff_lines(&v(&["the colour"]), &v(&["the color"]), &Rules::default());
        assert_eq!(plain.important, 1);
    }
}
