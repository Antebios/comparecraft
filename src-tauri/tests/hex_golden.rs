//! Golden tests for the hex alignment engine. Each fixture directory holds
//! `a.bin`, `b.bin` and `expected_<mode>.txt` with byte totals followed by a
//! run-length map (S same, D different, L left only, R right only).

use comparecraft_lib::hex::{align_bytes, HexAlign};
use std::fs;
use std::path::Path;

fn render(map: &[(u8, u64)]) -> (String, [u64; 4]) {
    let mut counts = [0u64; 4];
    let parts: Vec<String> = map
        .iter()
        .map(|&(k, n)| {
            counts[k as usize] += n;
            format!("{}{}", ["S", "L", "R", "D"][k as usize], n)
        })
        .collect();
    (parts.join(" "), counts)
}

fn parse_expected(text: &str) -> (String, [u64; 4]) {
    let mut counts = [0u64; 4];
    let mut lines: Vec<&str> = text.lines().collect();
    let rle = lines.pop().unwrap_or("").trim().to_string();
    for l in lines.into_iter().filter(|l| !l.trim().is_empty()) {
        let (n, rest) = l.split_once(' ').unwrap();
        let n: u64 = n.parse().unwrap();
        let k = if rest.starts_with("same") {
            0
        } else if rest.starts_with("left") {
            1
        } else if rest.starts_with("right") {
            2
        } else {
            3
        };
        counts[k] = n;
    }
    (rle, counts)
}

fn run(mode: &str, kind: HexAlign) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hex");
    let mut dirs: Vec<_> = fs::read_dir(&root).unwrap().map(|e| e.unwrap().path()).collect();
    dirs.sort();
    let mut failed = Vec::new();
    for d in &dirs {
        let a = fs::read(d.join("a.bin")).unwrap();
        let b = fs::read(d.join("b.bin")).unwrap();
        let (want_rle, want_counts) = parse_expected(&fs::read_to_string(d.join(format!("expected_{mode}.txt"))).unwrap());
        let (got_rle, got_counts) = render(&align_bytes(&a, &b, kind));
        if got_rle != want_rle || got_counts != want_counts {
            let name = d.file_name().unwrap().to_string_lossy().to_string();
            eprintln!("{mode} {name}\n  want {}\n  got  {}", &want_rle[..want_rle.len().min(300)], &got_rle[..got_rle.len().min(300)]);
            failed.push(name);
        }
    }
    assert!(failed.is_empty(), "{} of {} {mode} cases differ: {:?}", failed.len(), dirs.len(), failed);
}

#[test]
fn hex_align_none() {
    run("none", HexAlign::None);
}

#[test]
fn hex_align_fast() {
    run("fast", HexAlign::Fast);
}

#[test]
fn hex_align_complete() {
    run("complete", HexAlign::Complete);
}
