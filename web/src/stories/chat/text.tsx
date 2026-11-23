// The creative director's words, drawn safely (docs/CONTRACTS.md §45.27): paragraphs, "- " and "1. " lists and
// **bold** (one not closed yet, as an answer is written, bolds to the end of its line), nothing else. Everything is
// React text, so markup in an answer shows as the letters it is, and no link in an answer is ever live (buttons do
// the work).
import type { ReactNode } from "react";

type Block = { t: "p"; lines: string[] } | { t: "ul"; items: string[] } | { t: "ol"; items: string[]; start: number };

export function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const number = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);
    const last = out[out.length - 1];
    if (bullet) {
      if (last?.t === "ul") last.items.push(bullet[1]!);
      else out.push({ t: "ul", items: [bullet[1]!] });
    } else if (number) {
      if (last?.t === "ol") last.items.push(number[2]!);
      else out.push({ t: "ol", items: [number[2]!], start: Number(number[1]) });
    } else if (!line.trim()) {
      if (last && !(last.t === "p" && last.lines.length === 0)) out.push({ t: "p", lines: [] });
    } else if (last?.t === "p") last.lines.push(line);
    else out.push({ t: "p", lines: [line] });
  }
  return out.filter((b) => (b.t === "p" ? b.lines.length > 0 : b.items.length > 0));
}

/**
 * A line's **bold**. A ** that is not closed (an answer still being written, or stopped half way) never shows as
 * stars: the words after it are bold to the end of the line.
 */
export function inline(s: string): ReactNode[] {
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.flatMap((p, i): ReactNode[] => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return [<strong key={i}>{p.slice(2, -2)}</strong>];
    const open = p.indexOf("**");
    if (open < 0) return [p];
    const rest = p.slice(open + 2).replace(/\*\*/g, "");
    return [p.slice(0, open), rest ? <strong key={i}>{rest}</strong> : null].filter((x) => x !== "" && x !== null);
  });
}

export function ChatText({ text }: { text: string }) {
  return (
    <>
      {blocks(text).map((b, i) =>
        b.t === "p" ? (
          <p key={i} className="st-chat-text__p">
            {b.lines.map((l, j) => (
              <span key={j}>
                {j ? <br /> : null}
                {inline(l)}
              </span>
            ))}
          </p>
        ) : b.t === "ul" ? (
          <ul key={i} className="st-chat-text__list">
            {b.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i} className="st-chat-text__list" start={b.start}>
            {b.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ol>
        ),
      )}
    </>
  );
}
