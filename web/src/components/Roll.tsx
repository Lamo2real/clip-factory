// A number that rolls like an odometer when it changes while it is on screen: each digit that changed slides up
// (the number grew) or down (it shrank) to its new value. The first number is just shown, never rolled. Under
// reduced motion (the setting or the system) the number is swapped with no roll. At rest the markup is the plain
// text alone; while rolling, screen readers get only the final number (the digits are aria-hidden).
import { useEffect, useState, type CSSProperties } from "react";
import { prefersReducedMotion } from "../lib/prefs.ts";

/** One roll, start to end. `--roll-dur` in styles/roll.css says the same (test/roll.test.tsx). */
export const ROLL_MS = 750;

export type RollDir = "up" | "down";

export type RollCell =
  /** A character that stays put: a digit that did not change, or ".", ",", "K", "$". */
  | { kind: "still"; char: string }
  /** A digit on the move: `digits` is the strip from top to bottom, and it ends on the new digit. */
  | { kind: "roll"; digits: string[] };

const isDigit = (c: string | undefined): c is string => c !== undefined && c >= "0" && c <= "9";

/**
 * The cells of one roll, lined up from the right (so "9.9K" to "10K" keeps the K still). A digit rolls through
 * every digit between the old and the new one, wrapping past 9 or 0 in the direction of the change.
 */
export function rollCells(from: string, to: string, dir: RollDir): RollCell[] {
  const shift = from.length - to.length;
  return [...to].map((char, i) => {
    const old = from[i + shift];
    if (!isDigit(char) || !isDigit(old) || old === char) return { kind: "still", char };
    const step = dir === "up" ? 1 : 9;
    const passed = [old];
    for (let d = Number(old); String(d) !== char; ) {
      d = (d + step) % 10;
      passed.push(String(d));
    }
    // Up: the old digit is on top and the strip slides up. Down: the new digit is on top and the strip slides down.
    return { kind: "roll", digits: dir === "up" ? passed : passed.reverse() };
  });
}

interface Rolling {
  from: string;
  dir: RollDir;
  /** Counts the rolls, so a change in the middle of a roll starts a fresh one. */
  id: number;
}

/**
 * `n` is the real number (it decides up or down) and `text` is how it is written ("26.8K", "$12.40", "99+").
 * A null `n` (no number yet) never rolls.
 */
export function Roll({ n, text }: { n: number | null | undefined; text: string }) {
  const [seen, setSeen] = useState({ n, text });
  const [rolling, setRolling] = useState<Rolling | null>(null);

  if (seen.n !== n || seen.text !== text) {
    setSeen({ n, text });
    const was = seen.n;
    const moved = typeof n === "number" && typeof was === "number" && n !== was && text !== seen.text;
    setRolling(moved && !prefersReducedMotion() ? { from: seen.text, dir: n > was ? "up" : "down", id: (rolling?.id ?? 0) + 1 } : null);
  }

  useEffect(() => {
    if (!rolling) return;
    const done = setTimeout(() => setRolling(null), ROLL_MS + 40);
    return () => clearTimeout(done);
  }, [rolling]);

  if (!rolling) return <span className="roll">{text}</span>;

  return (
    <span className="roll is-rolling" data-roll={rolling.dir}>
      <span className="sr-only">{text}</span>
      <span className="roll__row" aria-hidden="true">
        {rollCells(rolling.from, text, rolling.dir).map((cell, i) =>
          cell.kind === "still" ? (
            <span key={i}>{cell.char}</span>
          ) : (
            <span key={`${rolling.id}-${i}`} className="roll__col">
              <span className="roll__strip" style={{ "--roll-end": `${(-100 * (cell.digits.length - 1)) / cell.digits.length}%` } as CSSProperties}>
                {cell.digits.map((d, j) => (
                  <span key={j}>{d}</span>
                ))}
              </span>
            </span>
          ),
        )}
      </span>
    </span>
  );
}
