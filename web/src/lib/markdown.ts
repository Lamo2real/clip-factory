// A tiny, safe markdown reader for skills (docs/CONTRACTS.md §18.3). Skills are text anyone could have written, so
// nothing here ever becomes HTML: the text is parsed into a small tree and drawn as React elements, which escape
// everything. Raw HTML (`<script>`, `<img onerror>`) therefore shows as the letters it is. Links work only for
// http:, https: and mailto:, and pictures are never loaded (their alt text and address are shown instead).
import { createElement, type ReactNode } from "react";

/** Longer skills show only their start. */
export const MAX_SHOWN_CHARS = 200_000;

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "image"; alt: string; href: string | null; src: string };

export type Block =
  | { t: "h"; level: number; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "ul"; items: Block[][] }
  | { t: "ol"; start: number; items: Block[][] }
  | { t: "quote"; c: Block[] }
  | { t: "pre"; lang: string; v: string }
  | { t: "table"; head: Inline[][]; align: ("left" | "center" | "right" | null)[]; rows: Inline[][][] }
  | { t: "hr" };

export interface Frontmatter {
  /** Top-level `key: value` pairs, values unquoted. */
  fields: Record<string, string>;
}

export interface MdDoc {
  front: Frontmatter | null;
  blocks: Block[];
  /** The text was longer than MAX_SHOWN_CHARS and only its start was read. */
  truncated: boolean;
}

// ---------- Frontmatter ----------

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const out: unknown = JSON.parse(v);
      if (typeof out === "string") return out;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * Splits a leading `---` block off the text (as the API's `parse_frontmatter` reads it: plain, quoted, `>` and `|`
 * values). Returns null when the text does not start with one.
 */
export function splitFrontmatter(text: string): { front: Frontmatter; body: string } | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l === "---" || l === "...") {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const fields: Record<string, string> = {};
  let i = 1;
  while (i < end) {
    const line = lines[i]!;
    i++;
    if (!line.trim() || line.trimStart().startsWith("#") || line[0] === " " || line[0] === "\t") continue;
    const at = line.indexOf(":");
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    const rest = line.slice(at + 1).trim();
    if (rest.startsWith(">") || rest.startsWith("|")) {
      const block: string[] = [];
      while (i < end && (!lines[i]!.trim() || lines[i]![0] === " " || lines[i]![0] === "\t")) block.push(lines[i++]!.trim());
      fields[key] = block.filter(Boolean).join(rest.startsWith(">") ? " " : "\n").trim();
    } else {
      const parts = [rest];
      while (i < end && (lines[i]![0] === " " || lines[i]![0] === "\t") && lines[i]!.trim()) parts.push(lines[i++]!.trim());
      fields[key] = unquote(parts.filter(Boolean).join(" "));
    }
  }
  return { front: { fields }, body: lines.slice(end + 1).join("\n") };
}

// ---------- Links ----------

/** The address as a link target, or null when it is not http:, https: or mailto: (javascript:, data:, relative…). */
export function safeHref(raw: string): string | null {
  const url = raw.trim().replace(/^<|>$/g, "");
  // Browsers ignore tabs and new lines inside a scheme ("java\tscript:"), so they are never allowed at all.
  // eslint-disable-next-line no-control-regex
  if (!url || /[\s\u0000-\u001F]/.test(url)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme !== "http" && scheme !== "https" && scheme !== "mailto") return null;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
}

// ---------- Inline ----------

const MAX_DEPTH = 6;
const PUNCT = /[!-/:-@[-`{-~]/;

/** Finds `]` that closes the `[` at `open`, counting nested brackets; -1 if none within a short distance. */
function closeBracket(s: string, open: number): number {
  let depth = 0;
  const stop = Math.min(s.length, open + 2000);
  for (let i = open; i < stop; i++) {
    const ch = s[i];
    if (ch === "\\") i++;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return i;
  }
  return -1;
}

/** `(url "title")` right after a `]`: the url and where it ends, or null. */
function linkTarget(s: string, at: number): { url: string; end: number } | null {
  if (s[at] !== "(") return null;
  // Balanced, so `(javascript:alert(1))` ends at the last `)`.
  let depth = 0;
  let close = -1;
  const stop = Math.min(s.length, at + 2000);
  for (let i = at; i < stop; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return null;
  const inside = s.slice(at + 1, close).trim();
  const url = /^(\S*)/.exec(inside)?.[1] ?? "";
  return { url, end: close + 1 };
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  // Once a closer is missing after some point it is missing after every later point too: remember that, so a long
  // line of unmatched `*` stays fast.
  const none = new Set<string>();
  const find = (delim: string, from: number) => {
    if (none.has(delim)) return -1;
    const at = s.indexOf(delim, from);
    if (at < 0) none.add(delim);
    return at;
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1]!)) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const close = find(fence, i + n);
      if (close >= 0) {
        flush();
        out.push({ t: "code", v: s.slice(i + n, close).replace(/^ (.+) $/, "$1") });
        i = close + n;
        continue;
      }
      text += fence;
      i += n;
      continue;
    }
    if (ch === "!" && s[i + 1] === "[") {
      const close = closeBracket(s, i + 1);
      const target = close > 0 ? linkTarget(s, close + 1) : null;
      if (target) {
        flush();
        out.push({ t: "image", alt: s.slice(i + 2, close), href: safeHref(target.url), src: target.url });
        i = target.end;
        continue;
      }
    }
    if (ch === "[") {
      const close = closeBracket(s, i);
      const target = close > 0 ? linkTarget(s, close + 1) : null;
      if (target) {
        flush();
        const label = depth < MAX_DEPTH ? parseInline(s.slice(i + 1, close), depth + 1) : [{ t: "text" as const, v: s.slice(i + 1, close) }];
        const href = safeHref(target.url);
        // Not a safe address: only the words are shown, never a link.
        if (href) out.push({ t: "link", href, c: label });
        else out.push(...label);
        i = target.end;
        continue;
      }
    }
    if (ch === "<") {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i, i + 2100));
      const href = auto ? safeHref(auto[1]!) : null;
      if (auto && href) {
        flush();
        out.push({ t: "link", href, c: [{ t: "text", v: auto[1]! }] });
        i += auto[0].length;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && depth < MAX_DEPTH) {
      const double = s[i + 1] === ch;
      const delim = double ? ch + ch : ch;
      const prev = i > 0 ? s[i - 1]! : " ";
      const intraword = ch === "_" && /[\p{L}\p{N}]/u.test(prev);
      const start = i + delim.length;
      if (!intraword && start < s.length && !/\s/.test(s[start]!)) {
        const close = find(delim, start + 1);
        if (close > start && !/\s/.test(s[close - 1]!)) {
          flush();
          const inner = parseInline(s.slice(start, close), depth + 1);
          out.push(double ? { t: "strong", c: inner } : { t: "em", c: inner });
          i = close + delim.length;
          continue;
        }
      }
      text += delim;
      i += delim.length;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

// ---------- Blocks ----------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
// Linear on purpose: a lazy `(.*?)` before `\s*#*\s*$` backtracks cubically, and one long crafted line froze the page.
const HEADING = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^( {0,3})([-*+])(\s+|$)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})[.)](\s+|$)(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

const isBlank = (l: string) => !l.trim();

/** A GFM table's delimiter row (`| --- | :-: |`). */
const TABLE_DELIM = /^ {0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const MAX_TABLE_COLS = 20;

/** Splits one table row into its cells (escaped pipes stay in the cell). */
function tableCells(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|") && !l.endsWith("\\|")) l = l.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < l.length; i++) {
    if (l[i] === "\\" && l[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (l[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += l[i];
  }
  cells.push(cur.trim());
  return cells.slice(0, MAX_TABLE_COLS);
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  return !!head && !!delim && head.includes("|") && TABLE_DELIM.test(delim) && delim.includes("-");
}

/** A heading's words without its optional closing #s ("# Title ##" → "Title"), with no backtracking regex. */
function headingText(rest: string): string {
  let s = rest.trimEnd();
  let j = s.length;
  while (j > 0 && s[j - 1] === "#") j--;
  if (j === 0 || s[j - 1] === " " || s[j - 1] === "\t") s = s.slice(0, j);
  return s.trim();
}

function startsBlock(line: string): boolean {
  if (/^\s*\|/.test(line)) return true;
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || BULLET.test(line) || ORDERED.test(line) || QUOTE.test(line);
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i++; // the closing fence (or the end)
      blocks.push({ t: "pre", lang: fence[2] ?? "", v: body.join("\n") });
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = tableCells(line);
      const align = tableCells(lines[i + 1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes("|")) rows.push(tableCells(lines[i++]!).map((c) => parseInline(c)));
      blocks.push({ t: "table", head: head.map((c) => parseInline(c)), align: head.map((_, k) => align[k] ?? null), rows });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: "h", level: heading[1]!.length, c: parseInline(headingText(line.slice(heading[0].length))) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !isBlank(lines[i]!)) {
        const q = QUOTE.exec(lines[i]!);
        inner.push(q ? q[1]! : lines[i]!);
        i++;
      }
      blocks.push({ t: "quote", c: depth < MAX_DEPTH ? parseBlocks(inner, depth + 1) : [{ t: "p", c: [{ t: "text", v: inner.join(" ") }] }] });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      const re = bullet ? BULLET : ORDERED;
      const items: Block[][] = [];
      const start = ordered ? Number(ordered[2]) : 1;
      while (i < lines.length) {
        const m = re.exec(lines[i]!);
        if (!m) break;
        const indent = m[1]!.length + m[2]!.length + (ordered ? 1 : 0) + Math.max(1, m[3]!.length);
        const body = [m[4]!];
        i++;
        // The item goes on over indented lines (nested lists too) and lazy paragraph lines.
        while (i < lines.length) {
          const l = lines[i]!;
          if (isBlank(l)) {
            const next = lines[i + 1];
            if (next !== undefined && /^\s{2,}\S/.test(next)) {
              body.push("");
              i++;
              continue;
            }
            break;
          }
          if (/^\s{2,}\S/.test(l)) body.push(l.replace(new RegExp(`^\\s{0,${Math.max(2, indent)}}`), ""));
          else if (!startsBlock(l)) body.push(l);
          else break;
          i++;
        }
        items.push(depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [{ t: "p", c: [{ t: "text", v: body.join(" ") }] }]);
        while (i < lines.length && isBlank(lines[i]!) && re.test(lines[i + 1] ?? "")) i++;
      }
      blocks.push(bullet ? { t: "ul", items } : { t: "ol", start, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]!) && (para.length === 0 || !startsBlock(lines[i]!))) para.push(lines[i++]!.trim());
    blocks.push({ t: "p", c: parseInline(para.join(" ")) });
  }
  return blocks;
}

/** Reads a SKILL.md: its frontmatter (if any), then the markdown body as blocks. */
export function parseMarkdown(text: string): MdDoc {
  const truncated = text.length > MAX_SHOWN_CHARS;
  const shown = truncated ? text.slice(0, MAX_SHOWN_CHARS) : text;
  const split = splitFrontmatter(shown);
  const body = split ? split.body : shown;
  return { front: split?.front ?? null, blocks: parseBlocks(body.split(/\r?\n/), 0), truncated };
}

// ---------- Drawing ----------

const h = createElement;

/** Choices for drawing (Ask's answers, §28.9): which links may be live, and how code blocks are drawn. */
export interface DrawOptions {
  /** When given, only links it allows are live; every other link shows as its words. */
  linkOk?: (href: string) => boolean;
  /** Draws a fenced code block (Ask adds a Copy button). */
  pre?: (lang: string, code: string, key: number) => ReactNode;
  /** Draws plain text (Ask turns its `[1]` source marks into chips). */
  text?: (text: string, key: number) => ReactNode;
}

function drawInline(nodes: Inline[], opts: DrawOptions = {}): ReactNode[] {
  return nodes.map((n, k) => {
    switch (n.t) {
      case "text":
        return opts.text ? opts.text(n.v, k) : n.v;
      case "code":
        return h("code", { key: k, className: "md__code" }, n.v);
      case "strong":
        return h("strong", { key: k }, ...drawInline(n.c, opts));
      case "em":
        return h("em", { key: k }, ...drawInline(n.c, opts));
      case "link":
        if (opts.linkOk && !opts.linkOk(n.href)) return h("span", { key: k, className: "md__link-text" }, ...drawInline(n.c, opts));
        return h("a", { key: k, href: n.href, target: "_blank", rel: "noopener noreferrer nofollow", className: "md__link" }, ...drawInline(n.c, opts));
      case "image":
        // Never loaded, and no raw address either: just what the picture shows.
        return h("span", { key: k, className: "md__img" }, `Picture: ${n.alt || "no description"}`);
    }
  });
}

/** The plain words of inline nodes ("**GTA** RP" → "GTA RP"), for comparing a heading with the page title. */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "image" ? n.alt : inlineText(n.c))).join("");
}

/**
 * The blocks as React elements. Headings start at `topLevel` (the page already has its own h1), so a skill's `#`
 * becomes an h2.
 */
export function drawBlocks(blocks: Block[], topLevel = 2, opts: DrawOptions = {}): ReactNode[] {
  return blocks.map((b, k) => {
    switch (b.t) {
      case "h": {
        const level = Math.min(6, b.level + topLevel - 1);
        return h(`h${level}`, { key: k, className: `md__h md__h${b.level}` }, ...drawInline(b.c, opts));
      }
      case "p":
        return h("p", { key: k, className: "md__p" }, ...drawInline(b.c, opts));
      case "ul":
        return h("ul", { key: k, className: "md__list" }, ...b.items.map((item, j) => h("li", { key: j }, ...drawBlocks(item, topLevel, opts))));
      case "ol":
        return h(
          "ol",
          { key: k, className: "md__list", start: b.start },
          ...b.items.map((item, j) => h("li", { key: j }, ...drawBlocks(item, topLevel, opts))),
        );
      case "quote":
        return h("blockquote", { key: k, className: "md__quote" }, ...drawBlocks(b.c, topLevel, opts));
      case "table":
        return h(
          "div",
          { key: k, className: "md__table-wrap", tabIndex: 0, role: "region", "aria-label": "Table" },
          h(
            "table",
            { className: "md__table" },
            h("thead", null, h("tr", null, ...b.head.map((c, j) => h("th", { key: j, scope: "col", style: b.align[j] ? { textAlign: b.align[j] } : undefined }, ...drawInline(c, opts))))),
            h(
              "tbody",
              null,
              ...b.rows.map((row, r) =>
                h("tr", { key: r }, ...b.head.map((_, j) => h("td", { key: j, style: b.align[j] ? { textAlign: b.align[j] } : undefined }, ...drawInline(row[j] ?? [], opts)))),
              ),
            ),
          ),
        );
      case "pre":
        if (opts.pre) return opts.pre(b.lang, b.v, k);
        return h("pre", { key: k, className: "md__pre", tabIndex: 0 }, h("code", null, b.v));
      case "hr":
        return h("hr", { key: k, className: "md__hr" });
    }
  });
}
