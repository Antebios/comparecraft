//! Table (CSV/TSV) comparison with optional key columns.

use crate::fileio::{decode, read_all};
use serde::{Deserialize, Serialize};
use similar::{capture_diff_slices, Algorithm, DiffTag};
use std::collections::BTreeMap;
use std::io;
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TableOptions {
    /// Delimiter; empty = auto-detect.
    pub delimiter: String,
    pub header: bool,
    /// Zero-based key columns; empty = align by row content.
    pub keys: Vec<usize>,
    /// Differences only in character case are unimportant.
    pub ignore_case: bool,
    /// Differences only in whitespace are unimportant.
    pub trim: bool,
    /// Zero-based columns whose differences are unimportant (keys excepted).
    pub unimportant: Vec<usize>,
    /// Numbers differing by at most this much are unimportant; 0 disables.
    pub num_tolerance: f64,
    /// `num_tolerance` is a percentage of the larger magnitude.
    pub num_relative: bool,
}

impl Default for TableOptions {
    fn default() -> Self {
        TableOptions {
            delimiter: String::new(),
            header: true,
            keys: vec![],
            ignore_case: false,
            trim: true,
            unimportant: vec![],
            num_tolerance: 0.0,
            num_relative: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub l: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r: Option<u32>,
    /// "same" | "changed" | "unimportant" (only unimportant cells differ) | "left" | "right"
    pub k: String,
    /// Column indices whose values differ.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cells: Vec<u32>,
    /// Subset of `cells` whose differences are unimportant.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub minor: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableResult {
    pub header: Vec<String>,
    pub left: Vec<Vec<String>>,
    pub right: Vec<Vec<String>>,
    pub rows: Vec<TableRow>,
    pub delimiter: String,
    pub columns: usize,
}

pub fn detect_delimiter(path: &str, sample: &str) -> char {
    let ext = Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if ext == "tsv" || ext == "tab" {
        return '\t';
    }
    let first: String = sample.lines().take(5).collect::<Vec<_>>().join("\n");
    let mut best = (',', 0usize);
    for c in [',', '\t', ';', '|'] {
        let n = first.matches(c).count();
        if n > best.1 {
            best = (c, n);
        }
    }
    best.0
}

/// RFC 4180-style parsing (quotes, doubled quotes, embedded newlines).
pub fn parse_csv(text: &str, delim: char) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut in_q = false;
    let mut chars = text.chars().peekable();
    let mut any = false;
    while let Some(c) = chars.next() {
        any = true;
        if in_q {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_q = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' && field.is_empty() {
            in_q = true;
        } else if c == delim {
            row.push(std::mem::take(&mut field));
        } else if c == '\r' || c == '\n' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
            any = false;
        } else {
            field.push(c);
        }
    }
    if any {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn load(path: &str, opts: &TableOptions) -> io::Result<(Vec<Vec<String>>, char)> {
    let (text, _, _) = decode(&read_all(Path::new(path))?);
    let d = opts.delimiter.chars().next().unwrap_or_else(|| detect_delimiter(path, &text));
    Ok((parse_csv(&text, d), d))
}

fn norm(s: &str, o: &TableOptions) -> String {
    let t = if o.trim { s.trim() } else { s };
    if o.ignore_case { t.to_lowercase() } else { t.to_string() }
}

/// Parses a plain decimal number ("-1,234.50", "+3", "1e3"); anything else is text.
fn number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit() || b"+-.,eE".contains(&b)) || !t.bytes().any(|b| b.is_ascii_digit()) {
        return None;
    }
    let t = if t.contains(',') {
        // Only thousands separators are accepted: groups of three digits before any '.'.
        let int = t.split(['.', 'e', 'E']).next().unwrap_or("").trim_start_matches(['+', '-']);
        let mut groups = int.split(',');
        let first = groups.next().unwrap_or("");
        if first.is_empty() || first.len() > 3 || !groups.all(|g| g.len() == 3) {
            return None;
        }
        t.replace(',', "")
    } else {
        t.to_string()
    };
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Classifies one cell pair: 0 = same, 1 = unimportant difference, 2 = important difference.
/// Values that both read as numbers compare by value; otherwise text differences become
/// unimportant when they vanish after case folding / whitespace removal (if those are
/// unimportant), and any difference in an unimportant non-key column is unimportant.
fn cell_kind(a: &str, b: &str, col: usize, o: &TableOptions) -> u8 {
    if a == b {
        return 0;
    }
    let key = o.keys.contains(&col);
    let important = key || !o.unimportant.contains(&col);
    let base = if important { 2 } else { 1 };
    if let (Some(x), Some(y)) = (number(a), number(b)) {
        if x == y {
            return 0;
        }
        if important && !key && o.num_tolerance > 0.0 {
            let tol = if o.num_relative { o.num_tolerance / 100.0 * x.abs().max(y.abs()) } else { o.num_tolerance };
            if (x - y).abs() <= tol {
                return 1;
            }
        }
        return base;
    }
    if important && (o.ignore_case || o.trim) {
        let f = |s: &str| {
            let s: String = if o.trim { s.chars().filter(|c| !c.is_whitespace()).collect() } else { s.to_string() };
            if o.ignore_case { s.to_lowercase() } else { s }
        };
        if f(a) == f(b) {
            return 1;
        }
    }
    base
}

fn mk(l: Option<usize>, r: Option<usize>, left: &[Vec<String>], right: &[Vec<String>], o: &TableOptions) -> TableRow {
    match (l, r) {
        (Some(a), Some(b)) => {
            let (ra, rb) = (&left[a], &right[b]);
            let (mut cells, mut minor) = (vec![], vec![]);
            for i in 0..ra.len().max(rb.len()) {
                let k = cell_kind(ra.get(i).map(|s| s.as_str()).unwrap_or(""), rb.get(i).map(|s| s.as_str()).unwrap_or(""), i, o);
                if k > 0 {
                    cells.push(i as u32);
                }
                if k == 1 {
                    minor.push(i as u32);
                }
            }
            let k = if cells.is_empty() {
                "same"
            } else if cells.len() == minor.len() {
                "unimportant"
            } else {
                "changed"
            };
            TableRow { l: Some(a as u32), r: Some(b as u32), k: k.into(), cells, minor }
        }
        (Some(a), None) => TableRow { l: Some(a as u32), r: None, k: "left".into(), cells: vec![], minor: vec![] },
        (None, Some(b)) => TableRow { l: None, r: Some(b as u32), k: "right".into(), cells: vec![], minor: vec![] },
        _ => unreachable!(),
    }
}

pub fn compare_tables(left_path: &str, right_path: &str, o: &TableOptions) -> io::Result<TableResult> {
    let (mut left, d) = load(left_path, o)?;
    let (mut right, _) = load(right_path, o)?;
    let mut header = Vec::new();
    if o.header {
        if !left.is_empty() {
            header = left.remove(0);
        }
        if !right.is_empty() {
            let rh = right.remove(0);
            if header.is_empty() {
                header = rh;
            }
        }
    }
    let columns = left.iter().chain(right.iter()).map(|r| r.len()).max().unwrap_or(0).max(header.len());
    let mut rows = Vec::new();
    if o.keys.is_empty() {
        let lk: Vec<String> = left.iter().map(|r| r.iter().map(|c| norm(c, o)).collect::<Vec<_>>().join("\u{1}")).collect();
        let rk: Vec<String> = right.iter().map(|r| r.iter().map(|c| norm(c, o)).collect::<Vec<_>>().join("\u{1}")).collect();
        for op in capture_diff_slices(Algorithm::Patience, &lk, &rk) {
            let (tag, a, b) = op.as_tag_tuple();
            if tag == DiffTag::Equal {
                for (x, y) in a.zip(b) {
                    rows.push(mk(Some(x), Some(y), &left, &right, o));
                }
            } else {
                let (al, bl) = (a.len(), b.len());
                for k in 0..al.max(bl) {
                    let x = if k < al { Some(a.start + k) } else { None };
                    let y = if k < bl { Some(b.start + k) } else { None };
                    rows.push(mk(x, y, &left, &right, o));
                }
            }
        }
    } else {
        let key = |r: &Vec<String>| -> String {
            o.keys.iter().map(|&k| norm(r.get(k).map(|s| s.as_str()).unwrap_or(""), o)).collect::<Vec<_>>().join("\u{1}")
        };
        let mut map: BTreeMap<String, (Vec<usize>, Vec<usize>)> = BTreeMap::new();
        for (i, r) in left.iter().enumerate() {
            map.entry(key(r)).or_default().0.push(i);
        }
        for (i, r) in right.iter().enumerate() {
            map.entry(key(r)).or_default().1.push(i);
        }
        for (_, (ls, rs)) in map {
            for k in 0..ls.len().max(rs.len()) {
                rows.push(mk(ls.get(k).copied(), rs.get(k).copied(), &left, &right, o));
            }
        }
    }
    Ok(TableResult { header, left, right, rows, delimiter: d.to_string(), columns })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quotes() {
        let r = parse_csv("a,\"b,c\",\"d\"\"e\"\n1,2,3", ',');
        assert_eq!(r, vec![vec!["a", "b,c", "d\"e"], vec!["1", "2", "3"]]);
    }

    #[test]
    fn keyed_compare() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a.csv");
        let b = d.path().join("b.csv");
        std::fs::write(&a, "id,name,qty\n1,apple,3\n2,pear,5\n3,fig,1\n").unwrap();
        std::fs::write(&b, "id,name,qty\n2,pear,6\n1,apple,3\n4,kiwi,2\n").unwrap();
        let o = TableOptions { keys: vec![0], ..Default::default() };
        let r = compare_tables(a.to_str().unwrap(), b.to_str().unwrap(), &o).unwrap();
        let kinds: Vec<&str> = r.rows.iter().map(|r| r.k.as_str()).collect();
        assert_eq!(kinds, vec!["same", "changed", "left", "right"]);
        assert_eq!(r.rows[1].cells, vec![2]);
        assert_eq!(r.header, vec!["id", "name", "qty"]);
    }

    #[test]
    fn unimportant_cells() {
        let o = TableOptions { ignore_case: true, unimportant: vec![3], num_tolerance: 0.5, ..Default::default() };
        assert_eq!(cell_kind("1.0", "1", 0, &o), 0);
        assert_eq!(cell_kind("1,000", "1000", 0, &o), 0);
        assert_eq!(cell_kind("1.2", "1.6", 0, &o), 1);
        assert_eq!(cell_kind("1", "2", 0, &o), 2);
        assert_eq!(cell_kind("Apple ", "apple", 1, &o), 1);
        assert_eq!(cell_kind("apple", "pear", 1, &o), 2);
        assert_eq!(cell_kind("x", "y", 3, &o), 1);
        let keyed = TableOptions { keys: vec![0, 3], ..o.clone() };
        assert_eq!(cell_kind("1.2", "1.6", 0, &keyed), 2);
        assert_eq!(cell_kind("x", "y", 3, &keyed), 2);
        let rel = TableOptions { num_tolerance: 10.0, num_relative: true, ..Default::default() };
        assert_eq!(cell_kind("100", "109", 0, &rel), 1);
        assert_eq!(cell_kind("100", "112", 0, &rel), 2);
        assert_eq!(number("1,23"), None);
        assert_eq!(number("abc"), None);
        assert_eq!(number("-"), None);
    }

    #[test]
    fn unimportant_rows() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a.csv");
        let b = d.path().join("b.csv");
        std::fs::write(&a, "id,name,note\n1,Apple,x\n2,pear,y\n").unwrap();
        std::fs::write(&b, "id,name,note\n1,apple,x\n2,pear,z\n").unwrap();
        let o = TableOptions { keys: vec![0], ignore_case: true, unimportant: vec![], ..Default::default() };
        let r = compare_tables(a.to_str().unwrap(), b.to_str().unwrap(), &o).unwrap();
        assert_eq!(r.rows[0].k, "unimportant");
        assert_eq!(r.rows[0].minor, vec![1]);
        assert_eq!(r.rows[1].k, "changed");
        let o = TableOptions { unimportant: vec![2], ..o };
        let r = compare_tables(a.to_str().unwrap(), b.to_str().unwrap(), &o).unwrap();
        assert_eq!(r.rows[1].k, "unimportant");
    }
}
