// Clips Funded › Series (docs/CONTRACTS.md §45.43). A series is a folder of story videos with the same cast: its name,
// one line about it, its cast (the main character first, at most one car), and everything in it (ideas, videos being
// made, waiting for review, and its episodes). Each folder keeps a short memory, the story so far, written by Clips
// Funded after each approval (or by the owner, who can edit it), which the idea helper and the story writer read so the
// next episode follows on. Kid-proof: Series → New series → a name → tap the cast → Make it → Make the next episode.
import "../styles/sd-series.css";
import { useMemo, useState } from "react";
import { useToast } from "../../components/Toasts.tsx";
import { A } from "../../components/ui.tsx";
import { useLoad, usePoll } from "../../lib/hooks.ts";
import { navigate } from "../../lib/router.ts";
import { storiesApi } from "../api/client.ts";
import type { Character, Idea, Series, Story } from "../api/types.ts";
import { useAppActive } from "../pane.tsx";
import { CastPreview } from "../preview/CastPreview.tsx";
import { storiesHref } from "../routes.ts";
import { CastPicker, castOrder, castProblem } from "../studio/CastPicker.tsx";
import { Busy, celebrate, Notice, StSheet, TextField } from "../studio/kit.tsx";
import { forgetSeries, rememberSeries, seriesChanged } from "../studio/SeriesSwitch.tsx";
import { say } from "../studio/words.ts";
import { StIcon } from "../ui.tsx";
import type { StoriesScreenProps } from "./types.ts";

export const NAME_MAX = 40;
export const LINE_MAX = 120;
export const STORY_SO_FAR_MAX = 1500;

const MAKING: Story["status"][] = ["draft", "producing", "failed"];
const WAITING: Story["status"][] = ["needs_check", "review"];

/** What is wrong with a new series before it is sent (the API's own sentences), or null. */
export function seriesProblem(name: string, line: string, cast: Character[]): string | null {
  const n = name.trim();
  if (!n) return "Give your series a name.";
  if (n.length > NAME_MAX) return "Keep the name to 40 letters.";
  if (line.trim().length > LINE_MAX) return "Keep the line to 120 letters.";
  return castProblem(cast);
}

/** Make the next episode (§45.43): a new video in the series with its cast, and the series' next saved idea already
 * picked when it has one (with none, New video lists the other ideas, or asks for some in the series). */
export function nextEpisodeHref(s: Pick<Series, "seriesId" | "castIds">, ideas: Pick<Idea, "ideaId">[]): string {
  return storiesHref({ name: "production_new", ideaId: ideas[0]?.ideaId ?? null, castIds: s.castIds, seriesId: s.seriesId });
}

export function episodesWord(n: number): string {
  return n === 0 ? "No episodes yet" : n === 1 ? "1 episode" : `${n} episodes`;
}

export function SeriesScreen({ ws, page }: StoriesScreenProps) {
  if (page.name === "series_one") return <Folder key={page.seriesId} ws={ws} seriesId={page.seriesId} />;
  return <Home ws={ws} />;
}

function Cover({ url }: { url: string | null }) {
  return <span className="st-series-cover">{url ? <img src={url} alt="" loading="lazy" decoding="async" /> : <StIcon name="folder" />}</span>;
}

// ---------- The folders ----------

function Home({ ws }: { ws: string }) {
  const list = useLoad(() => storiesApi().listSeries(ws), ws, "st-series");
  const [making, setMaking] = useState(false);
  return (
    <section className="st-page st-studio st-s-make st-series">
      <header className="st-s-head">
        <div className="st-plate st-s-head__text">
          <h1 className="st-s-head__title">Series</h1>
        </div>
        <div className="st-s-head__actions">
          <button type="button" className="st-btn st-btn--main" onClick={() => setMaking(true)}>
            New series
          </button>
        </div>
      </header>
      {list.error && !list.data ? (
        <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => void list.reload()}>Try again</button>}>
          {list.error}
        </Notice>
      ) : !list.data ? (
        <Busy>Getting your series…</Busy>
      ) : list.data.length === 0 ? (
        <div className="st-series-empty st-glass">
          <StIcon name="folder" />
          <p>Keep a story's videos together.</p>
          <button type="button" className="st-btn st-btn--main" onClick={() => setMaking(true)}>
            New series
          </button>
        </div>
      ) : (
        <ul className="st-series-grid">
          {list.data.map((s) => (
            <li key={s.seriesId}>
              <A href={storiesHref({ name: "series_one", seriesId: s.seriesId })} className="st-series-card st-glass">
                <Cover url={s.coverUrl} />
                <span className="st-series-card__body">
                  <span className="st-series-card__name">{s.name}</span>
                  {s.line ? <span className="st-series-card__line">{s.line}</span> : null}
                  <span className="st-series-card__count">{episodesWord(s.episodes.length)}</span>
                </span>
              </A>
            </li>
          ))}
        </ul>
      )}
      {making ? (
        <NewSeriesSheet
          ws={ws}
          onClose={() => setMaking(false)}
          onMade={(s) => {
            rememberSeries(s);
            void seriesChanged(ws);
            navigate(storiesHref({ name: "series_one", seriesId: s.seriesId }));
          }}
        />
      ) : null}
    </section>
  );
}

function NewSeriesSheet({ ws, onClose, onMade }: { ws: string; onClose: () => void; onMade: (s: Series) => void }) {
  const chars = useLoad(() => storiesApi().listCharacters(ws), ws, "st-series-chars");
  const [name, setName] = useState("");
  const [line, setLine] = useState("");
  const [cast, setCast] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const all = chars.data ?? [];
  const picked = cast.map((id) => all.find((c) => c.characterId === id)).filter((c): c is Character => !!c);

  async function make() {
    if (busy) return;
    const why = seriesProblem(name, line, picked);
    if (why) return setProblem(why);
    setBusy(true);
    setProblem(null);
    try {
      const body: { name: string; line?: string; castIds?: string[] } = { name: name.trim() };
      if (line.trim()) body.line = line.trim();
      if (cast.length) body.castIds = castOrder(cast, all);
      const s = await storiesApi().createSeries(ws, body);
      celebrate(document.querySelector(".st-series-sheet .st-btn--main"), 80);
      onMade(s);
    } catch (e) {
      setProblem(say(e));
      setBusy(false);
    }
  }

  return (
    <StSheet
      title="New series"
      onClose={onClose}
      wide
      className="st-series-sheet st-series"
      actions={
        <button type="button" className="st-btn st-btn--main" aria-disabled={busy || undefined} onClick={() => void make()}>
          {busy ? "Making it…" : "Make it"}
        </button>
      }
    >
      <form
        className="st-s-form"
        onSubmit={(e) => {
          e.preventDefault();
          void make();
        }}
      >
        <TextField label="Name" value={name} onChange={setName} max={NAME_MAX} placeholder="My first car" />
        <div className="st-s-field">
          <span className="st-s-field__label">Who's in it?</span>
          {chars.data ? <CastPicker characters={all} value={cast} onChange={setCast} /> : <Busy>Getting your characters…</Busy>}
        </div>
        <TextField label="About it (you can skip this)" value={line} onChange={setLine} max={LINE_MAX} placeholder="He buys a car and drives it" />
        {problem ? <Notice tone="bad">{problem}</Notice> : null}
      </form>
    </StSheet>
  );
}

// ---------- One folder ----------

function Folder({ ws, seriesId }: { ws: string; seriesId: string }) {
  const toast = useToast();
  const active = useAppActive();
  const series = useLoad(() => storiesApi().getSeries(ws, seriesId), `${ws}/${seriesId}`, "st-series-one");
  const chars = useLoad(() => storiesApi().listCharacters(ws), ws, "st-series-chars");
  const ideas = useLoad(() => storiesApi().listIdeas(ws, "saved"), ws, "st-series-ideas");
  const stories = useLoad(() => storiesApi().listStories(ws, { seriesId, limit: 50 }), `${ws}/${seriesId}`, "st-series-stories");
  const [sheet, setSheet] = useState<"none" | "menu" | "rename" | "cover" | "cast" | "delete">("none");
  const s = series.data;
  const writing = !!s?.recap && s.recap.status !== "failed";
  usePoll(() => series.reload(), writing && active, 2000);

  const put = (next: Series) => {
    series.setData(() => next);
    rememberSeries(next);
  };

  if (series.error && !s)
    return (
      <section className="st-page st-studio st-series">
        <Notice tone="bad" action={<A href={storiesHref({ name: "series" })} className="st-btn">Back to Series</A>}>
          {series.error}
        </Notice>
      </section>
    );
  if (!s)
    return (
      <section className="st-page st-studio st-series">
        <Busy>Opening the series…</Busy>
      </section>
    );

  const cast = s.castIds.map((id) => (chars.data ?? []).find((c) => c.characterId === id)).filter((c): c is Character => !!c);
  const mine = (ideas.data ?? []).filter((i) => i.seriesId === s.seriesId);
  const list = stories.data?.stories ?? [];
  const making = list.filter((x) => MAKING.includes(x.status));
  const waiting = list.filter((x) => WAITING.includes(x.status));

  async function recap(storyId: string) {
    try {
      await storiesApi().recapEpisode(ws, seriesId, storyId);
      await series.reload();
    } catch (e) {
      toast.error(say(e));
    }
  }

  return (
    <section className="st-page st-studio st-series">
      <header className="st-series-head">
        <Cover url={s.coverUrl} />
        <div className="st-series-head__text">
          <h1 className="st-series-head__name">{s.name}</h1>
          {s.line ? <p className="st-series-head__line">{s.line}</p> : null}
        </div>
        <div className="st-series-head__actions">
          <button type="button" className="st-btn st-btn--main" onClick={() => navigate(nextEpisodeHref(s, mine))}>
            Make the next episode
          </button>
          <button type="button" className="st-btn" onClick={() => navigate(storiesHref({ name: "ideas", seriesId: s.seriesId, ask: true }))}>
            Ask for ideas
          </button>
          <button type="button" className="st-btn st-series-more" aria-haspopup="dialog" aria-label={`More for ${s.name}`} onClick={() => setSheet("menu")}>
            <span aria-hidden="true">…</span>
          </button>
        </div>
      </header>

      <StorySoFar ws={ws} series={s} onSaved={put} onRecap={(id) => void recap(id)} />

      <section className="st-series-section" aria-labelledby="st-series-eps">
        <h2 className="st-series-section__title" id="st-series-eps">
          Episodes
        </h2>
        {s.episodes.length === 0 ? (
          <p className="st-series-quiet">{episodesWord(0)}</p>
        ) : (
          <ul className="st-series-episodes">
            {s.episodes.map((e) => (
              <li key={e.storyId}>
                <A href={storiesHref({ name: "review_story", storyId: e.storyId })} className="st-series-ep">
                  <Cover url={e.coverUrl ?? null} />
                  <span className="st-series-ep__body">
                    <span className="st-series-ep__n">Ep {e.number}</span>
                    <span className="st-series-ep__title">{e.title}</span>
                    <span className="st-series-ep__summary">{e.summary ?? "No summary yet"}</span>
                  </span>
                </A>
                {!e.summary && !(writing && s.recap?.storyId === e.storyId) ? (
                  <span className="st-series-write">
                    <button type="button" className="st-btn st-s-small" onClick={() => void recap(e.storyId)}>
                      Write it<span className="st-s-sr">{` for Ep ${e.number}`}</span>
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="st-series-section" aria-labelledby="st-series-next">
        <h2 className="st-series-section__title" id="st-series-next">
          Coming up
        </h2>
        {mine.length + making.length + waiting.length === 0 ? (
          <p className="st-series-quiet">Nothing yet. Tap Make the next episode.</p>
        ) : (
          <ul className="st-series-coming">
            {mine.map((i: Idea) => (
              <li key={i.ideaId}>
                <span>{i.title}</span>
                <A href={storiesHref({ name: "production_new", ideaId: i.ideaId, seriesId: s.seriesId })}>Make the video</A>
              </li>
            ))}
            {making.map((x) => (
              <li key={x.storyId}>
                <span>{x.title}</span>
                <A href={storiesHref({ name: "production_story", storyId: x.storyId })}>Being made</A>
              </li>
            ))}
            {waiting.map((x) => (
              <li key={x.storyId}>
                <span>{x.title}</span>
                <A href={storiesHref({ name: "review_story", storyId: x.storyId })}>Watch it</A>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="st-series-section" aria-labelledby="st-series-cast">
        <h2 className="st-series-section__title" id="st-series-cast">
          Cast
        </h2>
        {cast.length === 0 ? (
          <p className="st-series-quiet">No one yet.</p>
        ) : (
          <ul className="st-series-cast">
            {cast.map((c) => (
              <li key={c.characterId}>
                <CastPreview c={c} size={96} playing={false} label={c.name} />
                <span>{c.name}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {sheet === "menu" ? (
        <StSheet title={s.name} onClose={() => setSheet("none")} className="st-series-sheet">
          <div className="st-series-menu">
            <button type="button" className="st-btn" onClick={() => setSheet("rename")}>
              Rename
            </button>
            <button type="button" className="st-btn" onClick={() => setSheet("cover")}>
              Change cover
            </button>
            <button type="button" className="st-btn" onClick={() => setSheet("cast")}>
              Change cast
            </button>
            <button type="button" className="st-btn" onClick={() => setSheet("delete")}>
              Delete
            </button>
          </div>
        </StSheet>
      ) : null}
      {sheet === "rename" ? <RenameSheet ws={ws} series={s} onClose={() => setSheet("none")} onSaved={put} /> : null}
      {sheet === "cover" ? <CoverSheet ws={ws} series={s} cast={cast} onClose={() => setSheet("none")} onSaved={put} /> : null}
      {sheet === "cast" ? <CastSheet ws={ws} series={s} onClose={() => setSheet("none")} onSaved={put} /> : null}
      {sheet === "delete" ? (
        <DeleteSheet
          ws={ws}
          series={s}
          onClose={() => setSheet("none")}
          onDeleted={() => {
            forgetSeries(ws, s.seriesId);
            toast.success("Deleted. Its videos are under No series.");
            navigate(storiesHref({ name: "series" }));
          }}
        />
      ) : null}
    </section>
  );
}

function StorySoFar({ ws, series: s, onSaved, onRecap }: { ws: string; series: Series; onSaved: (s: Series) => void; onRecap: (storyId: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.storySoFar);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const writing = !!s.recap && s.recap.status !== "failed";
  const failed = s.recap?.status === "failed" ? s.recap : null;

  async function save() {
    if (busy) return;
    if (text.trim().length > STORY_SO_FAR_MAX) return setProblem("Keep the story so far to 1500 letters.");
    setBusy(true);
    setProblem(null);
    try {
      const next = await storiesApi().patchSeries(ws, s.seriesId, { version: s.version, storySoFar: text.trim() });
      onSaved(next);
      setEditing(false);
    } catch (e) {
      setProblem(say(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="st-series-section" aria-labelledby="st-series-sofar">
      <div className="st-series-section__head">
        <h2 className="st-series-section__title" id="st-series-sofar">
          Story so far
        </h2>
        {!editing ? (
          <button
            type="button"
            className="st-btn st-s-small"
            aria-disabled={writing || undefined}
            onClick={() => {
              if (writing) return;
              setText(s.storySoFar);
              setProblem(null);
              setEditing(true);
            }}
          >
            Edit
          </button>
        ) : null}
      </div>
      {editing ? (
        <form
          className="st-s-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <TextField label="Story so far" value={text} onChange={setText} max={STORY_SO_FAR_MAX} multiline rows={8} problem={problem} />
          <div className="st-s-actionbar">
            <button type="button" className="st-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="st-btn st-btn--main" aria-disabled={busy || undefined}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      ) : writing ? (
        <Busy>Writing it…</Busy>
      ) : (
        <>
          {s.storySoFar ? <p className="st-series-sofar">{s.storySoFar}</p> : <p className="st-series-quiet">It fills in when an episode is approved.</p>}
          {s.storySoFar && s.storySoFarBy ? <p className="st-series-by">{s.storySoFarBy === "owner" ? "Edited by you" : "Written by Clips Funded"}</p> : null}
        </>
      )}
      {failed && !editing ? (
        <Notice
          tone="bad"
          action={
            <button type="button" className="st-btn" onClick={() => onRecap(failed.storyId)}>
              Write it again
            </button>
          }
        >
          {failed.error ?? "Clips Funded could not write the story so far. Tap Write it again."}
        </Notice>
      ) : null}
    </section>
  );
}

/** Who is in the series (the main character first, at most one car): a new episode starts with them. */
function CastSheet({ ws, series: s, onClose, onSaved }: { ws: string; series: Series; onClose: () => void; onSaved: (s: Series) => void }) {
  const chars = useLoad(() => storiesApi().listCharacters(ws), ws, "st-series-chars");
  const [cast, setCast] = useState<string[]>(s.castIds);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const all = chars.data ?? [];

  async function save() {
    if (busy || !chars.data) return;
    const picked = cast.map((id) => all.find((c) => c.characterId === id)).filter((c): c is Character => !!c);
    const why = castProblem(picked);
    if (why) return setProblem(why);
    const castIds = castOrder(cast, all);
    if (castIds.join() === s.castIds.join()) return onClose();
    setBusy(true);
    setProblem(null);
    try {
      onSaved(await storiesApi().patchSeries(ws, s.seriesId, { version: s.version, castIds }));
      onClose();
    } catch (e) {
      setProblem(say(e));
      setBusy(false);
    }
  }

  return (
    <StSheet
      title="Who's in it?"
      onClose={onClose}
      wide
      className="st-series-sheet st-series"
      actions={
        <>
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="st-btn st-btn--main" aria-disabled={busy || !chars.data || undefined} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {chars.data ? <CastPicker characters={all} value={cast} onChange={setCast} /> : <Busy>Getting your characters…</Busy>}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
    </StSheet>
  );
}

function RenameSheet({ ws, series: s, onClose, onSaved }: { ws: string; series: Series; onClose: () => void; onSaved: (s: Series) => void }) {
  const [name, setName] = useState(s.name);
  const [line, setLine] = useState(s.line ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    const why = seriesProblem(name, line, []);
    if (why) return setProblem(why);
    const patch: { version: number; name?: string; line?: string | null } = { version: s.version };
    if (name.trim() !== s.name) patch.name = name.trim();
    if ((line.trim() || null) !== (s.line ?? null)) patch.line = line.trim() || null;
    if (patch.name === undefined && patch.line === undefined) return onClose();
    setBusy(true);
    setProblem(null);
    try {
      onSaved(await storiesApi().patchSeries(ws, s.seriesId, patch));
      onClose();
    } catch (e) {
      setProblem(say(e));
      setBusy(false);
    }
  }

  return (
    <StSheet
      title="Rename"
      onClose={onClose}
      className="st-series-sheet"
      actions={
        <>
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="st-btn st-btn--main" aria-disabled={busy || undefined} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <TextField label="Name" value={name} onChange={setName} max={NAME_MAX} />
      <TextField label="About it (you can skip this)" value={line} onChange={setLine} max={LINE_MAX} />
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
    </StSheet>
  );
}

function CoverSheet({ ws, series: s, cast, onClose, onSaved }: { ws: string; series: Series; cast: Character[]; onClose: () => void; onSaved: (s: Series) => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const choices = useMemo(
    () => [
      ...s.episodes.filter((e) => e.coverUrl).map((e) => ({ key: `s:${e.storyId}`, label: `Ep ${e.number}: ${e.title}`, url: e.coverUrl ?? null, cover: { storyId: e.storyId } as Series["cover"] })),
      ...cast.filter((c) => c.portrait).map((c) => ({ key: `c:${c.characterId}`, label: c.name, url: c.portrait?.url ?? null, cover: { characterId: c.characterId } as Series["cover"] })),
    ],
    [s.episodes, cast],
  );
  const current = s.cover ? ("storyId" in s.cover ? `s:${s.cover.storyId}` : `c:${s.cover.characterId}`) : "auto";

  async function pick(cover: Series["cover"]) {
    setProblem(null);
    try {
      onSaved(await storiesApi().patchSeries(ws, s.seriesId, { version: s.version, cover }));
      onClose();
    } catch (e) {
      setProblem(say(e));
    }
  }

  return (
    <StSheet title="Change cover" onClose={onClose} className="st-series-sheet">
      <ul className="st-series-choices">
        <li>
          <button type="button" className={`st-series-choice${current === "auto" ? " is-on" : ""}`} aria-pressed={current === "auto"} onClick={() => void pick(null)}>
            <span className="st-series-choice__name">Automatic</span>
            <span className="st-series-choice__line">The newest episode</span>
          </button>
        </li>
        {choices.map((c) => (
          <li key={c.key}>
            <button type="button" className={`st-series-choice${current === c.key ? " is-on" : ""}`} aria-pressed={current === c.key} onClick={() => void pick(c.cover)}>
              <span className="st-series-choice__name">{c.label}</span>
            </button>
          </li>
        ))}
      </ul>
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
    </StSheet>
  );
}

function DeleteSheet({ ws, series: s, onClose, onDeleted }: { ws: string; series: Series; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await storiesApi().deleteSeries(ws, s.seriesId);
      onDeleted();
    } catch (e) {
      setProblem(say(e));
      setBusy(false);
    }
  }

  return (
    <StSheet
      title="Delete?"
      onClose={onClose}
      className="st-series-sheet"
      actions={
        <>
          <button type="button" className="st-btn" onClick={onClose}>
            Keep it
          </button>
          <button type="button" className="st-btn st-btn--main" aria-disabled={busy || undefined} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Delete"}
          </button>
        </>
      }
    >
      <p className="st-series-confirm">{`Delete ${s.name}? Its videos stay, under No series.`}</p>
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
    </StSheet>
  );
}
