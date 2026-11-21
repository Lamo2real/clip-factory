// Lamo Stories › Ideas (docs/CONTRACTS.md §45.7, §45.16.5; spec §5.B). A board of idea cards (saved and used), New idea
// (typed by hand), Ask for ideas (a topic and a kind: drafts the owner saves one by one), and on each card Make it a
// full idea (the whole concept), More like this (more drafts), Make the video and Delete (with Undo). A driving-safety
// idea shows the checked advice it is based on, or "Needs checked advice" and then cannot become a video.
import "../styles/studio.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad } from "../../lib/hooks.ts";
import { navigate } from "../../lib/router.ts";
import { storiesApi } from "../api/client.ts";
import type { GuidanceTopic, Idea, IdeaCategory, IdeaInput, StoriesConfig } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { useWorkspace } from "../studio/hooks.ts";
import { Busy, celebrate, Notice, Pick, Tag, TextField } from "../studio/kit.tsx";
import { CATEGORIES, CATEGORY_LABEL, CATEGORY_LINE, NO_GUIDANCE, say, seconds, TONE_LABEL } from "../studio/words.ts";
import type { StoriesScreenProps } from "./types.ts";

type Filter = "all" | "saved" | "used";
type Kind = IdeaCategory | "any";

const CATEGORY_TONE: Record<IdeaCategory, "sun" | "coral" | "mint" | "sky"> = {
  driving_safety: "coral",
  everyday_skills: "mint",
  comedy: "sun",
  explainer: "sky",
};

/** The four kinds as big buttons. */
export const KIND_OPTIONS = CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c], line: CATEGORY_LINE[c] }));

interface DraftSet {
  from: string;
  drafts: { input: IdeaInput; saved: boolean; saving: boolean }[];
}

/** The checked advice an idea is based on, in one line. */
export function adviceLine(idea: Pick<Idea, "category" | "safetyTopicId" | "needsGuidance">, topics: GuidanceTopic[] | null): string | null {
  if (idea.category !== "driving_safety") return null;
  if (idea.needsGuidance || !idea.safetyTopicId) return null;
  const topic = topics?.find((t) => t.id === idea.safetyTopicId);
  if (!topic) return "Based on checked road advice.";
  const pubs = [...new Set(topic.citations.map((c) => c.publisher))].slice(0, 2);
  return `Checked advice: ${topic.title}${pubs.length ? `. From ${pubs.join(" and ")}` : ""}.`;
}

export function IdeasScreen({ ws }: StoriesScreenProps) {
  const toast = useToast();
  const ideas = useLoad(() => storiesApi().listIdeas(ws, "all"), ws, "st-ideas");
  const [topics, setTopics] = useState<GuidanceTopic[] | null>(null);
  const workspace = useWorkspace(ws);
  const length = ((workspace?.configuration ?? {}) as Partial<StoriesConfig>).defaultDurationSec ?? 45;
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<"none" | "new" | "ask">("none");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<DraftSet | null>(null);
  const draftsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let live = true;
    storiesApi()
      .guidance(ws)
      .then((g) => live && setTopics(g.topics))
      .catch(() => live && setTopics(null));
    return () => {
      live = false;
    };
  }, [ws]);

  const shown = useMemo(() => (ideas.data ?? []).filter((i) => !hidden.has(i.ideaId) && (filter === "all" || i.status === filter)), [ideas.data, hidden, filter]);
  const all = (ideas.data ?? []).filter((i) => !hidden.has(i.ideaId));

  const put = (idea: Idea) => ideas.setData((list) => (list ? (list.some((i) => i.ideaId === idea.ideaId) ? list.map((i) => (i.ideaId === idea.ideaId ? idea : i)) : [idea, ...list]) : [idea]));

  function showDrafts(set: DraftSet) {
    setDrafts(set);
    requestAnimationFrame(() => draftsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" }));
  }

  async function saveDraft(k: number) {
    const d = drafts?.drafts[k];
    if (!d || d.saved || d.saving) return;
    setDrafts((s) => (s ? { ...s, drafts: s.drafts.map((x, i) => (i === k ? { ...x, saving: true } : x)) } : s));
    try {
      const idea = await storiesApi().createIdea(ws, d.input);
      put(idea);
      setDrafts((s) => (s ? { ...s, drafts: s.drafts.map((x, i) => (i === k ? { ...x, saving: false, saved: true } : x)) } : s));
      celebrate(document.querySelector(`[data-draft="${k}"]`), 50);
      toast.success(`Saved “${idea.title}”.`);
    } catch (e) {
      setDrafts((s) => (s ? { ...s, drafts: s.drafts.map((x, i) => (i === k ? { ...x, saving: false } : x)) } : s));
      toast.error(say(e));
    }
  }

  function remove(idea: Idea) {
    setHidden((h) => new Set(h).add(idea.ideaId));
    const back = () =>
      setHidden((h) => {
        const n = new Set(h);
        n.delete(idea.ideaId);
        return n;
      });
    toast.undo(`Deleted “${idea.title}”.`, {
      onUndo: back,
      onCommit: () => {
        storiesApi()
          .deleteIdea(ws, idea.ideaId)
          .then(() => ideas.setData((list) => (list ? list.filter((i) => i.ideaId !== idea.ideaId) : list)))
          .catch((e) => {
            back();
            toast.error(say(e, "That idea could not be deleted. Try again."));
          });
      },
    });
  }

  const counts = { all: all.length, saved: all.filter((i) => i.status === "saved").length, used: all.filter((i) => i.status === "used").length };

  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div>
          <h1 className="st-s-head__title">Ideas</h1>
          <p className="st-s-head__lede">Keep ideas for videos here. Make one into a video when you are ready.</p>
        </div>
        <div className="st-s-head__actions">
          <button type="button" className="st-btn" aria-expanded={open === "ask"} onClick={() => setOpen((o) => (o === "ask" ? "none" : "ask"))}>
            Ask for ideas
          </button>
          <button type="button" className="st-btn st-btn--main" aria-expanded={open === "new"} onClick={() => setOpen((o) => (o === "new" ? "none" : "new"))}>
            New idea
          </button>
        </div>
      </header>

      {open === "new" ? (
        <NewIdeaForm
          onCancel={() => setOpen("none")}
          onSave={async (input) => {
            const idea = await storiesApi().createIdea(ws, input);
            put(idea);
            setOpen("none");
            setFilter("all");
            celebrate(document.querySelector(".st-s-head__actions"), 80);
            toast.success(`Saved “${idea.title}”.`);
          }}
        />
      ) : null}
      {open === "ask" ? <AskForIdeas ws={ws} onCancel={() => setOpen("none")} onDrafts={(list, from) => showDrafts({ from, drafts: list.map((input) => ({ input, saved: false, saving: false })) })} /> : null}

      {drafts ? (
        <section className="st-s-drafts" ref={draftsRef} aria-labelledby="st-drafts-title">
          <div className="st-s-drafts__head">
            <h2 className="st-s-drafts__title" id="st-drafts-title">
              {drafts.from}
            </h2>
            <button type="button" className="st-btn st-s-quiet" onClick={() => setDrafts(null)}>
              Done
            </button>
          </div>
          <p className="st-s-drafts__lede">Nothing is kept until you tap Save.</p>
          <ul className="st-s-drafts__list">
            {drafts.drafts.map((d, k) => (
              <li key={k} className={`st-s-draft${d.saved ? " is-saved" : ""}`} data-draft={k}>
                <Tag tone={CATEGORY_TONE[d.input.category]}>{CATEGORY_LABEL[d.input.category]}</Tag>
                <h3 className="st-s-draft__title">{d.input.title}</h3>
                <p className="st-s-draft__line">{d.input.logline}</p>
                <button type="button" className={`st-btn${d.saved ? "" : " st-btn--main"}`} aria-disabled={d.saved || d.saving || undefined} onClick={() => void saveDraft(k)}>
                  {d.saved ? "✓ Saved" : d.saving ? "Saving…" : "Save"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Pick
        label="Show"
        hideLabel
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: `All (${counts.all})` },
          { value: "saved", label: `Saved (${counts.saved})` },
          { value: "used", label: `Made into videos (${counts.used})` },
        ]}
        className="st-s-filter"
      />

      {ideas.error && !ideas.data ? (
        <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => void ideas.reload()}>Try again</button>}>
          {ideas.error}
        </Notice>
      ) : !ideas.data ? (
        <Busy>Getting your ideas…</Busy>
      ) : shown.length === 0 ? (
        <div className="st-s-empty">
          <span className="st-s-empty__bulb" aria-hidden="true" />
          <h2 className="st-s-empty__title">{filter === "all" ? "No ideas yet" : filter === "saved" ? "No saved ideas waiting" : "No ideas made into videos yet"}</h2>
          <p className="st-s-empty__text">Tap New idea to type one, or Ask for ideas to get a few to pick from.</p>
        </div>
      ) : (
        <ul className="st-s-board">
          {shown.map((idea) => (
            <IdeaCard
              key={idea.ideaId}
              ws={ws}
              idea={idea}
              topics={topics}
              length={length}
              onChange={put}
              onDelete={() => remove(idea)}
              onDrafts={(list) => showDrafts({ from: `More like “${idea.title}”`, drafts: list.map((input) => ({ input, saved: false, saving: false })) })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function NewIdeaForm({ onSave, onCancel }: { onSave: (i: IdeaInput) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [logline, setLogline] = useState("");
  const [category, setCategory] = useState<IdeaCategory | "">("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!title.trim()) return setProblem("Give the idea a title.");
    if (title.trim().length > 80) return setProblem("Keep the title to 80 letters.");
    if (!logline.trim()) return setProblem("Write one line about what happens.");
    if (logline.trim().length > 280) return setProblem("Keep the line to 280 letters.");
    if (!category) return setProblem("Pick what kind of video it is.");
    setBusy(true);
    setProblem(null);
    try {
      await onSave({ title: title.trim(), logline: logline.trim(), category, source: "manual" });
    } catch (e) {
      setProblem(say(e));
      setBusy(false);
    }
  }

  return (
    <form
      className="st-s-panel"
      aria-label="New idea"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="st-s-panel__title">New idea</h2>
      <TextField label="Title" value={title} onChange={setTitle} max={80} placeholder="For example: Pip and the icy hill" />
      <TextField label="What happens, in one line" value={logline} onChange={setLogline} max={280} multiline rows={2} placeholder="For example: Pip's car slides on ice and Pip stays calm." />
      <Pick label="What kind of video?" big value={category} options={KIND_OPTIONS} onChange={setCategory} />
      {category === "driving_safety" ? <p className="st-s-field__hint">Driving-safety videos only use checked advice from road authorities.</p> : null}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      <div className="st-s-actionbar">
        <button type="button" className="st-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="st-btn st-btn--main" aria-disabled={busy || undefined}>
          {busy ? "Saving…" : "Save idea"}
        </button>
      </div>
    </form>
  );
}

function AskForIdeas({ ws, onDrafts, onCancel }: { ws: string; onDrafts: (d: IdeaInput[], from: string) => void; onCancel: () => void }) {
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState<Kind>("any");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function ask() {
    if (topic.length > 200) return setProblem("Keep the topic to 200 letters.");
    setBusy(true);
    setProblem(null);
    try {
      const body: { topic?: string; category?: IdeaCategory; count: number } = { count: 4 };
      if (topic.trim()) body.topic = topic.trim();
      if (kind !== "any") body.category = kind;
      const drafts = await storiesApi().generateIdeas(ws, body);
      if (!drafts.length) setProblem("No ideas came back. Try another topic.");
      else onDrafts(drafts, topic.trim() ? `Ideas about “${topic.trim()}”` : "Fresh ideas");
    } catch (e) {
      setProblem(say(e, "The idea helper is busy. Try again in a minute."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="st-s-panel"
      aria-label="Ask for ideas"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void ask();
      }}
    >
      <h2 className="st-s-panel__title">Ask for ideas</h2>
      <TextField label="What about? (you can leave this empty)" value={topic} onChange={setTopic} max={200} placeholder="For example: a snowy day" />
      <Pick label="What kind?" big value={kind} options={[{ value: "any", label: "Any kind", line: "A mix of everything" }, ...KIND_OPTIONS]} onChange={setKind} />
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      {busy ? <Busy>Thinking of ideas…</Busy> : null}
      <div className="st-s-actionbar">
        <button type="button" className="st-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="st-btn st-btn--main" aria-disabled={busy || undefined}>
          {busy ? "Thinking…" : "Get ideas"}
        </button>
      </div>
    </form>
  );
}

function IdeaCard({
  ws,
  idea,
  topics,
  length,
  onChange,
  onDelete,
  onDrafts,
}: {
  ws: string;
  idea: Idea;
  topics: GuidanceTopic[] | null;
  length: number;
  onChange: (i: Idea) => void;
  onDelete: () => void;
  onDrafts: (d: IdeaInput[]) => void;
}) {
  const [busy, setBusy] = useState<"none" | "expand" | "more">("none");
  const [problem, setProblem] = useState<string | null>(null);
  const [showConcept, setShowConcept] = useState(false);
  const advice = adviceLine(idea, topics);
  const blocked = idea.category === "driving_safety" && (idea.needsGuidance || !idea.safetyTopicId);

  async function expand() {
    if (blocked || busy !== "none") return;
    setBusy("expand");
    setProblem(null);
    try {
      const next = await storiesApi().expandIdea(ws, idea.ideaId, { durationSec: Math.min(90, Math.max(15, length)) });
      onChange(next);
      setShowConcept(true);
    } catch (e) {
      setProblem(say(e, "The idea helper is busy. Try again in a minute."));
    } finally {
      setBusy("none");
    }
  }

  async function more() {
    if (busy !== "none") return;
    setBusy("more");
    setProblem(null);
    try {
      onDrafts(await storiesApi().ideaVariations(ws, idea.ideaId, { count: 3 }));
    } catch (e) {
      setProblem(say(e, "The idea helper is busy. Try again in a minute."));
    } finally {
      setBusy("none");
    }
  }

  const c = idea.concept;
  return (
    <li className={`st-s-idea st-s-idea--${idea.category}`}>
      <span className="st-s-idea__tags">
        <Tag tone={CATEGORY_TONE[idea.category]}>{CATEGORY_LABEL[idea.category]}</Tag>
        {idea.status === "used" ? <Tag tone="mint">In {idea.storyIds.length === 1 ? "1 video" : `${idea.storyIds.length} videos`}</Tag> : <Tag>Saved</Tag>}
        {blocked ? <Tag tone="coral">Needs checked advice</Tag> : null}
      </span>
      <h2 className="st-s-idea__title">{idea.title}</h2>
      <p className="st-s-idea__line">{idea.logline}</p>
      {advice ? <p className="st-s-idea__advice">{advice}</p> : null}
      {blocked ? <p className="st-s-idea__advice is-bad">{NO_GUIDANCE}</p> : null}

      {c && showConcept ? (
        <div className="st-s-concept" aria-label={`The full idea for ${idea.title}`}>
          <p className="st-s-concept__premise">{c.premise}</p>
          <ol className="st-s-concept__beats">
            {c.beats.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ol>
          {c.lesson ? (
            <p>
              <strong>The lesson:</strong> {c.lesson}
            </p>
          ) : null}
          <p>
            <strong>The ending:</strong> {c.ending}
          </p>
          <p className="st-s-concept__meta">
            <Tag tone="sky">{TONE_LABEL[c.tone]}</Tag>
            <Tag>{seconds(c.durationSec)}</Tag>
          </p>
          {c.onScreenText.length ? (
            <p className="st-concept__words">
              <strong>Words on screen:</strong> {c.onScreenText.map((t) => `“${t}”`).join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      {busy === "expand" ? <Busy>Writing the full idea…</Busy> : busy === "more" ? <Busy>Thinking of more…</Busy> : null}

      <span className="st-s-idea__actions">
        <button
          type="button"
          className="st-btn st-btn--main"
          aria-disabled={blocked || undefined}
          title={blocked ? NO_GUIDANCE : undefined}
          onClick={() => {
            if (!blocked) navigate(storiesHref({ name: "production_new", ideaId: idea.ideaId }));
          }}
        >
          Make the video
        </button>
        {c ? (
          <button type="button" className="st-btn" aria-expanded={showConcept} onClick={() => setShowConcept((s) => !s)}>
            {showConcept ? "Hide the full idea" : "See the full idea"}
          </button>
        ) : (
          <button type="button" className="st-btn" aria-disabled={blocked || busy !== "none" || undefined} title={blocked ? NO_GUIDANCE : undefined} onClick={() => void expand()}>
            Make it a full idea
          </button>
        )}
        {c && showConcept ? (
          <button type="button" className="st-btn" aria-disabled={blocked || busy !== "none" || undefined} onClick={() => void expand()}>
            Write it again
          </button>
        ) : null}
        <button type="button" className="st-btn" aria-disabled={busy !== "none" || undefined} onClick={() => void more()}>
          More like this
        </button>
        <button type="button" className="st-btn st-s-quiet" onClick={onDelete}>
          Delete
        </button>
      </span>
    </li>
  );
}
