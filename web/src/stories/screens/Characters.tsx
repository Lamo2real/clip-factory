// Lamo Stories › Characters (docs/CONTRACTS.md §45.8, §45.16.5; spec §5.C). The cast gallery (each rig moving), New
// character (the five-part stepper with a live preview, and Design with AI: the character agent's first try from the
// owner's words and/or a picture, which the owner changes and saves), and each character's own page: edit with its
// version (a 409 means it changed elsewhere: a friendly Reload), Design with AI from words or its own pictures (a
// redesign of this character, §45.34: which parts change is shown before "Use this" puts only those parts into the
// editor, on top of the changes not saved yet), the reference pictures, the AI picture when it is on (else the way to
// Settings › Video › Picture maker), and Delete.
import "../styles/studio.css";
import { useState, type ReactNode } from "react";
import { A } from "../../components/ui.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import type { Character, CharacterInput, CharacterLook, StoriesConfig } from "../api/types.ts";
import { CATALOG } from "../engine/catalog.ts";
import { Glass, GlassPill } from "../glass/index.ts";
import { storiesGoLater } from "../pane.tsx";
import { CharacterPreview } from "../preview/CharacterPreview.tsx";
import { storiesHref } from "../routes.ts";
import { useAiInfo } from "../studio/ai.tsx";
import { CharacterEditor } from "../studio/CharacterEditor.tsx";
import { DesignPanel, RedesignCompare } from "../studio/Design.tsx";
import { useWorkspace } from "../studio/hooks.ts";
import { Busy, celebrate, Notice, StSheet, Tag } from "../studio/kit.tsx";
import { DEFAULT_LOOK, inputOf, MOVE_LINE, newCharacter, showFace } from "../studio/looks.ts";
import { Portrait, References } from "../studio/References.tsx";
import { count, isConflict, say } from "../studio/words.ts";
import { MakeIcon } from "./Ideas.tsx";
import type { StoriesScreenProps } from "./types.ts";

export function CharactersScreen({ ws, page }: StoriesScreenProps) {
  if (page.name === "character_new") return <NewCharacter ws={ws} />;
  if (page.name === "character") return <CharacterPage ws={ws} characterId={page.characterId} />;
  return <Gallery ws={ws} />;
}

/** A character-shaped empty state: a friendly figure waiting to be made. */
export function EmptyCast({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Glass lens className="st-s-empty st-s-make-empty">
      <CharacterPreview look={{ ...DEFAULT_LOOK, outfit: { ...DEFAULT_LOOK.outfit, top: "#62c6ff" } }} movementStyle="bouncy" expression="happy" action="wave" size={140} label="A friendly character waving" />
      <h2 className="st-s-empty__title">{title}</h2>
      <p className="st-s-empty__text">{children}</p>
      {action}
    </Glass>
  );
}

/** Back to the cast: the studio kit's back link with its round glass orb (the same as Production's and Review's). */
function BackToCast() {
  return (
    <A href={storiesHref({ name: "characters" })} className="st-s-back st-s-back--orb">
      <span className="st-s-back__orb">‹</span> Characters
    </A>
  );
}

function Gallery({ ws }: { ws: string }) {
  const list = useLoad(() => storiesApi().listCharacters(ws), ws, "st-characters");
  return (
    <section className="st-page st-studio st-s-make">
      <header className="st-s-head">
        <div className="st-plate st-s-head__text">
          <h1 className="st-s-head__title">Characters</h1>
          <p className="st-s-head__lede">Your cast. Each one looks and moves the same in every video.</p>
        </div>
        <div className="st-s-head__actions">
          <A href={`${storiesHref({ name: "character_new" })}#design`} className="st-btn">
            Design with AI
          </A>
          <A href={storiesHref({ name: "character_new" })} className="st-btn st-btn--main">
            New character
          </A>
        </div>
      </header>
      {list.error && !list.data ? (
        <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => void list.reload()}>Try again</button>}>
          {list.error}
        </Notice>
      ) : !list.data ? (
        <Busy>Getting your cast…</Busy>
      ) : list.data.length === 0 ? (
        <EmptyCast title="No characters yet" action={<A href={storiesHref({ name: "character_new" })} className="st-btn st-btn--main">Make your first character</A>}>
          Make a character once, and use it in all your videos.
        </EmptyCast>
      ) : (
        <ul className="st-s-cast">
          {list.data.map((c) => (
            <li key={c.characterId}>
              <A href={storiesHref({ name: "character", characterId: c.characterId })} className="st-glass st-lens st-s-cast__card">
                <span className="st-s-cast__stage">
                  <CharacterPreview look={c.look} movementStyle={c.movementStyle} action="idle" expression={showFace(c)} size={132} label={`${c.name}, moving`} />
                </span>
                <span className="st-s-cast__name">{c.name}</span>
                <span className="st-s-cast__line">{c.personality || MOVE_LINE[c.movementStyle]}</span>
                <span className="st-s-cast__tags">
                  <Tag tone="sky">{CATALOG.movementStyles.find((m) => m.id === c.movementStyle)?.label ?? c.movementStyle}</Tag>
                  <Tag>In {count(c.storyCount, "video")}</Tag>
                </span>
              </A>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The look's parts a redesign changes as one ("body" is its shape, height and width; "face shape" its eyes to mouth). */
const LOOK_GROUPS: (keyof CharacterLook)[][] = [["body", "height", "width"], ["skin"], ["hair"], ["eyes", "brows", "nose", "mouth"], ["outfit"], ["accessory"], ["outline"]];
const OTHER_PARTS = ["expressions", "movementStyle", "voice", "name", "description", "personality", "traits"] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * "Use this" on a redesign (§45.34): only the parts the redesign changed from the saved character (`before`) go into
 * the editor, on top of what the editor has now (`now`, with its changes not saved yet); every other part stays as
 * the owner left it.
 */
export function mergeRedesign(now: CharacterInput, before: CharacterInput, next: CharacterInput): CharacterInput {
  const out = inputOf(now);
  const look = out.look as unknown as Record<string, unknown>;
  const was = before.look as unknown as Record<string, unknown>;
  const to = next.look as unknown as Record<string, unknown>;
  const grouped = new Set<string>(LOOK_GROUPS.flat());
  const groups: string[][] = [...LOOK_GROUPS, ...Object.keys(to).filter((k) => !grouped.has(k)).map((k) => [k])];
  for (const g of groups) if (g.some((k) => !same(was[k], to[k]))) for (const k of g) look[k] = structuredClone(to[k]);
  const all = out as unknown as Record<string, unknown>;
  for (const k of OTHER_PARTS) if (!same(before[k], next[k])) all[k] = structuredClone(next[k]);
  return out;
}

function NewCharacter({ ws }: { ws: string }) {
  const toast = useToast();
  const info = useAiInfo(ws);
  /** Nothing is saved yet: anything in the editor is unsaved (it asks before the page changes). */
  const [blank] = useState(newCharacter);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The editor starts again from the AI's first try (each try is a new round). */
  const [draft, setDraft] = useState<{ round: number; input: CharacterInput } | null>(null);
  const [design] = useState(() => typeof location !== "undefined" && location.hash === "#design");

  async function save(c: CharacterInput) {
    setSaving(true);
    setProblem(null);
    try {
      const made = await storiesApi().createCharacter(ws, c);
      celebrate(document.querySelector(".st-s-editor__preview"), 130);
      toast.success(`Say hi to ${made.name}!`);
      // After the wait: never while Clip Factory is on screen (it happens once Lamo Stories is back, §45.35 D17).
      storiesGoLater(storiesHref({ name: "character", characterId: made.characterId }), { replace: true });
    } catch (e) {
      setProblem(say(e));
      setSaving(false);
    }
  }

  return (
    <section className="st-page st-studio st-s-make">
      <header className="st-s-head">
        <div className="st-plate st-s-head__text">
          <BackToCast />
          <h1 className="st-s-head__title">New character</h1>
          <p className="st-s-head__lede">Pick how they look, their faces, how they move and their sounds. Then give them a name.</p>
        </div>
      </header>
      <DesignPanel ws={ws} info={info} startOpen={design} onDraft={(input) => setDraft((d) => ({ round: (d?.round ?? 0) + 1, input }))} />
      <CharacterEditor
        key={`new:${draft?.round ?? 0}`}
        initial={draft?.input ?? blank}
        saved={blank}
        startPart={draft ? "name" : undefined}
        mode="new"
        saving={saving}
        onSave={(c) => void save(c)}
        serverProblem={problem ? <Notice tone="bad">{problem}</Notice> : null}
      />
    </section>
  );
}

function CharacterPage({ ws, characterId }: { ws: string; characterId: string }) {
  const toast = useToast();
  const loaded = useLoad(() => storiesApi().getCharacter(ws, characterId), `${ws}:${characterId}`);
  const workspace = useWorkspace(ws);
  const info = useAiInfo(ws);
  const [draft, setDraft] = useState<CharacterInput | null>(null);
  /** The character as the editor has it now (its changes not saved yet too). */
  const [current, setCurrent] = useState<CharacterInput | null>(null);
  /** A redesign the owner has not taken yet: shown beside the character as it is (§45.34). */
  const [proposal, setProposal] = useState<CharacterInput | null>(null);
  // The picked AI picture maker makes the portraits (§45.37: Stability AI or the owner's own; Amazon ended Nova Canvas).
  const [switched, setSwitched] = useState<string | null>(null);
  const pictures = switched ?? ((workspace?.configuration ?? {}) as Partial<StoriesConfig>).providers?.images;
  const aiOn = pictures === "stability" || pictures === "own-images";
  // An older pick of Amazon Nova Canvas reads ended, with one tap to Stability AI's pictures (§45.37 G7).
  const pictureEnded = pictures === "nova-canvas";
  const useStability = async () => {
    const w = await storiesApi().getWorkspace(ws);
    // Only the picture maker and its model: the API checks only what the body names.
    await storiesApi().patchWorkspace(ws, { configuration: { providers: { images: "stability", imageModel: null } }, version: w.version });
    setSwitched("stability");
    toast.success("Portraits now use Stability AI pictures.");
  };
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Bumped to start the editor again from what is saved (after Reload). */
  const [round, setRound] = useState(0);
  const c = loaded.data;

  const replace = (next: Character) => loaded.setData(() => next);
  const savedNow = c ? inputOf(c) : null;
  const inEditor = current ?? draft ?? savedNow;

  async function save(input: CharacterInput) {
    if (!c) return;
    setSaving(true);
    setProblem(null);
    setStale(false);
    try {
      const next = await storiesApi().putCharacter(ws, characterId, { ...input, version: c.version });
      replace(next);
      setDraft(null);
      celebrate(document.querySelector(".st-s-editor__preview"), 90);
      toast.success(`${next.name} is saved.`);
    } catch (e) {
      if (isConflict(e) && !/already have/i.test(say(e))) setStale(true);
      else setProblem(say(e));
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    await loaded.reload();
    setStale(false);
    setDraft(null);
    setRound((n) => n + 1);
  }

  async function remove() {
    if (!c) return;
    setDeleting(true);
    try {
      await storiesApi().deleteCharacter(ws, characterId);
      toast.success(`${c.name} is deleted.`);
      storiesGoLater(storiesHref({ name: "characters" }), { replace: true });
    } catch (e) {
      setAsking(false);
      setProblem(say(e));
    } finally {
      setDeleting(false);
    }
  }

  if (loaded.error && !c)
    return (
      <section className="st-page st-studio st-s-make">
        <Notice tone="bad" action={<A href={storiesHref({ name: "characters" })} className="st-btn">Back to Characters</A>}>
          {loaded.error}
        </Notice>
      </section>
    );
  if (!c)
    return (
      <section className="st-page st-studio st-s-make">
        <Busy>Getting the character…</Busy>
      </section>
    );

  return (
    <section className="st-page st-studio st-s-make">
      <header className="st-s-head">
        <div className="st-plate st-s-head__text">
          <BackToCast />
          <h1 className="st-s-head__title">{c.name}</h1>
          <p className="st-s-head__lede">
            In {count(c.storyCount, "video")}. Changes show in new videos and in a Remake the whole video, never in one already made.
          </p>
        </div>
        <GlassPill icon={<MakeIcon name="delete" size={18} />} onClick={() => setAsking(true)}>
          Delete
        </GlassPill>
      </header>
      <DesignPanel
        ws={ws}
        info={info}
        name={c.name}
        characterId={c.characterId}
        pictures={c.references.map((r) => ({ assetId: r.assetId, url: r.url }))}
        onDraft={(input) => setProposal(input)}
      />
      {proposal && inEditor && savedNow ? (
        <RedesignCompare
          now={inEditor}
          next={mergeRedesign(inEditor, savedNow, proposal)}
          onDrop={() => setProposal(null)}
          onUse={() => {
            setDraft(mergeRedesign(inEditor, savedNow, proposal));
            setProposal(null);
            setRound((n) => n + 1);
          }}
        />
      ) : null}
      {draft ? <Notice tone="info">The new version of {c.name} is in the editor. Nothing changes until you tap Save changes.</Notice> : null}
      <CharacterEditor
        key={`${c.characterId}:${round}`}
        initial={draft ?? inputOf(c)}
        saved={savedNow ?? undefined}
        onChange={setCurrent}
        hold={!deleting}
        mode="edit"
        saving={saving}
        onSave={(input) => void save(input)}
        serverProblem={
          stale ? (
            <Notice
              tone="bad"
              action={
                <button type="button" className="st-btn" onClick={() => void reload()}>
                  Reload
                </button>
              }
            >
              {c.name} was changed somewhere else. Tap Reload to get the newest version, then make your change again.
            </Notice>
          ) : problem ? (
            <Notice tone="bad">{problem}</Notice>
          ) : null
        }
        aside={
          <>
            <References ws={ws} character={c} onChange={replace} />
            <Portrait ws={ws} character={c} aiOn={aiOn} ended={pictureEnded} onReplace={useStability} onChange={replace} />
          </>
        }
      />
      {asking ? (
        <StSheet
          title={`Delete ${c.name}?`}
          onClose={() => setAsking(false)}
          actions={
            <>
              <button type="button" className="st-btn" onClick={() => setAsking(false)}>
                Keep {c.name}
              </button>
              <button type="button" className="st-btn st-s-danger" aria-disabled={deleting || undefined} onClick={() => !deleting && void remove()}>
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </>
          }
        >
          <p>Videos already made keep {c.name}. You can&apos;t undo this.</p>
        </StSheet>
      ) : null}
    </section>
  );
}
