// The user manual (docs/manual, also published as a website) bundled for the in-app help:
// navigation from mkdocs.yml, Markdown rendering with the website's heading anchors, and a full-text index.
import { Marked } from "marked";
import mkdocsYml from "../../mkdocs.yml?raw";

const sources = import.meta.glob("../../docs/manual/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const images = import.meta.glob("../../docs/manual/images/*", { query: "?url", import: "default", eager: true }) as Record<string, string>;

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const SOURCES = new Map(Object.entries(sources).map(([p, s]) => [baseName(p), s]));
const IMAGES = new Map(Object.entries(images).map(([p, u]) => [baseName(p), u]));

export const ONLINE_MANUAL = /^site_url:\s*(\S+)/m.exec(mkdocsYml)?.[1] ?? "";

export interface NavItem {
  title: string;
  file?: string;
  children: NavItem[];
}

/** The `nav:` tree of mkdocs.yml. */
function parseNav(yml: string): NavItem[] {
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^nav:\s*$/.test(l));
  const root: NavItem[] = [];
  const stack: { indent: number; items: NavItem[] }[] = [{ indent: -1, items: root }];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^(\s*)- (.+?):\s*(\S+\.md)?\s*$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const item: NavItem = { title: m[2], file: m[3], children: [] };
    stack[stack.length - 1].items.push(item);
    if (!m[3]) stack.push({ indent, items: item.children });
  }
  return root;
}

export const NAV = parseNav(mkdocsYml);

/** Pages in navigation order (pages missing from the navigation follow). */
export const PAGE_ORDER: string[] = (() => {
  const out: string[] = [];
  const walk = (items: NavItem[]) => items.forEach((i) => (i.file && SOURCES.has(i.file) && out.push(i.file), walk(i.children)));
  walk(NAV);
  for (const f of [...SOURCES.keys()].sort()) if (!out.includes(f)) out.push(f);
  return out;
})();

/** Heading anchors as the website generates them. */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-");
}

function uniqueId(id: string, used: Set<string>): string {
  while (used.has(id) || !id) {
    const m = /^(.*)_(\d+)$/.exec(id);
    id = m ? `${m[1]}_${Number(m[2]) + 1}` : `${id}_1`;
  }
  used.add(id);
  return id;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const htmlText = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e]);
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);

/** `!!! type "title"` blocks with an indented body become HTML boxes around Markdown. */
function admonitions(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : /^!!!\s+(\w+)(?:\s+"([^"]*)")?\s*$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const body: string[] = [];
    while (i + 1 < lines.length && (/^ {4}/.test(lines[i + 1]) || (lines[i + 1].trim() === "" && /^ {4}/.test(lines[i + 2] ?? "")))) {
      body.push(lines[++i].slice(4));
    }
    const title = m[2] ?? m[1][0].toUpperCase() + m[1].slice(1);
    out.push(`<div class="admonition ${m[1]}">`, title ? `<p class="admonition-title">${escapeHtml(title)}</p>` : "", "", ...body, "", "</div>", "");
  }
  return out.join("\n");
}

export interface Section {
  file: string;
  /** Heading anchor; empty for the start of the page. */
  id: string;
  /** Heading level (1 for the start of the page). */
  level: number;
  title: string;
  pageTitle: string;
  text: string;
}

export interface Page {
  file: string;
  title: string;
  html: string;
  sections: Section[];
}

const pages = new Map<string, Page>();

export function hasPage(file: string): boolean {
  return SOURCES.has(file);
}

export function imageUrl(src: string): string | undefined {
  return src.startsWith("images/") ? IMAGES.get(src.slice(7)) : undefined;
}

export function page(file: string): Page | undefined {
  const cached = pages.get(file);
  if (cached) return cached;
  const src = SOURCES.get(file);
  if (src === undefined) return undefined;
  const used = new Set<string>();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${uniqueId(slugify(htmlText(inner)), used)}">${inner}</h${depth}>\n`;
      },
    },
  });
  const html = marked.parse(admonitions(src), { async: false }) as string;
  // Sections for the search index: the text under each heading.
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const title = doc.querySelector("h1")?.textContent?.trim() || file.replace(/\.md$/, "");
  const sections: Section[] = [];
  let cur: Section = { file, id: "", level: 1, title, pageTitle: title, text: "" };
  for (const el of Array.from(doc.body.children)) {
    if (/^H[1-6]$/.test(el.tagName)) {
      if (el.tagName === "H1") continue;
      sections.push(cur);
      cur = { file, id: el.id, level: Number(el.tagName[1]), title: el.textContent?.trim() ?? "", pageTitle: title, text: "" };
      continue;
    }
    cur.text += (el.textContent ?? "").replace(/\s+/g, " ").trim() + " ";
  }
  sections.push(cur);
  for (const s of sections) s.text = s.text.trim();
  const p: Page = { file, title, html, sections };
  pages.set(file, p);
  return p;
}

// ---- search ----

export interface Hit {
  section: Section;
  score: number;
  snippet: string;
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

interface Indexed {
  section: Section;
  title: Map<string, number>;
  body: Map<string, number>;
  lowerTitle: string;
  lowerText: string;
}

let index: Indexed[] | undefined;

function count(ws: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of ws) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

function buildIndex(): Indexed[] {
  return PAGE_ORDER.flatMap((f) => page(f)?.sections ?? []).map((s) => ({
    section: s,
    title: count(words(s.id ? `${s.title} ${s.pageTitle}` : s.title)),
    body: count(words(s.text)),
    lowerTitle: s.title.toLowerCase(),
    lowerText: s.text.toLowerCase(),
  }));
}

/** Weighted matches of a term: whole words count fully, words starting with the term half. */
function termScore(m: Map<string, number>, term: string): number {
  let n = 0;
  for (const [w, c] of m) {
    if (w === term) n += c;
    else if (w.startsWith(term)) n += c / 2;
  }
  return n;
}

/** HTML of `text` with the search terms marked. */
export function highlight(text: string, terms: string[]): string {
  const ts = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!ts.length) return escapeHtml(text);
  const re = new RegExp(`(${ts.join("|")})`, "giu");
  return text
    .split(re)
    .map((part, i) => (i % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join("");
}

function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const found = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const from = found.length ? Math.max(0, Math.min(...found) - 60) : 0;
  let s = text.slice(from, from + 180).trim();
  if (from > 0) s = "…" + s;
  if (from + 180 < text.length) s += "…";
  return highlight(s, terms);
}

export function queryTerms(query: string): string[] {
  return [...new Set(words(query))];
}

/** Sections containing every term of the query, best first. */
export function search(query: string, limit = 60): Hit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  index ??= buildIndex();
  const phrase = query.trim().toLowerCase();
  const hits: Hit[] = [];
  for (const e of index) {
    let score = 0;
    let all = true;
    for (const t of terms) {
      const s = termScore(e.title, t) * 10 + Math.min(termScore(e.body, t), 10);
      if (s === 0) {
        all = false;
        break;
      }
      score += s;
    }
    if (!all) continue;
    if (terms.length > 1 || /[^\p{L}\p{N}_]/u.test(phrase)) {
      if (e.lowerTitle.includes(phrase)) score += 30;
      else if (e.lowerText.includes(phrase)) score += 10;
    }
    hits.push({ section: e.section, score, snippet: snippet(e.section.text, terms) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The manual page about a kind of view. */
export function pageForView(kind: string | undefined): string {
  const m: Record<string, string> = {
    folder: "folder-compare.md",
    sync: "folder-sync.md",
    text: "text-compare.md",
    merge: "text-merge.md",
    table: "table-compare.md",
    hex: "hex-compare.md",
    picture: "picture-compare.md",
    edit: "editing-and-patches.md",
    patch: "editing-and-patches.md",
  };
  const f = (kind && m[kind]) || "index.md";
  return hasPage(f) ? f : (PAGE_ORDER[0] ?? "index.md");
}
