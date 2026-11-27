/** A text position in Text Compare: aligned row index and UTF-16 column in that row's line. */
export interface TextPos {
  ri: number;
  col: number;
}

/** A character selection made by dragging in one pane. */
export interface TextSel {
  side: 0 | 1;
  anchor: TextPos;
  focus: TextPos;
}

export interface MapOptions {
  ignoreCase?: boolean;
  ignoreEmbeddedWs?: boolean;
}

/** Splits a line into word / whitespace-run / single punctuation tokens, like the comparison engine. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let tok = "";
  let prev = 0;
  for (const c of s) {
    const cls = /[\p{L}\p{N}_]/u.test(c) ? 1 : /\s/u.test(c) ? 2 : 3;
    if (tok && (cls !== prev || cls === 3)) {
      out.push(tok);
      tok = "";
    }
    tok += c;
    prev = cls;
  }
  if (tok) out.push(tok);
  return out;
}

/** Corresponding text ranges [sa, ea) in `src` and [sb, eb) in `dst`, covering both lines in order. */
interface Segment {
  sa: number;
  ea: number;
  sb: number;
  eb: number;
}

const MAX_CELLS = 250_000;

function segments(src: string, dst: string, o: MapOptions): Segment[] {
  const ta = tokenize(src);
  const tb = tokenize(dst);
  const key = (t: string) => {
    if (o.ignoreEmbeddedWs && !t.trim()) return " ";
    return o.ignoreCase ? t.toLowerCase() : t;
  };
  const ka = ta.map(key);
  const kb = tb.map(key);
  const pa = [0];
  for (const t of ta) pa.push(pa[pa.length - 1] + t.length);
  const pb = [0];
  for (const t of tb) pb.push(pb[pb.length - 1] + t.length);

  // Matched token pairs, in order.
  const pairs: [number, number][] = [];
  let lo = 0;
  while (lo < ka.length && lo < kb.length && ka[lo] === kb[lo]) pairs.push([lo, lo++]);
  let ha = ka.length;
  let hb = kb.length;
  const tail: [number, number][] = [];
  while (ha > lo && hb > lo && ka[ha - 1] === kb[hb - 1]) tail.unshift([--ha, --hb]);
  const n = ha - lo;
  const m = hb - lo;
  if (n > 0 && m > 0 && n * m <= MAX_CELLS) {
    // Longest common subsequence of the middle tokens, walked forward from a suffix table.
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i * w + j] = ka[lo + i] === kb[lo + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ka[lo + i] === kb[lo + j]) pairs.push([lo + i++, lo + j++]);
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
      else j++;
    }
  }
  pairs.push(...tail);

  const out: Segment[] = [];
  let [ia, ib] = [0, 0];
  for (const [x, y] of [...pairs, [ta.length, tb.length] as [number, number]]) {
    if (x > ia || y > ib) out.push({ sa: pa[ia], ea: pa[x], sb: pb[ib], eb: pb[y] });
    if (x < ta.length) out.push({ sa: pa[x], ea: pa[x + 1], sb: pb[y], eb: pb[y + 1] });
    [ia, ib] = [x + 1, y + 1];
  }
  return out;
}

/** Maps an offset inside a segment, keeping its common leading and trailing characters in place. */
function within(src: string, dst: string, g: Segment, k: number, edge: "start" | "end"): number {
  const a = src.slice(g.sa, g.ea);
  const b = dst.slice(g.sb, g.eb);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  if (k <= p) return g.sb + k;
  if (k >= a.length - q) return g.eb - (a.length - k);
  return edge === "start" ? g.sb + p : g.eb - q;
}

/**
 * Maps a column of `src` to the corresponding column of `dst`, an aligned version of the same line.
 * Unchanged text maps one to one; inside changed text, a selection start maps to the start of the
 * counterpart and an end to its end. Text only in `dst` at the position stays outside the selection.
 */
export function mapOffset(src: string, dst: string, offset: number, edge: "start" | "end", o: MapOptions = {}): number {
  const k = Math.max(0, Math.min(src.length, offset));
  if (edge === "start" && k === 0) return 0;
  if (edge === "end" && k === src.length) return dst.length;
  const segs = segments(src, dst, o).filter((g) => g.sa <= k && k <= g.ea);
  const g = edge === "start" ? segs[segs.length - 1] : segs[0];
  if (!g) return edge === "start" ? 0 : dst.length;
  if (g.sa === g.ea) return edge === "start" ? g.eb : g.sb;
  return within(src, dst, g, k - g.sa, edge);
}

/** Selection endpoints in document order. */
export function ordered(t: TextSel): [TextPos, TextPos] {
  const { anchor: a, focus: b } = t;
  return a.ri < b.ri || (a.ri === b.ri && a.col <= b.col) ? [a, b] : [b, a];
}
