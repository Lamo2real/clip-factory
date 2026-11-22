// Lamo Stories › Ideas (docs/CONTRACTS.md §45.7, §45.16.5; spec §5.B). A board of idea cards (saved and used), New idea
// (typed by hand), Ask for ideas (a topic and a kind: drafts the owner saves one by one), and on each card Make it a
// full idea (the whole concept), More like this (more drafts), Make the video and Delete (with Undo). Ask for ideas,
// Make it a full idea and More like this are tasks of Lamo Stories' creative director: each one is read every second
// with a line that names the model and the effort, ends with the drafts or a plain sentence and Try again, and has its
// own small "Model and effort for this one" menu (never saved). A driving-safety idea shows the checked advice it is
// based on, or "Needs checked advice" and then cannot become a video. Edit (§45.34) changes a saved idea's title, line
// and kind, and the parts of its full idea (what it is about, the steps, the lesson, the ending, the feel, the length
// and the words on screen), saved with PATCH …/ideas/{ideaId}.
import "../styles/studio.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad } from "../../lib/hooks.ts";
import { navigate } from "../../lib/router.ts";
import { storiesApi } from "../api/client.ts";
import type { AiTask, GuidanceTopic, Idea, IdeaCategory, IdeaInput, ModelOverride, StoriesConfig, VideoConcept } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { cleanPick, merged, ModelMenu, TaskLine, useAiInfo, useAiTask, usualFor, type AiInfo } from "../studio/ai.tsx";
import { useWorkspace } from "../studio/hooks.ts";
import { Busy, celebrate, Notice, Pick, Slider, Tag, TextField } from "../studio/kit.tsx";
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

/** The drafts a finished task carries (result.drafts), kept to the fields an idea has. */
export function draftsOf(task: AiTask): IdeaInput[] {
  const raw = (task.result as { drafts?: unknown } | null)?.drafts;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is IdeaInput => !!d && typeof d === "object" && typeof (d as IdeaInput).title === "string" && typeof (d as IdeaInput).logline === "string" && typeof (d as IdeaInput).category === "string")
    .map((d) => {
      const out: IdeaInput = { title: d.title, logline: d.logline, category: d.category, source: d.source ?? "ai" };
      if (d.characterIds?.length) out.characterIds = [...d.characterIds];
      if (d.parentIdeaId) out.parentIdeaId = d.parentIdeaId;
      if (d.concept) out.concept = d.concept;
      return out;
    });
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
  const info = useAiInfo(ws);
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
      {open === "ask" ? <AskForIdeas ws={ws} info={info} onCancel={() => setOpen("none")} onDrafts={(list, from) => showDrafts({ from, drafts: list.map((input) => ({ input, saved: false, saving: false })) })} /> : null}

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
              info={info}
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

const TONES: VideoConcept["tone"][] = ["funny", "calm", "tense_then_relief", "wholesome"];

/** Why this edit of an idea cannot be saved (the API's limits, §45.6 VideoConcept), or null. */
export function ideaProblem(i: Pick<IdeaInput, "title" | "logline"> & { category: IdeaCategory | "" }, c: VideoConcept | null): string | null {
  if (!i.title.trim()) return "Give the idea a title.";
  if (i.title.trim().length > 80) return "Keep the title to 80 letters.";
  if (!i.logline.trim()) return "Write one line about what happens.";
  if (i.logline.trim().length > 280) return "Keep the line to 280 letters.";
  if (!i.category) return "Pick what kind of video it is.";
  if (!c) return null;
  if (!c.premise.trim()) return "Say what the full idea is about.";
  if (c.premise.trim().length > 600) return "Keep what it is about to 600 letters.";
  const beats = c.beats.map((b) => b.trim()).filter(Boolean);
  if (beats.length < 3 || beats.length > 8) return "A full idea needs 3 to 8 steps.";
  const longBeat = c.beats.findIndex((b) => b.trim().length > 160);
  if (longBeat >= 0) return `Step ${longBeat + 1} is too long: keep it to 160 letters.`;
  if ((c.lesson ?? "").trim().length > 280) return "Keep the lesson to 280 letters.";
  if (!c.ending.trim()) return "Say how it ends.";
  if (c.ending.trim().length > 280) return "Keep the ending to 280 letters.";
  const words = c.onScreenText.map((t) => t.trim()).filter(Boolean);
  if (words.length > 6) return "Up to 6 words on screen.";
  const longWords = c.onScreenText.findIndex((t) => t.trim().length > 60);
  if (longWords >= 0) return `Words ${longWords + 1} are too long: keep them to 60 letters.`;
  return null;
}

/** Only what the owner changed, ready for PATCH …/ideas/{ideaId} (a full idea goes whole). */
export function ideaPatch(idea: Idea, next: { title: string; logline: string; category: IdeaCategory }, concept: VideoConcept | null): Partial<IdeaInput> {
  const patch: Partial<IdeaInput> = {};
  if (next.title.trim() !== idea.title) patch.title = next.title.trim();
  if (next.logline.trim() !== idea.logline) patch.logline = next.logline.trim();
  if (next.category !== idea.category) patch.category = next.category;
  if (concept && idea.concept) {
    const clean: VideoConcept = {
      premise: concept.premise.trim(),
      beats: concept.beats.map((b) => b.trim()).filter(Boolean),
      lesson: (concept.lesson ?? "").trim() || null,
      ending: concept.ending.trim(),
      tone: concept.tone,
      durationSec: concept.durationSec,
      onScreenText: concept.onScreenText.map((t) => t.trim()).filter(Boolean),
    };
    if (JSON.stringify(clean) !== JSON.stringify(idea.concept)) patch.concept = clean;
  }
  return patch;
}

/** A list of short lines with Add and Remove (the full idea's steps, the words on screen). */
function Lines({ label, item, lines, max, most, least = 0, onChange }: { label: string; item: string; lines: string[]; max: number; most: number; least?: number; onChange: (l: string[]) => void }) {
  return (
    <fieldset className="st-s-group st-s-lines">
      <legend className="st-s-group__title">{label}</legend>
      <ol className="st-s-lines__list">
        {lines.map((line, i) => (
          <li key={i} className="st-s-lines__row">
            <TextField label={`${item} ${i + 1}`} value={line} max={max} onChange={(v) => onChange(lines.map((x, k) => (k === i ? v : x)))} />
            <button type="button" className="st-btn st-s-small st-s-quiet" aria-disabled={lines.length <= least || undefined} onClick={() => lines.length > least && onChange(lines.filter((_, k) => k !== i))}>
              Remove<span className="st-s-sr">{` ${item.toLowerCase()} ${i + 1}`}</span>
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="st-btn st-s-small" aria-disabled={lines.length >= most || undefined} onClick={() => lines.length < most && onChange([...lines, ""])}>
        {lines.length >= most ? `${most} is the most` : `Add ${item.toLowerCase()}`}
      </button>
    </fieldset>
  );
}

/** Edit a saved idea (§45.34): its title, line and kind, and an expanded idea's parts. */
function EditIdeaForm({ idea, onSave, onCancel }: { idea: Idea; onSave: (patch: Partial<IdeaInput>) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(idea.title);
  const [logline, setLogline] = useState(idea.logline);
  const [category, setCategory] = useState<IdeaCategory | "">(idea.category);
  const [concept, setConcept] = useState<VideoConcept | null>(() => (idea.concept ? structuredClone(idea.concept) : null));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setPart = (part: Partial<VideoConcept>) => {
    setProblem(null);
    setConcept((c) => (c ? { ...c, ...part } : c));
  };

  async function save() {
    const why = ideaProblem({ title, logline, category }, concept);
    if (why) return setProblem(why);
    const patch = ideaPatch(idea, { title, logline, category: category as IdeaCategory }, concept);
    if (!Object.keys(patch).length) return onCancel();
    setBusy(true);
    setProblem(null);
    try {
      await onSave(patch);
    } catch (e) {
      setProblem(say(e));
      setBusy(false);
    }
  }

  return (
    <form
      className="st-s-ideaedit"
      aria-label={`Edit ${idea.title}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <TextField label="Title" value={title} onChange={setTitle} max={80} />
      <TextField label="What happens, in one line" value={logline} onChange={setLogline} max={280} multiline rows={2} />
      <Pick label="What kind of video?" big value={category} options={KIND_OPTIONS} onChange={setCategory} />
      {category === "driving_safety" ? <p className="st-s-field__hint">Driving-safety videos only use checked advice from road authorities.</p> : null}
      {concept ? (
        <fieldset className="st-s-group">
          <legend className="st-s-group__title">The full idea</legend>
          <TextField label="What it is about" value={concept.premise} max={600} multiline rows={3} onChange={(premise) => setPart({ premise })} />
          <Lines label="What happens, step by step" item="Step" lines={concept.beats} max={160} most={8} least={3} onChange={(beats) => setPart({ beats })} />
          <TextField label="The lesson (you can leave this empty)" value={concept.lesson ?? ""} max={280} multiline rows={2} onChange={(lesson) => setPart({ lesson })} />
          <TextField label="How it ends" value={concept.ending} max={280} multiline rows={2} onChange={(ending) => setPart({ ending })} />
          <Pick label="How it feels" value={concept.tone} options={TONES.map((t) => ({ value: t, label: TONE_LABEL[t] }))} onChange={(tone) => setPart({ tone })} />
          <Slider label="Length" min={15} max={90} step={5} value={concept.durationSec} words={seconds(concept.durationSec)} onChange={(durationSec) => setPart({ durationSec })} />
          <Lines label="Words on screen" item="Words" lines={concept.onScreenText} max={60} most={6} onChange={(onScreenText) => setPart({ onScreenText })} />
        </fieldset>
      ) : null}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      <div className="st-s-actionbar">
        <button type="button" className="st-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="st-btn st-btn--main" aria-disabled={busy || undefined}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

function AskForIdeas({ ws, info, onDrafts, onCancel }: { ws: string; info: AiInfo; onDrafts: (d: IdeaInput[], from: string) => void; onCancel: () => void }) {
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState<Kind>("any");
  const [pick, setPick] = useState<ModelOverride | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const asked = useRef("");
  const run = useAiTask(ws, (task) => {
    const drafts = draftsOf(task);
    if (!drafts.length) setProblem("No ideas came back. Try another topic.");
    else onDrafts(drafts, asked.current ? `Ideas about “${asked.current}”` : "Fresh ideas");
  }, () => ask());
  const usual = usualFor(info, "brainstorm");
  const busy = run.phase === "working";

  function ask() {
    if (topic.length > 200) return setProblem("Keep the topic to 200 letters.");
    setProblem(null);
    const body: { topic?: string; category?: IdeaCategory; count: number; override?: ModelOverride } = { count: 4 };
    if (topic.trim()) body.topic = topic.trim();
    if (kind !== "any") body.category = kind;
    const override = cleanPick(pick);
    if (override) body.override = override;
    asked.current = topic.trim();
    void run.start(() => storiesApi().generateIdeas(ws, body));
  }

  return (
    <form
      className="st-s-panel"
      aria-label="Ask for ideas"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) ask();
      }}
    >
      <h2 className="st-s-panel__title">Ask for ideas</h2>
      <TextField label="What about? (you can leave this empty)" value={topic} onChange={setTopic} max={200} placeholder="For example: a snowy day" />
      <Pick label="What kind?" big value={kind} options={[{ value: "any", label: "Any kind", line: "A mix of everything" }, ...KIND_OPTIONS]} onChange={setKind} />
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      <TaskLine info={info} kind="brainstorm" run={run} expected={merged(info, usual, pick)} />
      <div className="st-s-actionbar">
        <button type="button" className="st-btn" onClick={onCancel}>
          Cancel
        </button>
        <ModelMenu info={info} usual={usual} value={pick} onChange={setPick} />
        <button type="submit" className="st-btn st-btn--main" aria-disabled={busy || undefined}>
          {busy ? "Thinking…" : "Get ideas"}
        </button>
      </div>
    </form>
  );
}

function IdeaCard({
  ws,
  info,
  idea,
  topics,
  length,
  onChange,
  onDelete,
  onDrafts,
}: {
  ws: string;
  info: AiInfo;
  idea: Idea;
  topics: GuidanceTopic[] | null;
  length: number;
  onChange: (i: Idea) => void;
  onDelete: () => void;
  onDrafts: (d: IdeaInput[]) => void;
}) {
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const [showConcept, setShowConcept] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expandPick, setExpandPick] = useState<ModelOverride | null>(null);
  const [morePick, setMorePick] = useState<ModelOverride | null>(null);
  const advice = adviceLine(idea, topics);
  const blocked = idea.category === "driving_safety" && (idea.needsGuidance || !idea.safetyTopicId);
  const expanding = useAiTask(ws, (task) => {
    const next = (task.result as { idea?: Idea } | null)?.idea;
    if (next && next.ideaId === idea.ideaId) {
      onChange(next);
      setShowConcept(true);
    } else setProblem("The full idea did not come back. Tap Try again.");
  }, () => expand());
  const varying = useAiTask(ws, (task) => {
    const drafts = draftsOf(task);
    if (drafts.length) onDrafts(drafts);
    else setProblem("No ideas came back. Tap More like this again.");
  }, () => more());
  const busy = expanding.phase === "working" || varying.phase === "working";
  const expandUsual = usualFor(info, "expand_idea");
  const moreUsual = usualFor(info, "variations");

  function expand() {
    if (blocked || busy) return;
    setProblem(null);
    varying.reset();
    // "Write it again" keeps the full idea's own length (§45.35 D21); a first try starts from the workspace's length.
    const body: { durationSec: number; override?: ModelOverride } = { durationSec: Math.min(90, Math.max(15, idea.concept?.durationSec ?? length)) };
    const override = cleanPick(expandPick);
    if (override) body.override = override;
    void expanding.start(() => storiesApi().expandIdea(ws, idea.ideaId, body));
  }

  function more() {
    if (busy) return;
    setProblem(null);
    expanding.reset();
    const body: { count: number; override?: ModelOverride } = { count: 3 };
    const override = cleanPick(morePick);
    if (override) body.override = override;
    void varying.start(() => storiesApi().ideaVariations(ws, idea.ideaId, body));
  }

  const c = idea.concept;
  if (editing)
    return (
      <li className={`st-s-idea st-s-idea--${idea.category} is-editing`} data-idea={idea.ideaId}>
        <h2 className="st-s-idea__title">Edit “{idea.title}”</h2>
        <EditIdeaForm
          idea={idea}
          onCancel={() => setEditing(false)}
          onSave={async (patch) => {
            const next = await storiesApi().patchIdea(ws, idea.ideaId, patch);
            onChange(next);
            setEditing(false);
            if (next.concept && patch.concept) setShowConcept(true);
            celebrate(document.querySelector(`[data-idea="${idea.ideaId}"]`), 60);
            toast.success(`Saved “${next.title}”.`);
          }}
        />
      </li>
    );
  return (
    <li className={`st-s-idea st-s-idea--${idea.category}`} data-idea={idea.ideaId}>
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
            <p className="st-s-concept__words">
              <strong>Words on screen:</strong> {c.onScreenText.map((t) => `“${t}”`).join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      <TaskLine info={info} kind="expand_idea" run={expanding} expected={merged(info, expandUsual, expandPick)} />
      <TaskLine info={info} kind="variations" run={varying} expected={merged(info, moreUsual, morePick)} />

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
        ) : null}
        {!c || showConcept ? (
          <span className="st-s-aipair">
            <button type="button" className="st-btn" aria-disabled={blocked || busy || undefined} title={blocked ? NO_GUIDANCE : undefined} onClick={expand}>
              {expanding.phase === "working" ? "Writing…" : c ? "Write it again" : "Make it a full idea"}
            </button>
            <ModelMenu info={info} usual={expandUsual} value={expandPick} onChange={setExpandPick} compact />
          </span>
        ) : null}
        <span className="st-s-aipair">
          <button type="button" className="st-btn" aria-disabled={busy || undefined} onClick={more}>
            {varying.phase === "working" ? "Thinking…" : "More like this"}
          </button>
          <ModelMenu info={info} usual={moreUsual} value={morePick} onChange={setMorePick} compact />
        </span>
        <button type="button" className="st-btn" aria-disabled={busy || undefined} onClick={() => !busy && setEditing(true)}>
          Edit<span className="st-s-sr"> {idea.title}</span>
        </button>
        <button type="button" className="st-btn st-s-quiet" onClick={onDelete}>
          Delete
        </button>
      </span>
    </li>
  );
}
