//! Byte-level (hex) comparison: positional diff and aligned byte map.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};

pub fn read_bytes(path: &str, offset: u64, len: usize) -> io::Result<Vec<u8>> {
    let mut f = fs::File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::with_capacity(len.min(1 << 20));
    f.take(len as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Hex alignment strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum HexAlign {
    /// Byte N is compared with byte N.
    None,
    /// Anchors on 50-byte matching windows; the gaps between them are compared positionally.
    Fast,
    /// Like Fast, but aligns the gaps between anchors byte-by-byte.
    #[default]
    Complete,
}

/// Map entry kinds.
pub const SAME: u8 = 0;
pub const LEFT_ONLY: u8 = 1;
pub const RIGHT_ONLY: u8 = 2;
pub const DIFF: u8 = 3;

const WINDOW: i64 = 50;
const EXACT_LIMIT: i64 = 5000;

/// Aligns two byte buffers into a run-length map of (kind, count) entries.
/// Adjacent entries always have different kinds.
pub fn align_bytes(a: &[u8], b: &[u8], kind: HexAlign) -> Vec<(u8, u64)> {
    let mut al = Aligner { s: [a, b], kind, out: Vec::new() };
    al.run();
    al.out
}

struct Aligner<'a> {
    s: [&'a [u8]; 2],
    kind: HexAlign,
    out: Vec<(u8, u64)>,
}

impl Aligner<'_> {
    #[inline]
    fn at(&self, side: usize, i: i64) -> u8 {
        self.s[side][i as usize]
    }

    fn add(&mut self, m: u8, n: i64) {
        if n <= 0 {
            return;
        }
        match self.out.last_mut() {
            Some((k, c)) if *k == m => *c += n as u64,
            _ => self.out.push((m, n as u64)),
        }
    }

    fn run(&mut self) {
        let len = [self.s[0].len() as i64, self.s[1].len() as i64];
        if self.kind == HexAlign::None {
            self.run_none([0, 0], len);
            return;
        }
        let e = expmod(257, 50);
        let mut mark = vec![0u8; 65536];
        let mut offs = vec![0i64; 65536];
        let mut pos = [0i64; 2];
        while pos[0] < len[0] - WINDOW && pos[1] < len[1] - WINDOW {
            let start = pos[0];
            while pos[0] < len[0] && pos[1] < len[1] && self.at(0, pos[0]) == self.at(1, pos[1]) {
                pos[0] += 1;
                pos[1] += 1;
            }
            self.add(SAME, pos[0] - start);
            if len[0] - WINDOW <= pos[0] || len[1] - WINDOW <= pos[1] {
                self.run_ex(pos, [len[0] - pos[0], len[1] - pos[1]]);
                return;
            }
            mark.fill(0);
            let mut cur = pos;
            let mut h = [0u32; 2];
            for s in 0..2 {
                let mut m = 1u32;
                for i in (0..WINDOW).rev() {
                    h[s] = (self.at(s, pos[s] + i) as u32 * m + h[s]) & 0xffff;
                    m = m * 257 & 0xffff;
                }
            }
            offs[h[0] as usize] = cur[0];
            mark[h[0] as usize] = 1;
            if h[1] != h[0] {
                offs[h[1] as usize] = cur[1];
                mark[h[1] as usize] = 2;
            }
            let mut found = false;
            'scan: loop {
                for s in 0..2 {
                    if cur[s] + WINDOW < len[s] {
                        let o = 1 - s;
                        let mut v = h[s].wrapping_mul(257);
                        v = v.wrapping_sub(self.at(s, cur[s]) as u32 * e & 0xffff);
                        v = v.wrapping_add(self.at(s, cur[s] + WINDOW) as u32) & 0xffff;
                        h[s] = v;
                        cur[s] += 1;
                        let hv = v as usize;
                        if mark[hv] == 0 {
                            offs[hv] = cur[s];
                            mark[hv] = s as u8 + 1;
                        } else if mark[hv] == o as u8 + 1 {
                            let off = offs[hv];
                            if (0..WINDOW).all(|i| self.at(s, cur[s] + i) == self.at(o, off + i)) {
                                cur[o] = off;
                                found = true;
                                break 'scan;
                            }
                        }
                    }
                }
                if !(cur[0] + WINDOW < len[0] || cur[1] + WINDOW < len[1]) {
                    break;
                }
            }
            if !found {
                break;
            }
            let mut end = cur;
            while pos[0] < end[0] && pos[1] < end[1] && self.at(0, end[0] - 1) == self.at(1, end[1] - 1) {
                end[0] -= 1;
                end[1] -= 1;
            }
            let g = [end[0] - pos[0], end[1] - pos[1]];
            if g[0] >= 1 && g[1] == 0 {
                self.add(LEFT_ONLY, g[0]);
            } else if g[0] == 0 {
                self.add(RIGHT_ONLY, g[1]);
            } else if g[1] != 0 {
                self.run_ex(pos, g);
            }
            self.add(SAME, cur[0] - end[0]);
            if cur[0] < len[0] {
                self.add(SAME, WINDOW);
            }
            pos = [cur[0] + WINDOW, cur[1] + WINDOW];
        }
        self.run_ex(pos, [len[0] - pos[0], len[1] - pos[1]]);
    }

    /// Aligns a gap that has no anchors.
    fn run_ex(&mut self, start: [i64; 2], g: [i64; 2]) {
        if g[0] < 1 {
            self.add(RIGHT_ONLY, g[1]);
        } else if g[1] < 1 {
            self.add(LEFT_ONLY, g[0]);
        } else if self.kind == HexAlign::Fast {
            self.run_none(start, g);
        } else if g[0] < EXACT_LIMIT && g[1] < EXACT_LIMIT {
            let to32 = |s: usize| -> Vec<u32> {
                self.s[s][start[s] as usize..(start[s] + g[s]) as usize].iter().map(|&b| b as u32).collect()
            };
            let (x, y) = (to32(0), to32(1));
            for (op, n) in crate::align::myers_ops(&x, &y, false) {
                self.add(op, n as i64);
            }
        } else {
            self.run_range(start, [start[0] + g[0] - 1, start[1] + g[1] - 1], 10);
        }
    }

    /// Positional comparison of a gap; the longer side's excess becomes orphans.
    fn run_none(&mut self, start: [i64; 2], len: [i64; 2]) {
        let n = len[0].min(len[1]);
        let mut i = 0;
        while i < n {
            let eq = self.at(0, start[0] + i) == self.at(1, start[1] + i);
            let j0 = i;
            while i < n && (self.at(0, start[0] + i) == self.at(1, start[1] + i)) == eq {
                i += 1;
            }
            self.add(if eq { SAME } else { DIFF }, i - j0);
        }
        if len[0] > len[1] {
            self.add(LEFT_ONLY, len[0] - len[1]);
        } else if len[1] > len[0] {
            self.add(RIGHT_ONLY, len[1] - len[0]);
        }
    }

    /// Windowed search for `n`-byte matches in the inclusive ranges [p, e],
    /// recursing with halved match sizes between matches.
    fn run_range(&mut self, mut p: [i64; 2], e: [i64; 2], n: i64) {
        if !(p[0] <= e[0] || p[1] <= e[1]) {
            return;
        }
        if e[0] < p[0] {
            self.add(RIGHT_ONLY, e[1] - p[1] + 1);
            return;
        }
        if e[1] < p[1] {
            self.add(LEFT_ONLY, e[0] - p[0] + 1);
            return;
        }
        if n == 0 {
            let c = (e[0] - p[0] + 1).min(e[1] - p[1] + 1);
            self.add(DIFF, c);
            p[0] += c;
            p[1] += c;
            if p[1] <= e[1] {
                self.add(RIGHT_ONLY, e[1] - p[1] + 1);
            }
            if p[0] <= e[0] {
                self.add(LEFT_ONLY, e[0] - p[0] + 1);
            }
            return;
        }
        if p[0] == e[0] && p[1] == e[1] {
            let m = if self.at(0, p[0]) == self.at(1, p[1]) { SAME } else { DIFF };
            self.add(m, 1);
            return;
        }
        let half = (n / 2).max(0);
        loop {
            let mut a = p;
            let mut c = a;
            let mut ch = [self.at(0, c[0]), self.at(1, c[1])];
            let maxk = (e[0] - p[0]).max(e[1] - p[1]).max(-1).min(50);
            let mut k = 0i64;
            let mut found = false;
            loop {
                let j = c[1] - k;
                if a[1] <= j
                    && c[0] <= e[0] + 1 - n
                    && j <= e[1] - n + 1
                    && self.at(1, j) == ch[0]
                    && self.seq_eq([c[0], j], n)
                {
                    a = [c[0], j];
                    found = true;
                    break;
                }
                if k > 0 {
                    let j2 = c[0] - k;
                    if a[0] <= j2
                        && j2 <= e[0] - n
                        && c[1] <= e[1] - n
                        && self.at(0, j2) == ch[1]
                        && self.seq_eq([j2, c[1]], n)
                    {
                        a = [j2, c[1]];
                        found = true;
                        break;
                    }
                }
                k += 1;
                if maxk < k || (c[0] - k < a[0] && c[1] - k < a[1]) {
                    k = 0;
                    if c == e {
                        break;
                    }
                    for s in 0..2 {
                        if c[s] < e[s] {
                            c[s] += 1;
                            ch[s] = self.at(s, c[s]);
                        }
                    }
                }
                if !(c[0] - 1 + n <= e[0] || c[1] - 1 + n <= e[1]) {
                    break;
                }
            }
            if !found {
                self.run_range(p, e, half);
                return;
            }
            self.run_range(p, [a[0] - 1, a[1] - 1], half);
            self.add(SAME, n);
            p = [a[0] + n, a[1] + n];
            if e[0] < p[0] || e[1] < p[1] {
                self.run_range(p, e, 0);
                return;
            }
        }
    }

    fn seq_eq(&self, at: [i64; 2], n: i64) -> bool {
        (0..n).all(|i| self.at(0, at[0] + i) == self.at(1, at[1] + i))
    }
}

fn expmod(base: u32, exp: u32) -> u32 {
    match exp {
        0 => 1,
        1 => base & 0xffff,
        _ => {
            let r = expmod(base * base & 0xffff, exp / 2);
            if exp & 1 != 0 {
                r * base & 0xffff
            } else {
                r
            }
        }
    }
}

/// Files above this size are compared positionally without loading them whole.
pub const ALIGN_MEMORY_LIMIT: u64 = 256 << 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HexAlignment {
    pub left_size: u64,
    pub right_size: u64,
    pub align: HexAlign,
    /// Run-length map: [kind, count] with kind 0 same, 1 left only, 2 right only, 3 different.
    pub map: Vec<(u8, u64)>,
    /// Byte totals indexed by kind.
    pub counts: [u64; 4],
}

pub fn hex_align(left: &str, right: &str, align: HexAlign) -> io::Result<HexAlignment> {
    let ls = fs::metadata(left)?.len();
    let rs = fs::metadata(right)?.len();
    let big = ls.max(rs) > ALIGN_MEMORY_LIMIT;
    let align = if big { HexAlign::None } else { align };
    let map = if big {
        positional_map(left, right, ls, rs)?
    } else {
        align_bytes(&fs::read(left)?, &fs::read(right)?, align)
    };
    let mut counts = [0u64; 4];
    for &(k, n) in &map {
        counts[k as usize] += n;
    }
    Ok(HexAlignment { left_size: ls, right_size: rs, align, map, counts })
}

/// Streams both files and builds the positional (unaligned) map.
fn positional_map(left: &str, right: &str, ls: u64, rs: u64) -> io::Result<Vec<(u8, u64)>> {
    let mut fl = io::BufReader::with_capacity(1 << 16, fs::File::open(left)?);
    let mut fr = io::BufReader::with_capacity(1 << 16, fs::File::open(right)?);
    let mut bl = vec![0u8; 1 << 16];
    let mut br = vec![0u8; 1 << 16];
    let mut map: Vec<(u8, u64)> = Vec::new();
    let push = |m: &mut Vec<(u8, u64)>, k: u8, n: u64| {
        if n == 0 {
            return;
        }
        match m.last_mut() {
            Some((p, c)) if *p == k => *c += n,
            _ => m.push((k, n)),
        }
    };
    let common = ls.min(rs);
    let mut done = 0u64;
    while done < common {
        let want = ((common - done) as usize).min(bl.len());
        let nl = fill(&mut fl, &mut bl[..want])?;
        let nr = fill(&mut fr, &mut br[..want])?;
        let n = nl.min(nr);
        if n == 0 {
            break;
        }
        for i in 0..n {
            push(&mut map, if bl[i] == br[i] { SAME } else { DIFF }, 1);
        }
        done += n as u64;
    }
    push(&mut map, LEFT_ONLY, ls - done.min(ls));
    push(&mut map, RIGHT_ONLY, rs - done.min(rs));
    Ok(map)
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

    fn rle(m: &[(u8, u64)]) -> String {
        m.iter().map(|&(k, n)| format!("{}{}", ["S", "L", "R", "D"][k as usize], n)).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn aligns_insertion() {
        let a: Vec<u8> = (0..200u32).map(|i| (i * 7 % 251) as u8).collect();
        let mut b = a.clone();
        b.splice(100..100, [1u8, 2, 3]);
        assert_eq!(rle(&align_bytes(&a, &b, HexAlign::Complete)), "S100 R3 S100");
        assert_eq!(rle(&align_bytes(&a, &b, HexAlign::None)).split(' ').next(), Some("S100"));
    }

    #[test]
    fn positional_fallback_and_files() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a");
        let b = d.path().join("b");
        fs::write(&a, [1, 2, 3, 4, 5]).unwrap();
        fs::write(&b, [1, 9, 9, 4, 5, 6, 7]).unwrap();
        let (a, b) = (a.to_str().unwrap(), b.to_str().unwrap());
        assert_eq!(rle(&positional_map(a, b, 5, 7).unwrap()), "S1 D2 S2 R2");
        let h = hex_align(a, b, HexAlign::None).unwrap();
        assert_eq!(rle(&h.map), "S1 D2 S2 R2");
        assert_eq!(h.counts, [3, 0, 2, 2]);
        assert_eq!(read_bytes(b, 5, 10).unwrap(), vec![6, 7]);
    }
}
