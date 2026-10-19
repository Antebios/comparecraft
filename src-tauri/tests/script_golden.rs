//! Golden tests for the script runner. `tests/fixtures/script/<case>` holds a script, its parameters
//! and expected exit code (`args.txt`), and the expected log and report files. Paths are written as
//! `@ROOT@` and run-dependent values (timestamps, durations, the log banner) are normalised. Files of HTML
//! reports named after their creation time (`BcFiles/Dir<time>.html`) are expected as `Dir#1.html`, `Dir#2.html`...
//! in creation order. Images are not compared.

use comparecraft_lib::script;
use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/script")
}

fn isolate_config() {
    std::env::set_var("COMPARECRAFT_CONFIG_DIR", Path::new(env!("CARGO_TARGET_TMPDIR")).join("script-config"));
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let p = e.path();
        if p.is_dir() {
            copy_tree(&p, &to.join(e.file_name()));
        } else {
            fs::copy(&p, to.join(e.file_name())).unwrap();
        }
    }
}

/// Copies the fixture trees and restores their modification times.
fn setup(root: &Path) {
    copy_tree(&fixtures().join("trees"), root);
    let now = filetime::FileTime::now();
    for line in fs::read_to_string(fixtures().join("mtimes.txt")).unwrap().lines() {
        let (rel, t) = line.split_once('\t').unwrap();
        let ft = if t == "now" { now } else { filetime::FileTime::from_unix_time(t.parse().unwrap(), 0) };
        filetime::set_file_mtime(root.join(rel), ft).unwrap();
    }
}

fn normalise(s: &str, root: &Path) -> String {
    let s = s.replace(&root.to_string_lossy().into_owned(), "@ROOT@");
    let s = normalise_patch_timestamps(&s);
    let s = Regex::new(r"\d\d/\d\d/\d{4} \d\d:\d\d:\d\d [AP]M").unwrap().replace_all(&s, "<TS>");
    let s = Regex::new(r"Completed in [\d.]+").unwrap().replace_all(&s, "Completed in <T>");
    let s = Regex::new(r"completed in [\d.]+ seconds").unwrap().replace_all(&s, "completed in <T> seconds");
    let s = Regex::new(r"\*\*\* .* \*\*\*").unwrap().replace_all(&s, "*** <BANNER> ***");
    stamp_re().replace_all(&s, "$1<STAMP>").into_owned()
}

fn normalise_patch_timestamps(s: &str) -> String {
    Regex::new(r"(?m)^((?:\*\*\*|---|\+\+\+) @ROOT@/[^\t\r\n]+\t)\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{9}")
        .unwrap()
        .replace_all(s, "${1}<TS>")
        .into_owned()
}

#[test]
fn patch_timestamps_are_timezone_independent() {
    let expected = "--- @ROOT@/L/diff.txt\t<TS> \n+++ @ROOT@/R/diff.txt\t<TS> \n*** @ROOT@/base.txt\t<TS> \n@@ -1 +1 @@\n-2024-03-01 12:00:00.000000000\n+2024-03-01 18:00:00.000000000\n";
    for timestamp in ["2024-03-01 12:00:00.000000000", "2024-03-01 18:00:00.000000000", "2024-03-02 03:00:00.000000000"] {
        let input = expected.replace("<TS>", timestamp);
        assert_eq!(normalise_patch_timestamps(&input), expected);
    }
}

fn stamp_re() -> Regex {
    Regex::new(r"(Pix|Dir)\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d-\d{3}").unwrap()
}

/// Joins adjacent HTML spans of the same class: the split points of a highlighted run do not change the
/// rendered report.
fn merge_spans(s: &str) -> String {
    const OPEN: &str = "<span class=\"";
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    let mut last: Option<&str> = None;
    while let Some(i) = rest.find(OPEN) {
        let before = &rest[..i];
        let after = &rest[i + OPEN.len()..];
        let Some(q) = after.find("\">") else { break };
        let class = &after[..q];
        if last == Some(class) && before.ends_with("</span>") && !before[..before.len() - 7].contains('<') {
            out.push_str(&before[..before.len() - 7]);
        } else {
            out.push_str(&rest[..i + OPEN.len() + q + 2]);
        }
        last = Some(class);
        rest = &after[q + 2..];
    }
    out.push_str(rest);
    out
}

/// The files of a report folder by expected name, recursively.
fn report_files(dir: &Path) -> Vec<(String, PathBuf)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
        let mut entries: Vec<PathBuf> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
        entries.sort();
        let re = Regex::new(&format!("^{}\\.html$", stamp_re().as_str())).unwrap();
        let mut n = 0;
        for p in entries {
            if p.is_dir() {
                walk(base, &p, out);
                continue;
            }
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            let rel = match re.captures(&name) {
                Some(c) => {
                    n += 1;
                    rel.replace(&name, &format!("{}#{n}.html", &c[1]))
                }
                None => rel,
            };
            out.push((rel, p));
        }
    }
    let mut out = vec![];
    walk(dir, dir, &mut out);
    out
}

fn run_case(case: &str) {
    isolate_config();
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    setup(root);
    let dir = fixtures().join(case);
    let r = root.to_string_lossy().into_owned();
    let out = ["out", "out2", "out5", "out7", "out8", "out9", "out10", "out11", "out12", "out14", "out15", "out16"];
    for o in out {
        fs::create_dir_all(root.join(o)).unwrap();
    }
    fs::write(root.join("script.txt"), fs::read_to_string(dir.join("script.txt")).unwrap().replace("@ROOT@", &r)).unwrap();
    let args = fs::read_to_string(dir.join("args.txt")).unwrap();
    let mut lines = args.lines();
    let params: Vec<String> = lines.next().unwrap().split_whitespace().map(|p| p.replace("@ROOT@", &r)).collect();
    let code: i32 = lines.next().unwrap().trim().parse().unwrap();
    let got = script::run(&root.join("script.txt").to_string_lossy(), &params, true, root);
    assert_eq!(got, code, "{case}: exit code");
    let out_dir = out.iter().map(|o| root.join(o)).find(|d| fs::read_dir(d).unwrap().next().is_some()).expect("no output");
    let actual_files = report_files(&out_dir);
    let mut failed = vec![];
    for (name, p) in report_files(&dir.join("expected")) {
        let want = merge_spans(&normalise_patch_timestamps(&fs::read_to_string(&p).unwrap()));
        let Some(actual) = actual_files.iter().find(|(n, _)| *n == name).and_then(|(_, p)| fs::read_to_string(p).ok()) else {
            failed.push(format!("{name}: missing"));
            continue;
        };
        let actual = merge_spans(&normalise(&actual, root));
        if actual != want {
            failed.push(format!("{name}:\n--- expected\n{want}\n--- actual\n{actual}"));
        }
    }
    assert!(failed.is_empty(), "{case}: {} file(s) differ\n{}", failed.len(), failed.join("\n"));
}

#[test]
fn reports_and_log() {
    run_case("s1");
}

#[test]
fn rules_based_reports_and_unknown_command() {
    run_case("s2");
}

#[test]
fn report_display_modes_and_filters() {
    run_case("s5");
}

#[test]
fn html_reports_of_every_kind() {
    run_case("s7");
}

#[test]
fn html_custom_style_and_same_files() {
    run_case("s8");
}

#[test]
fn html_space_runs_and_titles() {
    run_case("s9");
}

#[test]
fn folder_states_and_display_filters() {
    run_case("s10");
}

#[test]
fn nested_folder_connectors() {
    run_case("s11");
}

#[test]
fn folder_content_icons_sizes_and_name_order() {
    run_case("s15");
}

#[test]
fn folder_binary_content_icons() {
    run_case("s16");
}

#[test]
fn hex_regions() {
    run_case("s12");
}

#[test]
fn hex_display_context_is_rejected() {
    run_case("s13");
}

#[test]
fn table_line_numbers_and_folder_report_paths() {
    run_case("s14");
}

fn write(p: &Path, s: &str) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, s).unwrap();
}

fn files(root: &Path) -> Vec<String> {
    fn walk(base: &Path, p: &Path, out: &mut Vec<String>) {
        for e in fs::read_dir(p).unwrap() {
            let p = e.unwrap().path();
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            if p.is_dir() {
                out.push(format!("{rel}/"));
                walk(base, &p, out);
            } else {
                out.push(rel);
            }
        }
    }
    let mut out = vec![];
    walk(root, root, &mut out);
    out.sort();
    out
}

fn run_script(root: &Path, text: &str, params: &[&str]) -> (i32, String) {
    isolate_config();
    let r = root.to_string_lossy().into_owned();
    fs::write(root.join("s.txt"), text.replace("@ROOT@", &r)).unwrap();
    let params: Vec<String> = params.iter().map(|p| p.replace("@ROOT@", &r)).collect();
    let code = script::run("s.txt", &params, true, root);
    let log = fs::read_to_string(root.join("log.txt")).unwrap_or_default();
    (code, normalise(&log, root))
}

fn messages(log: &str) -> Vec<String> {
    log.lines().map(|l| l.strip_prefix("<TS>  ").unwrap_or(l).to_string()).filter(|l| !l.starts_with(">> ")).collect()
}

#[test]
fn file_operations() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    for f in ["L/x.txt", "L/s/k.txt", "L/s/t/y.txt", "L/z.log", "R/del.txt"] {
        write(&root.join(f), "1\n");
    }
    let script = "log verbose log.txt
load %1 %2
expand all
select left.all.files
copy left->right
select right.orphan.files
delete right
select all.files
rename regexpr (.*)\\.txt $1.md
select left.files
rename *.bak
select all.files
touch left:\"10/01/2024 12:00:00 PM\"
select left.files
copyto left path:base @ROOT@/D/base
copyto left path:relative @ROOT@/D/rel
copyto left path:none @ROOT@/D/none
";
    let (code, log) = run_script(root, script, &["@ROOT@/L", "@ROOT@/R"]);
    assert_eq!(code, 0, "{log}");
    let mut copied: Vec<String> = messages(&log).into_iter().filter(|l| l.starts_with("Copied") && l.contains("to @ROOT@/R")).collect();
    copied.sort();
    assert_eq!(
        copied,
        [
            "Copied @ROOT@/L/s/k.txt to @ROOT@/R/s",
            "Copied @ROOT@/L/s/t/y.txt to @ROOT@/R/s/t",
            "Copied @ROOT@/L/x.txt to @ROOT@/R",
            "Copied @ROOT@/L/z.log to @ROOT@/R",
        ]
    );
    let m = messages(&log);
    let has = |s: &str| m.iter().any(|l| l == s);
    assert!(has("Successfully copied 4 items.  Completed in <T> seconds."), "{log}");
    assert!(has("Deleted @ROOT@/R/del.txt"));
    assert!(has("Renamed @ROOT@/L/s/t/y.txt to y.md"));
    assert!(has("Successfully renamed 6 items.  2 items skipped.  Completed in <T> seconds."), "{log}");
    assert!(has("Renamed @ROOT@/L/z.log to z.bak"));
    assert!(has("Successfully renamed 4 items.  Completed in <T> seconds."), "{log}");
    assert!(has("Touched @ROOT@/L/s/t/y.bak"));
    assert_eq!(files(&root.join("L")), ["s/", "s/k.bak", "s/t/", "s/t/y.bak", "x.bak", "z.bak"]);
    assert_eq!(files(&root.join("R")), ["s/", "s/k.md", "s/t/", "s/t/y.md", "x.md", "z.log"]);
    assert_eq!(files(&root.join("D/base")), files(&root.join("L")));
    assert_eq!(files(&root.join("D/none")), ["k.bak", "x.bak", "y.bak", "z.bak"]);
    assert_eq!(files(&root.join("D/rel")), files(&root.join("L")));
    let t = fs::metadata(root.join("L/s/k.bak")).unwrap().modified().unwrap();
    let local = chrono::DateTime::<chrono::Local>::from(t);
    assert_eq!(local.format("%m/%d/%Y %I:%M:%S %p").to_string(), "10/01/2024 12:00:00 PM");
}

#[test]
fn sync_filters_and_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write(&root.join("L/both.txt"), "b\n");
    write(&root.join("R/both.txt"), "B\n");
    write(&root.join("L/new.txt"), "n\n");
    write(&root.join("L/sub/s.txt"), "s\n");
    write(&root.join("R/ronly.txt"), "r\n");
    write(&root.join("R/old.log"), "o\n");
    fs::create_dir_all(root.join("L/emptyd")).unwrap();
    filetime::set_file_mtime(root.join("L/both.txt"), filetime::FileTime::from_unix_time(1_706_832_000, 0)).unwrap();
    filetime::set_file_mtime(root.join("R/both.txt"), filetime::FileTime::from_unix_time(1_704_067_200, 0)).unwrap();
    let script = "log normal log.txt
option confirm:yes-to-all
filter \"*.txt;-sub\\\"
load @ROOT@/L @ROOT@/R
sync update:left->right
filter *
sync mirror:left->right
snapshot save-crc left output:snap
expand all
folder-report layout:summary output-to:after.txt
";
    let (code, log) = run_script(root, script, &[]);
    assert_eq!(code, 0, "{log}");
    let m = messages(&log);
    assert!(m.contains(&"Successfully synchronized 2 items.  Completed in <T> seconds.".to_string()), "{log}");
    // The second sync copies sub/s.txt and deletes the right orphans; empty folders are skipped.
    assert!(m.contains(&"Successfully synchronized 3 items.  Completed in <T> seconds.".to_string()), "{log}");
    assert_eq!(files(&root.join("R")), ["both.txt", "new.txt", "sub/", "sub/s.txt"]);
    assert_eq!(fs::read_to_string(root.join("R/both.txt")).unwrap(), "b\n");
    assert!(root.join("snap.ccsnap").is_file());
    let after = fs::read_to_string(root.join("after.txt")).unwrap();
    assert!(after.contains("Same Files (3)"), "{after}");
}

#[test]
fn log_switch_and_load_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let script = "# first
log normal log.txt
log normal log2.txt
load @ROOT@/missing/a @ROOT@/missing/b
beep
";
    let (code, log) = run_script(root, script, &[]);
    assert_eq!(code, script::EXIT_LOAD);
    assert_eq!(log, "<TS>  *** <BANNER> ***\n<TS>  >> # first\n<TS>  >> log normal log.txt\n<TS>  >> log normal log2.txt\n");
    let log2 = normalise(&fs::read_to_string(root.join("log2.txt")).unwrap(), root);
    assert_eq!(
        log2,
        "<TS>  >> log normal log2.txt\n<TS>  >> load @ROOT@/missing/a @ROOT@/missing/b\n<TS>  Load comparison: @ROOT@/missing/a <-> @ROOT@/missing/b\n<TS>  Fatal Scripting Error: Unable to load base folder\n<TS>  Script completed in <T> seconds\n"
    );
}

#[test]
fn exit_codes() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    isolate_config();
    assert_eq!(script::run("does-not-exist.txt", &[], true, root), script::EXIT_SCRIPT_LOAD);
    assert_eq!(run_script(root, "bogus\n", &[]).0, script::EXIT_SYNTAX);
    assert_eq!(run_script(root, "select all\n", &[]).0, 0);
    assert_eq!(run_script(root, "option stop-on-error\nselect all\nbeep\n", &[]).0, script::EXIT_ERROR);
}
