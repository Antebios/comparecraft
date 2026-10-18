//! Golden tests for the text comparison engine.
//!
//! Each directory under `tests/fixtures/engine` holds `a.txt`, `b.txt` and an
//! `expected.txt` with one row per line: `<left line|-> <right line|-> <status>`
//! (1-based line numbers), produced with the default rules. Optional
//! `expected_<algorithm>.txt` files hold the result for another alignment
//! algorithm when it differs from the default one.

use comparecraft_lib::diff::{diff_lines, Kind, Rules};
use comparecraft_lib::fileio::split_lines;
use std::path::Path;

fn status(k: Kind, l: Option<u32>, r: Option<u32>) -> &'static str {
    match (k, l, r) {
        (Kind::Same, _, _) => "same",
        (Kind::Changed, _, _) => "different",
        (Kind::Left, _, _) => "leftorphan",
        (Kind::Right, _, _) => "rightorphan",
        (Kind::Unimportant, Some(_), Some(_)) => "similar",
        (Kind::Unimportant, Some(_), None) => "leftsimilar",
        (Kind::Unimportant, None, _) => "rightsimilar",
    }
}

fn run_case(dir: &Path, variant: &str, rules: &Rules) -> Result<(), String> {
    let read = |n: &str| std::fs::read(dir.join(n)).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap();
    let (a, _, _) = split_lines(&read("a.txt"));
    let (b, _, _) = split_lines(&read("b.txt"));
    let res = diff_lines(&a, &b, rules);
    let got: Vec<String> = res
        .rows
        .iter()
        .map(|r| {
            let f = |v: Option<u32>| v.map(|x| (x + 1).to_string()).unwrap_or_else(|| "-".into());
            format!("{} {} {}", f(r.l), f(r.r), status(r.k, r.l, r.r))
        })
        .collect();
    let alt = format!("expected_{variant}.txt");
    let file = if dir.join(&alt).exists() { alt.as_str() } else { "expected.txt" };
    let expected: Vec<String> = read(file).lines().filter(|l| !l.trim().is_empty()).map(String::from).collect();
    if got == expected {
        return Ok(());
    }
    let first = got.iter().zip(&expected).position(|(g, e)| g != e).unwrap_or(got.len().min(expected.len()));
    let lo = first.saturating_sub(3);
    Err(format!(
        "{} [{variant}]: first mismatch at row {} (got {} rows, expected {})\n  got:      {:?}\n  expected: {:?}",
        dir.file_name().unwrap().to_string_lossy(),
        first + 1,
        got.len(),
        expected.len(),
        &got[lo.min(got.len())..(first + 4).min(got.len())],
        &expected[lo.min(expected.len())..(first + 4).min(expected.len())],
    ))
}

/// Every case must match `expected_<variant>.txt`, falling back to the
/// default `expected.txt` when the variant produces the same rows.
fn check(variant: &str, configure: impl Fn(&mut Rules)) {
    let mut rules = Rules::default();
    configure(&mut rules);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/engine");
    let mut dirs: Vec<_> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    assert!(!dirs.is_empty());
    let failures: Vec<String> = dirs.iter().filter_map(|d| run_case(d, variant, &rules).err()).collect();
    if !failures.is_empty() {
        panic!("{} of {} cases differ:\n{}", failures.len(), dirs.len(), failures.join("\n"));
    }
}

#[test]
fn golden_standard_alignment() {
    check("standard", |_| {});
}

#[test]
fn golden_unaligned() {
    check("none", |r| r.algorithm = "none".into());
}

#[test]
fn golden_patience_alignment() {
    check("patience", |r| r.algorithm = "patience".into());
}

#[test]
fn golden_myers_alignment() {
    check("myers", |r| r.algorithm = "myers".into());
}

#[test]
fn golden_standard_never_align_differences() {
    check("standard-neveralign", |r| r.never_align_diffs = true);
}

#[test]
fn golden_standard_without_closeness() {
    check("standard-noclose", |r| r.use_closeness = false);
}

#[test]
fn golden_patience_without_closeness() {
    check("patience-noclose", |r| {
        r.algorithm = "patience".into();
        r.use_closeness = false;
    });
}

#[test]
fn golden_case_important() {
    check("case", |r| r.ignore_case = false);
}

#[test]
fn golden_whitespace_important() {
    check("whitespace", |r| {
        r.ignore_leading_ws = false;
        r.ignore_embedded_ws = false;
        r.ignore_trailing_ws = false;
    });
}

#[test]
fn golden_leading_whitespace_important() {
    check("leading", |r| r.ignore_leading_ws = false);
}

#[test]
fn golden_orphans_always_important() {
    check("orphans", |r| r.ignore_blank_lines = false);
}

#[test]
fn golden_everything_important() {
    check("strict", |r| {
        r.ignore_case = false;
        r.ignore_leading_ws = false;
        r.ignore_embedded_ws = false;
        r.ignore_trailing_ws = false;
        r.ignore_blank_lines = false;
    });
}

#[test]
fn golden_myers_never_align_differences() {
    check("myers-neveralign", |r| {
        r.algorithm = "myers".into();
        r.never_align_diffs = true;
    });
}

#[test]
fn golden_patience_never_align_differences() {
    check("patience-neveralign", |r| {
        r.algorithm = "patience".into();
        r.never_align_diffs = true;
    });
}

#[test]
fn golden_standard_small_skew_tolerance() {
    check("standard-skew5", |r| r.skew_tolerance = 5);
}
