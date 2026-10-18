//! Line alignment engine.
//!
//! Four strategies are provided:
//! * `Standard`  – weighted run scanning with a closeness-scored dynamic
//!   programming fallback (the default).
//! * `Unaligned` – the standard engine with a skew window of one line and no
//!   closeness scoring, so lines are only paired where they already line up.
//! * `Patience`  – unique-line anchoring, falling back to the standard engine
//!   for regions without unique anchors.
//! * `Myers`     – the O(ND) linear-space shortest-edit-script algorithm.
//!
//! The aligner works on per-line keys (`hash`) plus a little metadata per
//! line; it knows nothing about rules, which are applied by the caller when it
//! builds [`Side`].

/// Alignment strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlignKind {
    Unaligned,
    Standard,
    Myers,
    Patience,
}

impl AlignKind {
    pub fn parse(s: &str) -> AlignKind {
        match s {
            "none" | "unaligned" => AlignKind::Unaligned,
            "myers" => AlignKind::Myers,
            "patience" => AlignKind::Patience,
            _ => AlignKind::Standard,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Options {
    pub kind: AlignKind,
    /// Maximum number of lines scanned ahead when looking for matching runs.
    pub skew_tolerance: i32,
    /// Pair up lines by character similarity inside unmatched regions.
    pub use_closeness: bool,
    /// Never pair differing lines; they are shown as orphans instead.
    pub never_align_diffs: bool,
    /// Treat every unmatched line as important (blank lines included).
    pub orphans_always_sig: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            kind: AlignKind::Standard,
            skew_tolerance: 2000,
            use_closeness: true,
            never_align_diffs: false,
            orphans_always_sig: false,
        }
    }
}

/// Per-line data for one side.
/// Hash id reserved for empty lines. Patience never treats these as unique
/// anchors.
pub const EMPTY_HASH: u32 = u32::MAX;

pub struct Side<'a> {
    /// Line key: lines with equal keys are considered matching.
    pub hash: &'a [u32],
    /// Line contains at least one important character.
    pub sig: &'a [bool],
    /// Run weight of the line.
    pub weight: &'a [i32],
    /// Text used for closeness scoring.
    pub close: &'a [&'a [u8]],
    /// Byte length of the full line.
    pub full_len: &'a [usize],
}

impl Side<'_> {
    fn len(&self) -> i32 {
        self.hash.len() as i32
    }
}

pub type Pair = (Option<usize>, Option<usize>);

/// Weight of a line in run scoring.
pub fn weight_of(full_empty: bool, sig: bool) -> i32 {
    if full_empty {
        2
    } else if sig {
        70
    } else {
        31
    }
}

pub fn align(a: &Side, b: &Side, opts: &Options) -> Vec<Pair> {
    match opts.kind {
        AlignKind::Myers => myers_align(a.hash, b.hash, opts.never_align_diffs),
        _ => Smart::new(a, b, opts).run(),
    }
}

// ---------------------------------------------------------------------------
// Standard / Unaligned / Patience
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct Run {
    len: i32,
    score: i32,
    i: i32,
    j: i32,
}

struct BigRun {
    i: i32,
    j: i32,
    len: i32,
}

struct Smart<'a> {
    a: &'a Side<'a>,
    b: &'a Side<'a>,
    na: i32,
    nb: i32,
    skew: i32,
    use_close: bool,
    never_align: bool,
    oas: bool,
    patience: bool,
    out: Vec<Pair>,
    runs: Vec<Run>,
    visited: Vec<bool>,
    vis_a: i32,
    vis_b: i32,
    vis_cols: i32,
    hist: Vec<Option<Vec<(u8, u32)>>>,
}

impl<'a> Smart<'a> {
    fn new(a: &'a Side<'a>, b: &'a Side<'a>, o: &Options) -> Self {
        let aligned = o.kind != AlignKind::Unaligned;
        let (skew, use_close) = if aligned {
            (o.skew_tolerance.max(1), o.use_closeness && !o.never_align_diffs)
        } else {
            (1, false)
        };
        Smart {
            a,
            b,
            na: a.len(),
            nb: b.len(),
            skew,
            use_close,
            never_align: o.never_align_diffs,
            oas: o.orphans_always_sig,
            patience: o.kind == AlignKind::Patience,
            out: Vec::with_capacity(a.hash.len().max(b.hash.len()) + 8),
            runs: Vec::new(),
            visited: Vec::new(),
            vis_a: 0,
            vis_b: 0,
            vis_cols: 0,
            hist: vec![None; a.hash.len() + b.hash.len()],
        }
    }

    fn run(mut self) -> Vec<Pair> {
        let (ea, eb) = (self.na - 1, self.nb - 1);
        self.sp1(0, 0, ea, eb);
        self.out
    }

    fn add(&mut self, l: i32, r: i32, cnt: i32) {
        for k in 0..cnt.max(0) {
            let lv = if l >= 0 { Some((l + k) as usize) } else { None };
            let rv = if r >= 0 { Some((r + k) as usize) } else { None };
            self.out.push((lv, rv));
        }
    }

    #[inline]
    fn heq(&self, i: i32, j: i32) -> bool {
        self.a.hash[i as usize] == self.b.hash[j as usize]
    }

    fn sp1(&mut self, mut i: i32, mut j: i32, ea: i32, eb: i32) {
        let (mut ga, mut gb) = (-1i32, -1i32);
        while i <= ea && j <= eb {
            let sa = self.a.sig[i as usize];
            let sb = self.b.sig[j as usize];
            if !sa && !sb {
                if ga < 0 && gb < 0 && self.heq(i, j) {
                    self.add(i, j, 1);
                } else {
                    if ga < 0 {
                        ga = i;
                    }
                    if gb < 0 {
                        gb = j;
                    }
                }
                i += 1;
                j += 1;
            } else if !sa {
                if self.oas {
                    break;
                }
                if ga < 0 {
                    ga = i;
                }
                i += 1;
            } else if !sb {
                if self.oas {
                    break;
                }
                if gb < 0 {
                    gb = j;
                }
                j += 1;
            } else {
                if !self.heq(i, j) {
                    break;
                }
                if ga >= 0 || gb >= 0 {
                    if ga < 0 {
                        ga = i;
                    }
                    if gb < 0 {
                        gb = j;
                    }
                    self.sp2(ga, gb, i - 1, j - 1);
                    ga = -1;
                    gb = -1;
                }
                self.add(i, j, 1);
                i += 1;
                j += 1;
            }
        }
        if ga >= 0 {
            i = ga;
        }
        if gb >= 0 {
            j = gb;
        }
        self.sp2(i, j, ea, eb);
    }

    fn sp2(&mut self, a: i32, b: i32, ea: i32, eb: i32) {
        if self.patience {
            self.patience_align(a, b, ea, eb);
        } else {
            self.smart_sp2(a, b, ea, eb);
        }
    }

    fn smart_sp2(&mut self, mut a: i32, mut b: i32, ea: i32, eb: i32) {
        let partial = ea == self.na - 1 || eb == self.nb - 1;
        loop {
            let (mut ta, mut tb) = (ea, eb);
            if a > ea {
                if b > eb {
                    return;
                }
                tb = eb.min(b + 199);
                self.add(-1, b, tb - b + 1);
            } else if b > eb {
                ta = ea.min(a + 199);
                self.add(a, -1, ta - a + 1);
            } else {
                self.scan_for_good_enough(a, b, &mut ta, &mut tb, partial);
            }
            a = (ta + 1).max(a);
            b = (tb + 1).max(b);
        }
    }

    fn scan_for_good_enough(&mut self, a: i32, b: i32, ea: &mut i32, eb: &mut i32, partial: bool) {
        *ea = (*ea).min(a + self.skew - 1);
        *eb = (*eb).min(b + self.skew - 1);
        self.runs.clear();
        self.vis_a = a;
        self.vis_b = b;
        self.vis_cols = *eb - b + 1;
        self.visited.clear();
        self.visited.resize(((*ea - a + 1) * self.vis_cols) as usize, false);
        let res = (|| -> Result<(), BigRun> {
            self.run_test(a, b, *ea, *eb, partial)?;
            let (mut x, mut y) = (a, b);
            loop {
                if y < *eb {
                    y += 1;
                }
                if x < *ea {
                    x += 1;
                }
                let mut dc = x;
                while dc >= a {
                    self.run_test(dc, y, *ea, *eb, partial)?;
                    dc -= 1;
                }
                let mut dc = y - 1;
                while dc >= b {
                    self.run_test(x, dc, *ea, *eb, partial)?;
                    dc -= 1;
                }
                if !(x < *ea || y < *eb) {
                    break;
                }
            }
            Ok(())
        })();
        match res {
            Ok(()) => self.sp3(a, b, ea, eb, partial),
            Err(big) => {
                let (mut ta, mut tb) = (big.i - 1, big.j - 1);
                self.sp3(a, b, &mut ta, &mut tb, false);
                let (mut x, mut y) = (big.i + big.len, big.j + big.len);
                let (mut si, mut sj, mut l) = (big.i, big.j, big.len);
                loop {
                    if x > *ea || y > *eb {
                        break;
                    }
                    if l > 500 {
                        self.add(si, sj, l);
                        l = 0;
                        si = x;
                        sj = y;
                    }
                    if !self.heq(x, y) {
                        break;
                    }
                    l += 1;
                    x += 1;
                    y += 1;
                }
                if l > 0 {
                    self.add(si, sj, l);
                }
                *ea = si + l - 1;
                *eb = sj + l - 1;
            }
        }
        self.runs.clear();
        self.visited.clear();
    }

    fn vis_idx(&self, i: i32, j: i32) -> usize {
        ((i - self.vis_a) * self.vis_cols + (j - self.vis_b)) as usize
    }

    fn run_test(&mut self, i0: i32, j0: i32, ea: i32, eb: i32, _partial: bool) -> Result<(), BigRun> {
        if self.visited[self.vis_idx(i0, j0)] {
            return Ok(());
        }
        let (mut i, mut j, mut len, mut w) = (i0, j0, 0i32, 0i32);
        while self.heq(i, j) {
            w += self.a.weight[i as usize];
            len += 1;
            i += 1;
            j += 1;
            if w > 4999 {
                return Err(BigRun { i: i0, j: j0, len });
            }
            if i > ea || j > eb {
                break;
            }
        }
        let (mut ci, mut cj) = (i0, j0);
        for _ in 0..=len {
            let idx = self.vis_idx(ci, cj);
            self.visited[idx] = true;
            ci += 1;
            cj += 1;
            if ci > ea || cj > eb {
                break;
            }
        }
        if w > 500 {
            self.runs.push(Run { len, score: w, i: i0, j: j0 });
        }
        Ok(())
    }

    fn recalc(&self, r: &mut Run) {
        let mut s = 0;
        for k in 0..r.len.max(0) {
            s += self.a.weight[(r.i + k) as usize];
        }
        r.score = if s < 500 { 0 } else { s };
    }

    fn sp3(&mut self, a: i32, b: i32, ea: &mut i32, eb: &mut i32, partial: bool) {
        let mut runs = std::mem::take(&mut self.runs);
        if !partial {
            for r in runs.iter_mut() {
                if *ea < r.i + r.len || *eb < r.j + r.len {
                    r.len = r.len.min(*ea - r.i);
                    r.len = r.len.min(*eb - r.j);
                    self.recalc(r);
                }
            }
        }
        let score_cmp = |x: &Run, y: &Run| y.score.cmp(&x.score).then(x.j.cmp(&y.j)).then(x.i.cmp(&y.i));
        runs.sort_by(score_cmp);
        let n = runs.len();
        for u in 0..n {
            let r = runs[u];
            if r.score <= 0 {
                continue;
            }
            let (rei, rej) = (r.i + r.len - 1, r.j + r.len - 1);
            let mut changed = false;
            for p in runs.iter_mut().skip(u + 1) {
                if p.score <= 0 {
                    continue;
                }
                let (pei, pej) = (p.i + p.len - 1, p.j + p.len - 1);
                if (p.i <= rei || p.j <= rej) && (r.i <= pei || r.j <= pej) {
                    if p.i < r.i && p.j < r.j && pei < rei && pej < rej {
                        p.len = (r.i - p.i).min(r.j - p.j);
                        self.recalc(p);
                        changed = true;
                    } else if r.i < p.i && r.j < p.j && rei < pei && rej < pej {
                        let k = (rej - p.j + 1).max(rei + 1 - p.i);
                        p.len -= k;
                        p.i += k;
                        p.j += k;
                        self.recalc(p);
                        changed = true;
                    } else {
                        p.score = -1;
                    }
                }
            }
            if changed {
                runs[u + 1..].sort_by(score_cmp);
            }
        }
        runs.sort_by(|x, y| x.j.cmp(&y.j).then(x.i.cmp(&y.i)));
        let (mut ca, mut cb) = (a, b);
        let mut kept = 0;
        for r in runs.iter().filter(|r| r.score > 0) {
            kept += 1;
            let (mut ga, mut gb) = (r.i - 1, r.j - 1);
            if ca <= ga || cb <= gb {
                self.sp4(ca, cb, &mut ga, &mut gb, false);
            }
            self.add(r.i, r.j, r.len);
            ca = r.i + r.len;
            cb = r.j + r.len;
        }
        if kept > 0 && partial {
            *ea = ca - 1;
            *eb = cb - 1;
        } else if ca <= *ea || cb <= *eb {
            let p = ca <= *ea && partial && cb <= *eb;
            self.sp4(ca, cb, ea, eb, p);
        }
    }

    fn sp4(&mut self, a: i32, b: i32, ea: &mut i32, eb: &mut i32, partial: bool) {
        if *ea < a {
            self.add(-1, b, *eb - b + 1);
            return;
        }
        if *eb < b {
            self.add(a, -1, *ea - a + 1);
            return;
        }
        let n = (*ea - a + 1) as usize;
        let m = (*eb - b + 1) as usize;
        let mut f: Vec<i64> = (0..=n).map(|i| -20 * i as i64).collect();
        let mut dir = vec![0u8; (n + 1) * (m + 1)];
        for i in 1..=n {
            dir[i * (m + 1)] = 1;
        }
        for j in 1..=m {
            dir[j] = 2;
        }
        for j in 1..=m {
            let mut diag = f[0];
            f[0] -= 20;
            let rj = *eb - j as i32 + 1;
            for i in 1..=n {
                let c = self.closeness(*ea - i as i32 + 1, rj) as i64;
                let mut v = diag + c;
                let mut d = 3u8;
                if v < f[i - 1] - 20 {
                    d = 1;
                    v = f[i - 1] - 20;
                }
                if v < f[i] - 20 {
                    d = 2;
                    v = f[i] - 20;
                }
                diag = f[i];
                f[i] = v;
                dir[i * (m + 1) + j] = d;
            }
        }
        let (mut i, mut j) = (n, m);
        let mut group: Option<(u8, i32, i32, i32)> = None;
        while (!partial || (i != 0 && j != 0)) && (i != 0 || j != 0) {
            let d = dir[i * (m + 1) + j];
            let (l, r) = match d {
                3 => (*ea - i as i32 + 1, *eb - j as i32 + 1),
                2 => (-1, *eb - j as i32 + 1),
                _ => (*ea - i as i32 + 1, -1),
            };
            match &mut group {
                Some((gd, _, _, cnt)) if *gd == d => *cnt += 1,
                _ => {
                    if let Some((_, gl, gr, cnt)) = group.take() {
                        self.add(gl, gr, cnt);
                    }
                    group = Some((d, l, r, 1));
                }
            }
            match d {
                3 => {
                    i -= 1;
                    j -= 1;
                }
                2 => j -= 1,
                _ => i -= 1,
            }
        }
        if let Some((_, gl, gr, cnt)) = group {
            self.add(gl, gr, cnt);
        }
        if partial {
            *ea -= i as i32;
            *eb -= j as i32;
        }
    }

    fn ensure_hist(&mut self, slot: usize, text: &[u8]) {
        if self.hist[slot].is_none() {
            let mut counts = [0u32; 256];
            for &c in text {
                counts[c as usize] += 1;
            }
            self.hist[slot] = Some((0..256).filter(|&k| counts[k] > 0).map(|k| (k as u8, counts[k])).collect());
        }
    }

    /// Number of bytes of the right line that can be matched by bytes of the left line.
    fn raw_closeness(&mut self, i: usize, j: usize) -> i64 {
        let sa = i;
        let sb = self.a.hash.len() + j;
        self.ensure_hist(sa, self.a.close[i]);
        self.ensure_hist(sb, self.b.close[j]);
        let ha = self.hist[sa].as_ref().unwrap();
        let hb = self.hist[sb].as_ref().unwrap();
        let (mut x, mut y, mut s) = (0usize, 0usize, 0i64);
        while x < ha.len() && y < hb.len() {
            match ha[x].0.cmp(&hb[y].0) {
                std::cmp::Ordering::Less => x += 1,
                std::cmp::Ordering::Greater => y += 1,
                std::cmp::Ordering::Equal => {
                    s += ha[x].1.min(hb[y].1) as i64;
                    x += 1;
                    y += 1;
                }
            }
        }
        s
    }

    fn closeness(&mut self, i: i32, j: i32) -> i32 {
        let (iu, ju) = (i as usize, j as usize);
        if self.heq(i, j) {
            let (la, lb) = (self.a.full_len[iu], self.b.full_len[ju]);
            if la == 0 || lb == 0 {
                return -10;
            }
            let mut v = 2 * (self.a.weight[iu] + self.b.weight[ju]);
            if la != lb {
                v -= 1;
            }
            return v;
        }
        if !self.use_close {
            return if self.never_align { -5000 } else { -18 };
        }
        let la = self.a.close[iu].len() as i64;
        let lb = self.b.close[ju].len() as i64;
        if la == 0 || lb == 0 {
            return (-4 * (la + lb) - 1).min(-11).max(-40) as i32;
        }
        let raw = self.raw_closeness(iu, ju);
        let v = raw * 3 - la - lb;
        if v < 1 {
            (4 * v - 1).max(-40) as i32
        } else {
            (v * 25 / la.min(lb)) as i32
        }
    }

    // --- Patience -------------------------------------------------------

    fn patience_align(&mut self, mut a: i32, mut b: i32, mut ea: i32, mut eb: i32) {
        let mut k = 0;
        while a + k <= ea && b + k <= eb && self.heq(a + k, b + k) {
            k += 1;
        }
        self.add(a, b, k);
        a += k;
        b += k;
        let mut s = 0;
        while ea - s >= a && eb - s >= b && self.heq(ea - s, eb - s) {
            s += 1;
        }
        ea -= s;
        eb -= s;
        if ea < a || eb < b {
            self.add(a, -1, ea - a + 1);
            self.add(-1, b, eb - b + 1);
            self.add(ea + 1, eb + 1, s);
            return;
        }

        use std::collections::HashMap;
        let mut left: HashMap<u32, i32> = HashMap::new();
        let mut dup_count = 0;
        for i in a..=ea {
            let h = self.a.hash[i as usize];
            if h == EMPTY_HASH {
                continue;
            }
            match left.get_mut(&h) {
                Some(v) => {
                    if *v != -1 {
                        *v = -1;
                    }
                    dup_count += 1;
                }
                None => {
                    left.insert(h, i);
                }
            }
        }
        // hash -> first right index seen
        let mut first_right: HashMap<u32, i32> = HashMap::new();
        let mut matched: Vec<i32> = vec![-1; (eb - b + 1) as usize];
        for j in b..=eb {
            let h = self.b.hash[j as usize];
            let Some(&li) = left.get(&h) else { continue };
            if li == -1 {
                continue;
            }
            match first_right.get(&h) {
                None => {
                    first_right.insert(h, j);
                    matched[(j - b) as usize] = li;
                }
                Some(&fj) => {
                    matched[(fj - b) as usize] = -1;
                    left.remove(&h);
                }
            }
        }
        // Longest increasing subsequence of left indices over right order.
        let mut pile_top: Vec<i32> = Vec::new(); // left index on top of each pile
        let mut pile_j: Vec<i32> = Vec::new(); // right index on top of each pile
        let mut back: Vec<i32> = vec![-1; (eb - b + 1) as usize];
        for j in b..=eb {
            let v = matched[(j - b) as usize];
            if v < 0 {
                continue;
            }
            let pos = pile_top.partition_point(|&t| t < v);
            if pos > 0 {
                back[(j - b) as usize] = pile_j[pos - 1];
            }
            if pos == pile_top.len() {
                pile_top.push(v);
                pile_j.push(j);
            } else {
                pile_top[pos] = v;
                pile_j[pos] = j;
            }
        }
        if pile_top.is_empty() {
            if !self.use_close {
                let n = (eb - b).min(ea - a) + 1;
                if !self.never_align {
                    self.add(a, b, n);
                    a += n;
                    b += n;
                }
                self.add(a, -1, ea - a + 1);
                self.add(-1, b, eb - b + 1);
            } else if dup_count <= 1000 && (eb - b).max(ea - a) <= 5000 {
                let (mut ta, mut tb) = (ea, eb);
                self.sp4(a, b, &mut ta, &mut tb, false);
            } else {
                self.smart_sp2(a, b, ea, eb);
            }
        } else {
            let mut chain: Vec<(i32, i32)> = Vec::new();
            let mut j = *pile_j.last().unwrap();
            while j >= 0 {
                chain.push((matched[(j - b) as usize], j));
                j = back[(j - b) as usize];
            }
            chain.reverse();
            for (mi, mj) in chain {
                if a < mi || b < mj {
                    self.patience_align(a, b, mi - 1, mj - 1);
                }
                self.add(mi, mj, 1);
                a = mi + 1;
                b = mj + 1;
            }
            self.patience_align(a, b, ea, eb);
        }
        self.add(ea + 1, eb + 1, s);
    }
}

// ---------------------------------------------------------------------------
// Myers O(ND)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum ChangeKind {
    Add,
    Del,
    Mod,
}

#[derive(Clone, Copy, Debug)]
struct Change {
    kind: ChangeKind,
    x: i32,
    y: i32,
    range: i32,
}

struct Myers<'a> {
    a: &'a [u32],
    b: &'a [u32],
    fv: Vec<i32>,
    bv: Vec<i32>,
    off: i32,
    max_d: i32,
    changes: Vec<Change>,
    last_add: Option<Change>,
    last_del: Option<Change>,
    last_mod: Option<Change>,
}

impl Myers<'_> {
    #[inline]
    fn f(&self, k: i32) -> i32 {
        self.fv[(k + self.off) as usize]
    }
    #[inline]
    fn set_f(&mut self, k: i32, v: i32) {
        let i = (k + self.off) as usize;
        self.fv[i] = v;
    }
    #[inline]
    fn bk(&self, k: i32) -> i32 {
        self.bv[(k + self.off) as usize]
    }
    #[inline]
    fn set_b(&mut self, k: i32, v: i32) {
        let i = (k + self.off) as usize;
        self.bv[i] = v;
    }

    fn push_mod(&mut self) {
        if let Some(c) = self.last_mod.take() {
            self.changes.push(c);
        }
    }
    fn push_add(&mut self) {
        self.push_mod();
        if let Some(c) = self.last_add.take() {
            self.changes.push(c);
        }
    }
    fn push_del(&mut self) {
        self.push_mod();
        if let Some(c) = self.last_del.take() {
            self.changes.push(c);
        }
    }

    fn add(&mut self, x: i32, y: i32) {
        if let Some(la) = self.last_add.as_mut() {
            if x == la.x && la.y + la.range == y {
                la.range += 1;
                return;
            }
            self.push_add();
            self.last_add = Some(Change { kind: ChangeKind::Add, x, y, range: 1 });
            return;
        }
        let Some(ld) = self.last_del else {
            self.last_add = Some(Change { kind: ChangeKind::Add, x, y, range: 1 });
            return;
        };
        if x == ld.x {
            match self.last_mod.as_mut() {
                Some(m) if m.x + m.range - 1 == x && m.y - 1 + m.range == y => m.range += 1,
                _ => {
                    self.push_mod();
                    self.last_mod = Some(Change { kind: ChangeKind::Mod, x, y, range: 1 });
                }
            }
            let ld = self.last_del.as_mut().unwrap();
            if ld.range == 1 {
                self.last_del = None;
            } else {
                ld.range -= 1;
                ld.x += 1;
            }
            return;
        }
        self.push_del();
        self.last_add = Some(Change { kind: ChangeKind::Add, x, y, range: 1 });
    }

    fn delete(&mut self, x: i32) {
        if let Some(ld) = self.last_del.as_mut() {
            if ld.range + ld.x == x {
                ld.range += 1;
            } else {
                self.push_del();
                self.last_del = Some(Change { kind: ChangeKind::Del, x, y: 0, range: 1 });
            }
            return;
        }
        let Some(la) = self.last_add else {
            self.last_del = Some(Change { kind: ChangeKind::Del, x, y: 0, range: 1 });
            return;
        };
        if x == la.x {
            match self.last_mod.as_mut() {
                Some(m) if m.range + m.x == x => m.range += 1,
                _ => {
                    self.push_mod();
                    self.last_mod = Some(Change { kind: ChangeKind::Mod, x, y: la.y, range: 1 });
                }
            }
            let la = self.last_add.as_mut().unwrap();
            if la.range == 1 {
                self.last_add = None;
            } else {
                la.range -= 1;
                la.x += 1;
                la.y += 1;
            }
        } else {
            self.push_add();
            self.last_del = Some(Change { kind: ChangeKind::Del, x, y: 0, range: 1 });
        }
    }

    fn add_to_script(&mut self, x1: i32, y1: i32, x2: i32, y2: i32, kind: u8) {
        match kind {
            0 => {
                for y in y1..y2 {
                    self.add(x1, y);
                }
            }
            1 => {
                for x in x1..x2 {
                    self.delete(x);
                }
            }
            _ => {
                self.add(x1, y1);
                self.delete(x2 - 1);
            }
        }
    }

    fn eq(&self, x: i32, y: i32) -> bool {
        self.a[x as usize] == self.b[y as usize]
    }

    fn recursive_diff(&mut self, x1: i32, y1: i32, x2: i32, y2: i32) -> bool {
        if x1 == x2 {
            self.add_to_script(x1, y1, x2, y2, 0);
            return true;
        }
        if y1 == y2 {
            self.add_to_script(x1, y1, x2, y2, 1);
            return true;
        }
        let n = x2 - x1;
        let m = y2 - y1;
        let delta = n - m;
        self.set_f(0, x1);
        self.set_b(delta, x2);
        self.set_f(n, x2);
        self.set_b(n, x2);
        if delta > 0 {
            self.set_f(-m - 1, x1);
            self.set_b(-m - 1, x1);
        }
        let max_d = self.max_d;
        let mut d = 0;
        while d < max_d {
            d += 1;
            // forward
            let mut k = -d;
            while k < -m {
                k += 2;
            }
            let kmax = d.min(n - 1);
            while k <= kmax {
                let mut x = if k == -d || (k < d && self.f(k - 1) < self.f(k + 1)) {
                    self.f(k + 1)
                } else {
                    self.f(k - 1) + 1
                };
                let mut y = x - x1 + y1 - k;
                while x < x2 && y < y2 && self.eq(x, y) {
                    x += 1;
                    y += 1;
                }
                self.set_f(k, x);
                if delta & 1 != 0 && delta - d < k && k < d + delta && self.bk(k) <= self.f(k) {
                    let (mut xs, mut ys) = (x, y);
                    while x1 < xs && y1 < ys && self.eq(xs - 1, ys - 1) {
                        xs -= 1;
                        ys -= 1;
                    }
                    if !self.recursive_diff(x1, y1, xs, ys) {
                        return false;
                    }
                    return self.recursive_diff(x, y, x2, y2);
                }
                k += 2;
            }
            // backward
            let mut k = delta - d;
            while k < -m {
                k += 2;
            }
            let kmax = (d + delta).min(n - 1);
            while k <= kmax {
                let mut x = if k == d + delta || (delta - d < k && self.bk(k - 1) < self.bk(k + 1)) {
                    self.bk(k - 1)
                } else {
                    self.bk(k + 1) - 1
                };
                let mut y = x - x1 + y1 - k;
                while x1 < x && y1 < y && self.eq(x - 1, y - 1) {
                    x -= 1;
                    y -= 1;
                }
                self.set_b(k, x);
                if delta & 1 == 0 && -d <= k && k <= d && self.bk(k) <= self.f(k) {
                    if x1 + 1 == x2 && y1 + 1 == y2 {
                        self.add_to_script(x1, y1, x2, y2, 2);
                        return true;
                    }
                    if !self.recursive_diff(x1, y1, x, y) {
                        return false;
                    }
                    let (mut xs, mut ys) = (x, y);
                    while xs < x2 && ys < y2 && self.eq(xs, ys) {
                        xs += 1;
                        ys += 1;
                    }
                    return self.recursive_diff(xs, ys, x2, y2);
                }
                k += 2;
            }
        }
        false
    }
}

/// Run-length Myers edit script: (op, count) with op 0 = paired same,
/// 1 = left only, 2 = right only, 3 = paired change.
pub(crate) fn myers_ops(a: &[u32], b: &[u32], never_align: bool) -> Vec<(u8, usize)> {
    let (na, nb) = (a.len(), b.len());
    let mut out: Vec<(u8, usize)> = Vec::new();
    let push = |out: &mut Vec<(u8, usize)>, op: u8, n: usize| {
        if n == 0 {
            return;
        }
        match out.last_mut() {
            Some((o, c)) if *o == op => *c += n,
            _ => out.push((op, n)),
        }
    };
    if na == 0 || nb == 0 {
        push(&mut out, 1, na);
        push(&mut out, 2, nb);
        return out;
    }
    if a == b {
        push(&mut out, 0, na);
        return out;
    }
    let max_d = (na.max(nb) as i32).min(0xffffff);
    let off = nb as i32 + 2;
    let size = (na + nb) as usize + 6;
    let mut md = Myers {
        a,
        b,
        fv: vec![0; size],
        bv: vec![0; size],
        off,
        max_d,
        changes: Vec::new(),
        last_add: None,
        last_del: None,
        last_mod: None,
    };
    // Trim common prefix/suffix.
    let (mut s, mut t) = (0usize, 0usize);
    while s < na && t < nb && a[s] == b[t] {
        s += 1;
        t += 1;
    }
    let (mut e, mut f) = (na, nb);
    while e > s && f > t && a[e - 1] == b[f - 1] {
        e -= 1;
        f -= 1;
    }
    let ok = if e <= s && f <= t { true } else { md.recursive_diff(s as i32, t as i32, e as i32, f as i32) };
    md.push_add();
    md.push_del();
    let changes = if ok { std::mem::take(&mut md.changes) } else { Vec::new() };

    let (mut lp, mut rp) = (0usize, 0usize);
    for c in changes {
        let x = c.x.max(0) as usize;
        if lp < x {
            push(&mut out, 0, x - lp);
            rp += x - lp;
            lp = x;
        }
        let r = c.range.max(0) as usize;
        match c.kind {
            ChangeKind::Add => {
                push(&mut out, 2, r);
                rp += r;
            }
            ChangeKind::Del => {
                push(&mut out, 1, r);
                lp += r;
            }
            ChangeKind::Mod => {
                if never_align {
                    push(&mut out, 1, r);
                    push(&mut out, 2, r);
                } else {
                    push(&mut out, 3, r);
                }
                lp += r;
                rp += r;
            }
        }
    }
    // Pair whatever remains (common suffix), then flush any leftovers.
    let rest = (na - lp.min(na)).min(nb - rp.min(nb));
    push(&mut out, 0, rest);
    lp += rest;
    rp += rest;
    push(&mut out, 1, na.saturating_sub(lp));
    push(&mut out, 2, nb.saturating_sub(rp));
    out
}

fn myers_align(a: &[u32], b: &[u32], never_align: bool) -> Vec<Pair> {
    let mut out: Vec<Pair> = Vec::with_capacity(a.len().max(b.len()));
    let (mut lp, mut rp) = (0usize, 0usize);
    for (op, n) in myers_ops(a, b, never_align) {
        for _ in 0..n {
            match op {
                1 => {
                    out.push((Some(lp), None));
                    lp += 1;
                }
                2 => {
                    out.push((None, Some(rp)));
                    rp += 1;
                }
                _ => {
                    out.push((Some(lp), Some(rp)));
                    lp += 1;
                    rp += 1;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn myers_rows(a: &[u32], b: &[u32]) -> Vec<Pair> {
        myers_align(a, b, false)
    }

    fn check_cover(rows: &[Pair], na: usize, nb: usize) {
        let ls: Vec<usize> = rows.iter().filter_map(|r| r.0).collect();
        let rs: Vec<usize> = rows.iter().filter_map(|r| r.1).collect();
        assert_eq!(ls, (0..na).collect::<Vec<_>>());
        assert_eq!(rs, (0..nb).collect::<Vec<_>>());
    }

    #[test]
    fn myers_covers_all_lines() {
        let a = [1, 2, 3, 4, 5, 6, 7];
        let b = [1, 9, 3, 4, 8, 8, 6, 7, 10];
        let rows = myers_rows(&a, &b);
        check_cover(&rows, a.len(), b.len());
        // Matching lines stay paired.
        assert!(rows.contains(&(Some(0), Some(0))));
        assert!(rows.contains(&(Some(2), Some(2))));
        assert!(rows.contains(&(Some(5), Some(6))));
        assert!(rows.contains(&(Some(6), Some(7))));
    }

    #[test]
    fn myers_pairs_single_replacement() {
        let rows = myers_rows(&[1, 2, 3], &[1, 5, 3]);
        assert_eq!(rows, vec![(Some(0), Some(0)), (Some(1), Some(1)), (Some(2), Some(2))]);
    }
}
