// Lamo Stories › Characters (docs/CONTRACTS.md §45.8, §45.16.5; spec §5.C). The cast gallery (each rig moving), New
// character (the five-part stepper with a live preview), and each character's own page: edit with its version (a 409
// means it changed elsewhere: a friendly Reload), the reference pictures, the AI picture when it is on, and Delete.
import "../styles/studio.css";
import { useState, type ReactNode } from "react";
import { A } from "../../components/ui.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad } from "../../lib/hooks.ts";
import { navigate } from "../../lib/router.ts";
import { storiesApi } from "../api/client.ts";
import type { Character, CharacterInput, StoriesConfig } from "../api/types.ts";
import { CATALOG } from "../engine/catalog.ts";
import { CharacterPreview } from "../preview/CharacterPreview.tsx";
import { storiesHref } from "../routes.ts";
import { CharacterEditor } from "../studio/CharacterEditor.tsx";
import { useWorkspace } from "../studio/hooks.ts";
import { Busy, celebrate, Notice, StSheet, Tag } from "../studio/kit.tsx";
import { DEFAULT_LOOK, inputOf, MOVE_LINE, newCharacter } from "../studio/looks.ts";
import { Portrait, References } from "../studio/References.tsx";
import { count, isConflict, say } from "../studio/words.ts";
import type { StoriesScreenProps } from "./types.ts";

export function CharactersScreen({ ws, page }: StoriesScreenProps) {
  if (page.name === "character_new") return <NewCharacter ws={ws} />;
  if (page.name === "character") return <CharacterPage ws={ws} characterId={page.characterId} />;
  return <Gallery ws={ws} />;
}

/** A character-shaped empty state: a friendly figure waiting to be made. */
export function EmptyCast({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="st-s-empty">
      <CharacterPreview look={{ ...DEFAULT_LOOK, outfit: { ...DEFAULT_LOOK.outfit, top: "#62c6ff" } }} movementStyle="bouncy" expression="happy" action="wave" size={140} label="A friendly character waving" />
      <h2 className="st-s-empty__title">{title}</h2>
      <p className="st-s-empty__text">{children}</p>
      {action}
    </div>
  );
}

function Gallery({ ws }: { ws: string }) {
  const list = useLoad(() => storiesApi().listCharacters(ws), ws, "st-characters");
  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div>
          <h1 className="st-s-head__title">Characters</h1>
          <p className="st-s-head__lede">Your cast. Each one looks and moves the same in every video.</p>
        </div>
        <A href={storiesHref({ name: "character_new" })} className="st-btn st-btn--main">
          New character
        </A>
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
              <A href={storiesHref({ name: "character", characterId: c.characterId })} className="st-s-cast__card">
                <CharacterPreview look={c.look} movementStyle={c.movementStyle} action="idle" expression="happy" size={132} label={`${c.name}, moving`} />
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

function NewCharacter({ ws }: { ws: string }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save(c: CharacterInput) {
    setSaving(true);
    setProblem(null);
    try {
      const made = await storiesApi().createCharacter(ws, c);
      celebrate(document.querySelector(".st-s-editor__preview"), 130);
      toast.success(`Say hi to ${made.name}!`);
      navigate(storiesHref({ name: "character", characterId: made.characterId }), { replace: true });
    } catch (e) {
      setProblem(say(e));
      setSaving(false);
    }
  }

  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div>
          <A href={storiesHref({ name: "characters" })} className="st-s-back">
            ‹ Characters
          </A>
          <h1 className="st-s-head__title">New character</h1>
          <p className="st-s-head__lede">Pick how they look, their faces, how they move and their sounds. Then give them a name.</p>
        </div>
      </header>
      <CharacterEditor initial={newCharacter()} mode="new" saving={saving} onSave={(c) => void save(c)} serverProblem={problem ? <Notice tone="bad">{problem}</Notice> : null} />
    </section>
  );
}

function CharacterPage({ ws, characterId }: { ws: string; characterId: string }) {
  const toast = useToast();
  const loaded = useLoad(() => storiesApi().getCharacter(ws, characterId), `${ws}:${characterId}`);
  const workspace = useWorkspace(ws);
  const aiOn = ((workspace?.configuration ?? {}) as Partial<StoriesConfig>).providers?.images === "nova-canvas";
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Bumped to start the editor again from what is saved (after Reload). */
  const [round, setRound] = useState(0);
  const c = loaded.data;

  const replace = (next: Character) => loaded.setData(() => next);

  async function save(input: CharacterInput) {
    if (!c) return;
    setSaving(true);
    setProblem(null);
    setStale(false);
    try {
      const next = await storiesApi().putCharacter(ws, characterId, { ...input, version: c.version });
      replace(next);
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
    setRound((n) => n + 1);
  }

  async function remove() {
    if (!c) return;
    setDeleting(true);
    try {
      await storiesApi().deleteCharacter(ws, characterId);
      toast.success(`${c.name} is deleted.`);
      navigate(storiesHref({ name: "characters" }), { replace: true });
    } catch (e) {
      setAsking(false);
      setProblem(say(e));
    } finally {
      setDeleting(false);
    }
  }

  if (loaded.error && !c)
    return (
      <section className="st-page st-studio">
        <Notice tone="bad" action={<A href={storiesHref({ name: "characters" })} className="st-btn">Back to Characters</A>}>
          {loaded.error}
        </Notice>
      </section>
    );
  if (!c)
    return (
      <section className="st-page st-studio">
        <Busy>Getting the character…</Busy>
      </section>
    );

  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div>
          <A href={storiesHref({ name: "characters" })} className="st-s-back">
            ‹ Characters
          </A>
          <h1 className="st-s-head__title">{c.name}</h1>
          <p className="st-s-head__lede">
            In {count(c.storyCount, "video")}. Changes show in new videos and in a Remake the whole video, never in one already made.
          </p>
        </div>
        <button type="button" className="st-btn st-s-quiet" onClick={() => setAsking(true)}>
          Delete
        </button>
      </header>
      <CharacterEditor
        key={`${c.characterId}:${round}`}
        initial={inputOf(c)}
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
            <Portrait ws={ws} character={c} aiOn={aiOn} onChange={replace} />
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
