// The pieces of Ask as a full assistant (docs/CONTRACTS.md §27.7, §27.9): file tiles (tray and sent), a streamed
// answer (safe markdown, tables, code with Copy, [n] source chips, live links only when allowed) and its sources.
import { Fragment, useMemo, type ReactNode } from "react";
import { AskMark } from "../../components/AskMark.tsx";
import { Icon } from "../../components/Icon.tsx";
import { ProgressRing } from "../../components/ProgressRing.tsx";
import { ActGlyph } from "../../components/ui.tsx";
import { drawBlocks, parseMarkdown } from "../../lib/markdown.ts";
import { useAction, watchResult } from "../../lib/motion.ts";
import { liveLink, type AskSource, type StreamAnswer } from "./askStream.ts";
import { fileIcon, sizeLabel, WHY_TEXT, type AskKind } from "./files.ts";

export interface TileFile {
  id: number;
  kind: AskKind;
  name: string;
  format: string;
  size: number;
  url?: string | null;
  width?: number;
  height?: number;
  marked?: boolean;
}

/** A file tile: a format icon, the format in capitals, the name on one line and the size. */
export function FileTile({ f, children, note }: { f: TileFile; children?: ReactNode; note?: string }) {
  return (
    <span className="ask-file" title={f.name}>
      <span className="ask-file__icon" aria-hidden="true">
        <Icon name={fileIcon(f.kind, f.format)} size={26} />
      </span>
      <span className="ask-file__text">
        <span className="ask-file__format">{f.format}</span>
        <span className="ask-file__name">{f.name}</span>
        <span className="ask-file__size">{note ?? sizeLabel(f.size)}</span>
      </span>
      {children}
    </span>
  );
}

/** Upload progress over a tile while the question goes. */
export function UploadRing({ value, name }: { value: number | undefined; name: string }) {
  if (value === undefined) return null;
  return (
    <span className="ask-upload">
      <ProgressRing value={value} size={28} stroke={4} label={`Sending ${name}`} />
    </span>
  );
}

/** Copies text; resolves false when the clipboard said no. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label, className = "" }: { text: string; label: string; className?: string }) {
  const act = useAction("copy");
  return (
    <button
      type="button"
      className={`ask-copy ${className}`}
      data-act="copy"
      onClick={() => {
        act.play();
        watchResult(copyText(text), () => act.fail({ sound: false }));
      }}
    >
      <ActGlyph act={act}>
        <Icon name="copy" size={16} />
      </ActGlyph>
      <span>{label}</span>
    </button>
  );
}

const CITE = /\[(\d{1,2})\]/g;

/** The answer's text as safe markdown. While it streams no link is live; once done only the server's links are. */
export function AnswerBody({ answer, idPrefix }: { answer: StreamAnswer; idPrefix: string }) {
  const doc = useMemo(() => parseMarkdown(answer.text), [answer.text]);
  const known = new Set(answer.sources.map((s) => s.n));
  const nodes = drawBlocks(doc.blocks, 3, {
    linkOk: (href) => liveLink(href, answer.done),
    pre: (lang, code, key) => (
      <div className="ask-code" key={key}>
        <div className="ask-code__bar">
          <span className="ask-code__lang">{lang || "code"}</span>
          <CopyButton text={code} label="Copy" className="ask-code__copy" />
        </div>
        <pre className="md__pre" tabIndex={0}>
          <code>{code}</code>
        </pre>
      </div>
    ),
    text: (text, key) => {
      if (!CITE.test(text)) return text;
      CITE.lastIndex = 0;
      const parts: ReactNode[] = [];
      let last = 0;
      for (const m of text.matchAll(CITE)) {
        const n = Number(m[1]);
        parts.push(text.slice(last, m.index));
        parts.push(
          known.has(n) ? (
            <a key={`c${m.index}`} className="ask-cite" href={`#${idPrefix}-src-${n}`} aria-label={`Source ${n}`}>
              {n}
            </a>
          ) : (
            <Fragment key={`c${m.index}`} />
          ),
        );
        last = (m.index ?? 0) + m[0].length;
      }
      parts.push(text.slice(last));
      return <Fragment key={key}>{parts}</Fragment>;
    },
  });
  return <div className="ask-answer md">{nodes}</div>;
}

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The numbered sources under an answer: web (title, domain), files (name, page), app guides. */
export function Sources({ sources, done, idPrefix }: { sources: AskSource[]; done: StreamAnswer["done"]; idPrefix: string }) {
  if (!sources.length) return null;
  return (
    <div className="ask-sources">
      <p className="ask-sources__title">Sources</p>
      <ol className="ask-sources__list">
        {sources.map((s) => (
          <li key={s.n} id={`${idPrefix}-src-${s.n}`} className="ask-source">
            <span className="ask-source__n" aria-hidden="true">
              {s.n}
            </span>
            <Icon name={s.kind === "web" ? "globe" : s.kind === "file" ? "file" : "compass"} size={16} />
            <span className="ask-source__text">
              {s.kind === "web" && s.url && liveLink(s.url, done) ? (
                <a className="ask-source__link" href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title}
                </a>
              ) : (
                <span>{s.kind === "app" ? "Clip Factory guide" : s.title}</span>
              )}
              <span className="ask-source__where">
                {s.kind === "web" && s.url ? domain(s.url) : s.kind === "file" ? [s.file ?? s.title, s.where].filter(Boolean).join(", ") : s.title !== "Clip Factory guide" ? s.title : ""}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** "Thinking…", "Searching the web…", "Reading meta.com…": the answer's status line with the Ask mark. */
export function StatusLine({ label }: { label: string }) {
  return (
    <p className="ask-status" role="status">
      <span className="ask-status__mark" aria-hidden="true">
        <AskMark size={18} />
      </span>
      <span>{label}</span>
    </p>
  );
}

/** Why a sent file was not read, under its tile. */
export function unreadNote(why: string | undefined): string {
  return WHY_TEXT[why ?? ""] ?? WHY_TEXT.damaged!;
}
