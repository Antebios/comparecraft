//! Line-based text comparison with "important" vs "unimportant" difference rules
//! and intra-line (token level) highlighting.

use serde::{Deserialize, Serialize};
use similar::{capture_diff_slices, Algorithm, DiffTag};
use std::sync::OnceLock;

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
    /// "myers" or "patience"
    pub algorithm: String,
    pub replacements: Vec<Replacement>,
    #[serde(skip)]
    pub(crate) compiled: OnceLock<Vec<(regex::Regex, String)>>,
}

impl Default for Rules {
    fn default() -> Self {
        Rules {
            ignore_case: false,
            ignore_leading_ws: true,
            ignore_trailing_ws: true,
            ignore_embedded_ws: true,
            ignore_blank_lines: true,
            algorithm: "patience".into(),
            replacements: Vec::new(),
            compiled: OnceLock::new(),
        }
    }
}

impl Rules {
    pub fn algo(&self) -> Algorithm {
        match self.algorithm.as_str() {
            "myers" => Algorithm::Myers,
            "lcs" => Algorithm::Lcs,
            _ => Algorithm::Patience,
        }
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

fn is_blank(s: &str) -> bool {
    s.trim().is_empty()
}

/// Cheap similarity ratio (0..1) between two strings using a token diff.
fn similarity(a: &str, b: &str) -> f32 {
    if a == b {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let ta = tokenize(a);
    let tb = tokenize(b);
    let ops = capture_diff_slices(Algorithm::Myers, &ta, &tb);
    let mut same = 0usize;
    for op in ops {
        let (tag, o, _) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            same += ta[o].iter().map(|t| t.len()).sum::<usize>();
        }
    }
    (2 * same) as f32 / (a.len() + b.len()) as f32
}

/// Aligns a replaced block of lines so that similar lines are paired together.
fn align_block(ln: &[&str], rn: &[&str]) -> Vec<(Option<usize>, Option<usize>)> {
    let (n, m) = (ln.len(), rn.len());
    let mut anchors: Vec<(usize, usize)> = Vec::new();
    if n > 0 && m > 0 && n * m <= 2500 && n != m {
        let mut best = vec![vec![0f32; m + 1]; n + 1];
        let mut sims = vec![vec![0f32; m]; n];
        for i in 0..n {
            for j in 0..m {
                sims[i][j] = similarity(ln[i], rn[j]);
            }
        }
        for i in 1..=n {
            for j in 1..=m {
                let mut v = best[i - 1][j].max(best[i][j - 1]);
                let s = sims[i - 1][j - 1];
                if s >= 0.5 {
                    v = v.max(best[i - 1][j - 1] + s);
                }
                best[i][j] = v;
            }
        }
        let (mut i, mut j) = (n, m);
        while i > 0 && j > 0 {
            let s = sims[i - 1][j - 1];
            if s >= 0.5 && (best[i][j] - (best[i - 1][j - 1] + s)).abs() < 1e-6 {
                anchors.push((i - 1, j - 1));
                i -= 1;
                j -= 1;
            } else if (best[i][j] - best[i - 1][j]).abs() < 1e-6 {
                i -= 1;
            } else {
                j -= 1;
            }
        }
        anchors.reverse();
    }
    anchors.push((n, m));
    let mut out = Vec::new();
    let (mut ci, mut cj) = (0usize, 0usize);
    for (ai, aj) in anchors {
        let gl = ai - ci;
        let gr = aj - cj;
        for k in 0..gl.max(gr) {
            let l = if k < gl { Some(ci + k) } else { None };
            let r = if k < gr { Some(cj + k) } else { None };
            out.push((l, r));
        }
        if ai < n && aj < m {
            out.push((Some(ai), Some(aj)));
        }
        ci = ai + 1;
        cj = aj + 1;
    }
    out
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

pub fn diff_lines(left: &[String], right: &[String], rules: &Rules) -> DiffResult {
    let ln: Vec<String> = left.iter().map(|s| normalize(s, rules)).collect();
    let rn: Vec<String> = right.iter().map(|s| normalize(s, rules)).collect();

    // When blank lines are unimportant, align only non-blank lines and weave the
    // blank lines back in afterwards.
    let skip_blank = rules.ignore_blank_lines;
    let lidx: Vec<usize> = (0..left.len()).filter(|&i| !(skip_blank && is_blank(&left[i]))).collect();
    let ridx: Vec<usize> = (0..right.len()).filter(|&i| !(skip_blank && is_blank(&right[i]))).collect();
    let lseq: Vec<&str> = lidx.iter().map(|&i| ln[i].as_str()).collect();
    let rseq: Vec<&str> = ridx.iter().map(|&i| rn[i].as_str()).collect();

    let ops = capture_diff_slices(rules.algo(), &lseq, &rseq);
    let mut pairs: Vec<(Option<usize>, Option<usize>, bool)> = Vec::new(); // (l, r, aligned-equal)
    let mut i = 0;
    while i < ops.len() {
        let (tag, o, n) = ops[i].as_tag_tuple();
        if tag == DiffTag::Equal {
            for (x, y) in o.zip(n) {
                pairs.push((Some(lidx[x]), Some(ridx[y]), true));
            }
            i += 1;
            continue;
        }
        // Merge consecutive non-equal ops into one block.
        let (mut os, mut oe, mut ns, mut ne) = (o.start, o.end, n.start, n.end);
        let mut j = i + 1;
        while j < ops.len() {
            let (t2, o2, n2) = ops[j].as_tag_tuple();
            if t2 == DiffTag::Equal {
                break;
            }
            os = os.min(o2.start);
            oe = oe.max(o2.end);
            ns = ns.min(n2.start);
            ne = ne.max(n2.end);
            j += 1;
        }
        let bl: Vec<&str> = (os..oe).map(|x| lseq[x]).collect();
        let br: Vec<&str> = (ns..ne).map(|y| rseq[y]).collect();
        for (a, b) in align_block(&bl, &br) {
            pairs.push((a.map(|x| lidx[os + x]), b.map(|y| ridx[ns + y]), false));
        }
        i = j;
    }

    let mut rows: Vec<Row> = Vec::with_capacity(pairs.len() + 8);
    let (mut cl, mut cr) = (0usize, 0usize);
    let push_blanks = |rows: &mut Vec<Row>, cl: &mut usize, cr: &mut usize, tl: usize, tr: usize| {
        let mut bl: Vec<usize> = (*cl..tl).collect();
        let mut br: Vec<usize> = (*cr..tr).collect();
        bl.retain(|&x| is_blank(&left[x]));
        br.retain(|&y| is_blank(&right[y]));
        for k in 0..bl.len().max(br.len()) {
            let l = bl.get(k).copied();
            let r = br.get(k).copied();
            let k_ = match (l, r) {
                (Some(a), Some(b)) if left[a] == right[b] => Kind::Same,
                _ => Kind::Unimportant,
            };
            rows.push(Row { l: l.map(|v| v as u32), r: r.map(|v| v as u32), k: k_, h: None, ls: vec![], rs: vec![] });
        }
        *cl = tl;
        *cr = tr;
    };
    for (l, r, eq) in pairs {
        if skip_blank {
            let tl = l.unwrap_or(cl);
            let tr = r.unwrap_or(cr);
            push_blanks(&mut rows, &mut cl, &mut cr, tl, tr);
        }
        let kind = match (l, r) {
            (Some(a), Some(b)) => {
                if left[a] == right[b] {
                    Kind::Same
                } else if eq || ln[a] == rn[b] {
                    Kind::Unimportant
                } else {
                    Kind::Changed
                }
            }
            (Some(_), None) => Kind::Left,
            (None, Some(_)) => Kind::Right,
            _ => continue,
        };
        let (ls, rs) = match (l, r, kind) {
            (Some(a), Some(b), Kind::Changed | Kind::Unimportant) => intraline(&left[a], &right[b], rules),
            _ => (vec![], vec![]),
        };
        rows.push(Row { l: l.map(|v| v as u32), r: r.map(|v| v as u32), k: kind, h: None, ls, rs });
        if let Some(a) = l {
            cl = a + 1;
        }
        if let Some(b) = r {
            cr = b + 1;
        }
    }
    if skip_blank {
        push_blanks(&mut rows, &mut cl, &mut cr, left.len(), right.len());
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
