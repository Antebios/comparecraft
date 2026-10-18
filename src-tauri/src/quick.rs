//! Headless quick comparison that mirrors the observed exit-code contract of
//! the reference application (see docs/REVERSE_ENGINEERING.md).

use crate::diff::{normalize, Rules};
use crate::fileio::{decode, looks_binary, read_all, split_lines};
use std::fs;
use std::io::{self, Read};
use std::path::Path;

pub const BINARY_SAME: i32 = 1;
pub const RULES_SAME: i32 = 2;
pub const BINARY_DIFFERENT: i32 = 11;
pub const SIMILAR: i32 = 12;
pub const RULES_DIFFERENT: i32 = 13;
pub const CONFLICTS: i32 = 14;
pub const UNKNOWN_ERROR: i32 = 100;
pub const CONFLICTS_NOT_WRITTEN: i32 = 101;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QcMode {
    Rules,
    Size,
    Crc,
    Binary,
}

impl QcMode {
    pub fn parse(s: &str) -> Option<QcMode> {
        match s.to_ascii_lowercase().as_str() {
            "" | "rules" => Some(QcMode::Rules),
            "size" => Some(QcMode::Size),
            "crc" => Some(QcMode::Crc),
            "binary" => Some(QcMode::Binary),
            _ => None,
        }
    }
}

pub fn files_binary_equal(a: &Path, b: &Path) -> io::Result<bool> {
    let ma = fs::metadata(a)?;
    let mb = fs::metadata(b)?;
    if ma.len() != mb.len() {
        return Ok(false);
    }
    let mut fa = io::BufReader::with_capacity(1 << 16, fs::File::open(a)?);
    let mut fb = io::BufReader::with_capacity(1 << 16, fs::File::open(b)?);
    let mut ba = vec![0u8; 1 << 16];
    let mut bb = vec![0u8; 1 << 16];
    loop {
        let na = read_full(&mut fa, &mut ba)?;
        let nb = read_full(&mut fb, &mut bb)?;
        if na != nb || ba[..na] != bb[..nb] {
            return Ok(false);
        }
        if na == 0 {
            return Ok(true);
        }
    }
}

fn read_full<R: Read>(r: &mut R, buf: &mut [u8]) -> io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        let k = r.read(&mut buf[n..])?;
        if k == 0 {
            break;
        }
        n += k;
    }
    Ok(n)
}

pub fn crc32_file(p: &Path) -> io::Result<u32> {
    let mut f = io::BufReader::with_capacity(1 << 16, fs::File::open(p)?);
    let mut h = crc32fast::Hasher::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize())
}

/// Rules-based verdict on already loaded byte contents.
pub fn rules_verdict(a: &[u8], b: &[u8]) -> i32 {
    if a == b {
        return BINARY_SAME;
    }
    if looks_binary(a) || looks_binary(b) {
        return BINARY_DIFFERENT;
    }
    let (ta, _, _) = decode(a);
    let (tb, _, _) = decode(b);
    // Encoding, BOM, line-ending style and the final newline are not differences.
    let (la, _, _) = split_lines(&ta);
    let (lb, _, _) = split_lines(&tb);
    if la == lb {
        return RULES_SAME;
    }
    // Case, whitespace and blank-line-only differences make files "similar".
    let loose = Rules {
        ignore_case: true,
        ignore_leading_ws: true,
        ignore_trailing_ws: true,
        ignore_embedded_ws: true,
        ignore_blank_lines: true,
        algorithm: "myers".into(),
        ..Rules::default()
    };
    let na: Vec<String> = la.iter().filter(|l| !l.trim().is_empty()).map(|l| normalize(l, &loose)).collect();
    let nb: Vec<String> = lb.iter().filter(|l| !l.trim().is_empty()).map(|l| normalize(l, &loose)).collect();
    if na == nb {
        SIMILAR
    } else {
        RULES_DIFFERENT
    }
}

pub fn quick_compare(a: &Path, b: &Path, mode: QcMode) -> i32 {
    match quick_compare_inner(a, b, mode) {
        Ok(code) => code,
        Err(_) => UNKNOWN_ERROR,
    }
}

fn quick_compare_inner(a: &Path, b: &Path, mode: QcMode) -> io::Result<i32> {
    let ma = fs::metadata(a)?;
    let mb = fs::metadata(b)?;
    if !ma.is_file() || !mb.is_file() {
        return Err(io::Error::other("quick compare requires two files"));
    }
    let verdict = |same: bool| if same { BINARY_SAME } else { BINARY_DIFFERENT };
    match mode {
        // Observed: the reference app still reports same-size files with different
        // content as different, so size mode falls back to a content check.
        QcMode::Size => Ok(if ma.len() != mb.len() { BINARY_DIFFERENT } else { verdict(files_binary_equal(a, b)?) }),
        QcMode::Crc => Ok(verdict(ma.len() == mb.len() && crc32_file(a)? == crc32_file(b)?)),
        QcMode::Binary => Ok(verdict(files_binary_equal(a, b)?)),
        QcMode::Rules => {
            let da = read_all(a)?;
            let db = read_all(b)?;
            Ok(rules_verdict(&da, &db))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn file(dir: &tempfile::TempDir, name: &str, data: &[u8]) -> std::path::PathBuf {
        let p = dir.path().join(name);
        fs::File::create(&p).unwrap().write_all(data).unwrap();
        p
    }

    /// Mirrors runtime observations of the reference app (docs/REVERSE_ENGINEERING.md §5).
    #[test]
    fn matches_reference_exit_codes() {
        let d = tempfile::tempdir().unwrap();
        let x = file(&d, "x", b"a\nb\n");
        let cases: &[(&[u8], QcMode, i32)] = &[
            (b"a\nb\n", QcMode::Binary, 1),
            (b"a\nc\n", QcMode::Binary, 11),
            (b"a  \r\nb\r\n", QcMode::Rules, 12),
            (b"a\nc\n", QcMode::Rules, 13),
            (b"a\nc\n", QcMode::Size, 11),
            (b"a\nc\n", QcMode::Crc, 11),
            (b"a\nb\n", QcMode::Rules, 1),
            (b"a\r\nb\r\n", QcMode::Rules, 2),
            (b"A\nb\n", QcMode::Rules, 12),
            (b"a\n\nb\n", QcMode::Rules, 12),
            (b"  a\nb\n", QcMode::Rules, 12),
            (b"\xef\xbb\xbfa\nb\n", QcMode::Rules, 2),
            (b"a\nb", QcMode::Rules, 2),
            (b"a\nb\n", QcMode::Size, 1),
            (b"a\nb\nc", QcMode::Size, 11),
        ];
        for (i, (data, mode, want)) in cases.iter().enumerate() {
            let y = file(&d, &format!("y{i}"), data);
            assert_eq!(quick_compare(&x, &y, *mode), *want, "case {i}");
        }
        let e1 = file(&d, "e1", b"a b\nb\n");
        let e2 = file(&d, "e2", b"a   b\nb\n");
        assert_eq!(quick_compare(&e1, &e2, QcMode::Rules), 12);
        let b1 = file(&d, "b1", &[0, 1, 2, 3]);
        let b2 = file(&d, "b2", &[0, 1, 2, 3, 4]);
        assert_eq!(quick_compare(&b1, &b2, QcMode::Rules), 11);
        assert_eq!(quick_compare(&x, &d.path().join("missing"), QcMode::Rules), 100);
        assert_eq!(quick_compare(d.path(), d.path(), QcMode::Rules), 100);
    }
}
