//! Byte-level (hex) comparison helpers.

use serde::Serialize;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};

pub fn read_bytes(path: &str, offset: u64, len: usize) -> io::Result<Vec<u8>> {
    let mut f = fs::File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::with_capacity(len.min(1 << 20));
    f.take(len as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HexDiff {
    pub left_size: u64,
    pub right_size: u64,
    /// Half-open byte ranges [start, end) whose bytes differ positionally.
    pub ranges: Vec<[u64; 2]>,
    pub diff_bytes: u64,
    pub truncated: bool,
}

const MAX_RANGES: usize = 20_000;

/// Positional comparison: byte N on the left is compared with byte N on the right.
/// Bytes beyond the shorter file count as differences.
pub fn hex_diff(left: &str, right: &str) -> io::Result<HexDiff> {
    let mut fl = io::BufReader::with_capacity(1 << 16, fs::File::open(left)?);
    let mut fr = io::BufReader::with_capacity(1 << 16, fs::File::open(right)?);
    let ls = fs::metadata(left)?.len();
    let rs = fs::metadata(right)?.len();
    let mut ranges: Vec<[u64; 2]> = Vec::new();
    let mut diff_bytes = 0u64;
    let mut truncated = false;
    let mut bl = vec![0u8; 1 << 16];
    let mut br = vec![0u8; 1 << 16];
    let mut pos = 0u64;
    let mut open: Option<u64> = None;
    loop {
        let nl = fill(&mut fl, &mut bl)?;
        let nr = fill(&mut fr, &mut br)?;
        let n = nl.max(nr);
        if n == 0 {
            break;
        }
        for i in 0..n {
            let differs = i >= nl || i >= nr || bl[i] != br[i];
            let at = pos + i as u64;
            if differs {
                diff_bytes += 1;
                if open.is_none() {
                    open = Some(at);
                }
            } else if let Some(s) = open.take() {
                if ranges.len() < MAX_RANGES {
                    ranges.push([s, at]);
                } else {
                    truncated = true;
                }
            }
        }
        pos += n as u64;
    }
    if let Some(s) = open {
        if ranges.len() < MAX_RANGES {
            ranges.push([s, pos]);
        } else {
            truncated = true;
        }
    }
    Ok(HexDiff { left_size: ls, right_size: rs, ranges, diff_bytes, truncated })
}

fn fill<R: Read>(r: &mut R, buf: &mut [u8]) -> io::Result<usize> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_ranges() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a");
        let b = d.path().join("b");
        fs::write(&a, [1, 2, 3, 4, 5]).unwrap();
        fs::write(&b, [1, 9, 9, 4, 5, 6, 7]).unwrap();
        let h = hex_diff(a.to_str().unwrap(), b.to_str().unwrap()).unwrap();
        assert_eq!(h.ranges, vec![[1, 3], [5, 7]]);
        assert_eq!(h.diff_bytes, 4);
        assert_eq!(read_bytes(b.to_str().unwrap(), 5, 10).unwrap(), vec![6, 7]);
    }
}
