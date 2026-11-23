import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api/index.ts";
import type { SimilarClip } from "../api/types.ts";
import { count, MOMENT_LABEL } from "../lib/format.ts";
import { Icon } from "./Icon.tsx";
import { A } from "./ui.tsx";

/** "86% alike" from a 0..1 similarity. */
export function alike(similarity: number): string {
  return `${Math.round(Math.min(1, Math.max(0, similarity)) * 100)}% alike`;
}

/**
 * "Like clips that did well": the owner's posted clips most like this one, with how they did (docs/CONTRACTS.md
 * §14.6). Advice, not a rule. Loads once the card is near the screen, and shows nothing at all when there is nothing
 * to show (no measured clips yet, or the search failed).
 */
export function SimilarClips({ clipId }: { clipId: string }) {
  const [clips, setClips] = useState<SimilarClip[] | null>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  const anchor = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (near || !anchor.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "400px 0px" },
    );
    // The anchor itself has no box (nothing shows until there is something to show): watch the card holding it.
    io.observe(anchor.current.parentElement ?? anchor.current);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let gone = false;
    api()
      .similarClips(clipId)
      .then((found) => !gone && setClips(found.slice(0, 5)))
      .catch(() => !gone && setClips([]));
    return () => {
      gone = true;
    };
  }, [near, clipId]);

  if (!clips?.length) return <div ref={anchor} className="similar-anchor" aria-hidden="true" />;

  return (
    <section className="similar" aria-labelledby={`${id}-t`}>
      <h3 className="similar__title" id={`${id}-t`}>
        <Icon name="sparkle" size={16} />
        <span>Like clips that did well</span>
      </h3>
      {/* Each tile opens that clip's page (it looks like a clip card, so a tap must do what a card does). The tiles
          are links, so the keyboard reaches each one and scrolls the strip to it: the list itself takes no focus. */}
      <ul className="similar__list" aria-labelledby={`${id}-t`}>
        {clips.map((c) => (
          // The tile (the link) carries the card look; its list item keeps the tile's width in the scrolling strip.
          <li key={c.clipId} style={{ flex: "none" }}>
            <A href={`/clips/${c.clipId}`} className="similar__item" style={{ textDecoration: "none" }}>
              <span className="similar__cover">{c.coverUrl ? <img src={c.coverUrl} alt="" loading="lazy" /> : null}</span>
              <span className="similar__text">
                <span className="similar__hook clamp-2 user-text">{c.hook}</span>
                <span className="similar__meta">
                  {c.performance ? (
                    <span className="similar__views">
                      <Icon name="eye" size={14} />
                      {count(c.performance.views)} views
                    </span>
                  ) : (
                    <span>{MOMENT_LABEL[c.momentType]}</span>
                  )}
                  <span>{alike(c.similarity)}</span>
                </span>
              </span>
            </A>
          </li>
        ))}
      </ul>
    </section>
  );
}
