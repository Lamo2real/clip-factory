// Lamo Stories › Characters (docs/CONTRACTS.md §45.8, §45.16.5; spec §5.C). The cast gallery (each rig moving), New
// character (the five-part stepper with a live preview, and Design with AI: the character agent's first try from the
// owner's words and/or a picture, which the owner changes and saves), and each character's own page: edit with its
// version (a 409 means it changed elsewhere: a friendly Reload), Design with AI from words or its own pictures (a
// redesign of this character, §45.34: which parts change is shown before "Use this" puts only those parts into the
// editor, on top of the changes not saved yet), the reference pictures, the AI picture when it is on (else the way to
// Settings › Video › Picture maker), and Delete.
// New character first asks "What are you making?" (§45.42): a person (as above) or a car, made from up to 6 real
// photos into cartoon cars to pick from; a saved car keeps those photos as its pictures. A car is a character: the
// gallery here shows the people and the cars (each car with its Car tag) and a "Make a car" next to New character.
// Cars also have their own place in the rail, right under Characters (Cars, screens/Cars.tsx, which uses
// NewCharacter and CharacterPage from here): a car's page always opens under Cars (/stories/cars/{id}).
import "../styles/studio.css";
import "../styles/sd-cars.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { putFile } from "../../api/upload.ts";
import { A } from "../../components/ui.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import { isCar, type Character, type CharacterInput, type CharacterKind, type CharacterLook, type StoriesConfig } from "../api/types.ts";
import { DEFAULT_CAR } from "../engine/car.ts";
import { CATALOG } from "../engine/catalog.ts";
import { Glass, GlassPill } from "../glass/index.ts";
import { storiesGoLater } from "../pane.tsx";
import { CarPreview } from "../preview/CarPreview.tsx";
import { CastPreview } from "../preview/CastPreview.tsx";
import { CharacterPreview } from "../preview/CharacterPreview.tsx";
import { storiesHref } from "../routes.ts";
import { useAiInfo } from "../studio/ai.tsx";
import { CharacterEditor } from "../studio/CharacterEditor.tsx";
import { CarDesign, DesignPanel, RedesignCompare } from "../studio/Design.tsx";
import { useWorkspace } from "../studio/hooks.ts";
import { Busy, celebrate, Notice, Pick, StSheet, Tag, type PickOption } from "../studio/kit.tsx";
import { CAR_MOVE_LINE, CHAR_LIMITS, DEFAULT_LOOK, inputOf, MOVE_LINE, newCar, newCharacter } from "../studio/looks.ts";
import type { Photo } from "../studio/Photos.tsx";
import { Portrait, References } from "../studio/References.tsx";
import { count, isConflict, say } from "../studio/words.ts";
import { StIcon } from "../ui.tsx";
import { MakeIcon } from "./Ideas.tsx";
import type { StoriesScreenProps } from "./types.ts";

export function CharactersScreen({ ws, page }: StoriesScreenProps) {
  // A link to the other kind (?kind=car) starts the page again.
  if (page.name === "character_new") return <NewCharacter key={page.kind ?? "any"} ws={ws} kind={page.kind} />;
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

/** Where a character's pages live: a person's under Characters, a car's under Cars (§45.42.10). */
export type CastPlace = "characters" | "cars";

/** Back to the cast: the studio kit's back link with its round glass orb (the same as Production's and Review's). */
function BackToCast({ place = "characters" }: { place?: CastPlace }) {
  return (
    <A href={storiesHref({ name: place })} className="st-s-back st-s-back--orb">
      <span className="st-s-back__orb">‹</span> {place === "cars" ? "Cars" : "Characters"}
    </A>
  );
}

/** A character's own page: a car's is under Cars (/stories/cars/{id}). */
export const characterHref = (c: { characterId: string; kind?: CharacterKind }) => storiesHref(c.kind === "car" ? { name: "car", characterId: c.characterId } : { name: "character", characterId: c.characterId });

function Gallery({ ws }: { ws: string }) {
  const list = useLoad(() => storiesApi().listCharacters(ws), ws, "st-characters");
  // The whole cast: the people, then the cars (each with its Car tag).
  const people = list.data ? [...list.data.filter((c) => !isCar(c)), ...list.data.filter(isCar)] : null;
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
          <A href={storiesHref({ name: "car_new" })} className="st-btn st-s-makecar">
            <StIcon name="car" size={18} />
            Make a car
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
      ) : !people ? (
        <Busy>Getting your cast…</Busy>
      ) : people.length === 0 ? (
        <EmptyCast title="No characters yet" action={<A href={storiesHref({ name: "character_new" })} className="st-btn st-btn--main">Make your first character</A>}>
          Make a character once, and use it in all your videos.
        </EmptyCast>
      ) : (
        <ul className="st-s-cast">
          {people.map((c) => (
            <li key={c.characterId}>
              <A href={characterHref(c)} className="st-glass st-lens st-s-cast__card">
                <span className="st-s-cast__stage">
                  <CastPreview c={c} size={132} label={`${c.name}, moving`} />
                </span>
                <span className="st-s-cast__name">{c.name}</span>
                <span className="st-s-cast__line">{c.personality || (isCar(c) ? c.description || CAR_MOVE_LINE[c.movementStyle] : MOVE_LINE[c.movementStyle])}</span>
                <span className="st-s-cast__tags">
                  {isCar(c) ? <Tag tone="coral">Car</Tag> : <Tag tone="sky">{CATALOG.movementStyles.find((m) => m.id === c.movementStyle)?.label ?? c.movementStyle}</Tag>}
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
/** A person's look, or a car's (§45.42), as plain parts. */
const lookOf = (c: CharacterInput) => (isCar(c) ? c.car : c.look) as unknown as Record<string, unknown>;

/**
 * "Use this" on a redesign (§45.34): only the parts the redesign changed from the saved character (`before`) go into
 * the editor, on top of what the editor has now (`now`, with its changes not saved yet); every other part stays as
 * the owner left it. A car's look parts each count on their own; a redesign of the other kind comes in whole.
 */
export function mergeRedesign(now: CharacterInput, before: CharacterInput, next: CharacterInput): CharacterInput {
  if (isCar(now) !== isCar(next) || isCar(before) !== isCar(next)) return inputOf(next);
  const out = inputOf(now);
  const look = lookOf(out);
  const was = lookOf(before);
  const to = lookOf(next);
  const known: string[][] = isCar(out) ? [] : LOOK_GROUPS;
  const grouped = new Set<string>(known.flat());
  const groups: string[][] = [...known, ...Object.keys(to).filter((k) => !grouped.has(k)).map((k) => [k])];
  for (const g of groups) if (g.some((k) => !same(was[k], to[k]))) for (const k of g) look[k] = structuredClone(to[k]);
  const all = out as unknown as Record<string, unknown>;
  for (const k of OTHER_PARTS) if (!same(before[k], next[k])) all[k] = structuredClone(next[k]);
  return out;
}

/** What a new character can be (§45.42): two big tiles at first, a small pick-one bar once one is picked. */
const KINDS: PickOption<CharacterKind>[] = [
  { value: "person", label: "A person" },
  { value: "car", label: "A car" },
];

function kindArt(kind: CharacterKind) {
  return (
    <span className="st-s-kind__art" aria-hidden="true">
      {kind === "car" ? (
        <CarPreview car={DEFAULT_CAR} movementStyle="calm" size={72} playing={false} label="A car" />
      ) : (
        <CharacterPreview look={DEFAULT_LOOK} movementStyle="bouncy" expression="happy" size={72} playing={false} label="A person" />
      )}
    </span>
  );
}

/** A saved car keeps the photos it was made from as its pictures (§45.42), best effort, up to the pictures limit, 3
 * at a time (as the photos box sends them). Gives how many did not stay. */
async function keepPhotos(ws: string, characterId: string, photos: Photo[]): Promise<number> {
  const todo = photos.filter((x) => x.state === "ready" && x.file.size > 0).slice(0, CHAR_LIMITS.refs);
  let missed = 0;
  const one = async (p: Photo) => {
    try {
      const target = await storiesApi().referenceUpload(ws, characterId, { filename: p.file.name, contentType: p.file.type, size: p.file.size });
      await putFile({ key: target.assetId, uploadUrl: target.uploadUrl, headers: target.headers }, p.file);
      await storiesApi().referenceComplete(ws, characterId, target.assetId);
    } catch {
      missed += 1; // the car is saved; a photo that does not stay can be added on its page
    }
  };
  const lane = async () => {
    for (let p = todo.shift(); p; p = todo.shift()) await one(p);
  };
  await Promise.all(Array.from({ length: Math.min(3, todo.length) }, lane));
  return missed;
}

/**
 * New character, or (place "cars", Make a car in Cars or Characters) a new car: then the kind is a car from the
 * start, so there are no kind tiles, and the page says "New car".
 */
export function NewCharacter({ ws, kind: asked, place = "characters" }: { ws: string; kind?: CharacterKind; place?: CastPlace }) {
  const toast = useToast();
  const info = useAiInfo(ws);
  const [kind, setKind] = useState<CharacterKind>(asked ?? "person");
  /** A tile was picked (or the link picked one): the tiles shrink into a pick-one bar at the top. */
  const [chosen, setChosen] = useState(!!asked);
  const [asking, setAsking] = useState<CharacterKind | null>(null);
  const [edited, setEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The editor starts again from the AI's first try (each try is a new round). */
  const [draft, setDraft] = useState<{ round: number; input: CharacterInput } | null>(null);
  const [design] = useState(() => typeof location !== "undefined" && location.hash === "#design");
  const photos = useRef<Photo[]>([]);
  const [photoCount, setPhotoCount] = useState(0);
  const onPhotos = useCallback((list: Photo[]) => {
    photos.current = list;
    setPhotoCount(list.length);
  }, []);
  const onDraft = useCallback((input: CharacterInput) => setDraft((d) => ({ round: (d?.round ?? 0) + 1, input })), []);
  const car = kind === "car";
  /** Nothing is saved yet: anything in the editor is unsaved (it asks before the page changes). */
  const blank = useMemo(() => (car ? newCar() : newCharacter()), [car]);

  function startAs(next: CharacterKind) {
    setKind(next);
    setChosen(true);
    setAsking(null);
    setEdited(false);
    setDraft(null);
    setProblem(null);
    photos.current = [];
    setPhotoCount(0);
  }

  function choose(next: CharacterKind) {
    if (next === kind) return setChosen(true);
    if (edited || draft || photoCount) return setAsking(next);
    startAs(next);
  }

  async function save(c: CharacterInput) {
    setSaving(true);
    setProblem(null);
    try {
      const made = await storiesApi().createCharacter(ws, c);
      celebrate(document.querySelector(".st-s-editor__preview"), 130);
      toast.success(`Say hi to ${made.name}!`);
      if (isCar(c) && photos.current.some((p) => p.state === "ready")) {
        setKeeping(true);
        const missed = await keepPhotos(ws, made.characterId, photos.current);
        if (missed) toast.info(missed === 1 ? "1 photo didn't stay. Add it on the car's page." : `${missed} photos didn't stay. Add them on the car's page.`);
      }
      // After the wait: never while Clip Factory is on screen (it happens once Clips Funded is back, §45.35 D17).
      storiesGoLater(characterHref(made), { replace: true });
    } catch (e) {
      setProblem(say(e));
      setSaving(false);
    }
  }

  return (
    <section className="st-page st-studio st-s-make">
      <header className="st-s-head">
        <div className="st-plate st-s-head__text">
          <BackToCast place={place} />
          <h1 className="st-s-head__title">{place === "cars" ? "New car" : "New character"}</h1>
          <p className="st-s-head__lede">
            {car ? "Add photos of your car. Pick the cartoon car you like, then give it a name." : "Pick how they look, their faces, how they move and their sounds. Then give them a name."}
          </p>
        </div>
      </header>
      {/* Loose on the page, so on a backing plate (glass in Picture and See-through). Under Cars it is a car. */}
      {place === "cars" ? null : (
        <div className="st-plate st-s-kindbox">
          <Pick
            label="What are you making?"
            big={!chosen}
            value={kind}
            options={chosen ? KINDS : KINDS.map((k) => ({ ...k, art: kindArt(k.value) }))}
            onChange={choose}
            className={`st-s-kind${chosen ? "" : " st-s-kind--tiles"}`}
          />
        </div>
      )}
      {car ? (
        <CarDesign key="car" ws={ws} info={info} onDraft={onDraft} onPhotos={onPhotos} />
      ) : (
        <DesignPanel key="person" ws={ws} info={info} startOpen={design} onDraft={onDraft} />
      )}
      <CharacterEditor
        key={`new:${kind}:${draft?.round ?? 0}`}
        initial={draft?.input ?? blank}
        saved={blank}
        startPart={draft ? "name" : undefined}
        mode="new"
        saving={saving}
        onSave={(c) => void save(c)}
        onEdit={() => setEdited(true)}
        serverProblem={keeping ? <Busy>Saving photos…</Busy> : problem ? <Notice tone="bad">{problem}</Notice> : null}
      />
      {asking ? (
        <StSheet
          title={`Start again as ${asking === "car" ? "a car" : "a person"}?`}
          onClose={() => setAsking(null)}
          actions={
            <>
              <button type="button" className="st-btn" onClick={() => setAsking(null)}>
                Keep it
              </button>
              <button type="button" className="st-btn st-btn--main" onClick={() => startAs(asking)}>
                Start again
              </button>
            </>
          }
        >
          <p>Your changes go.</p>
        </StSheet>
      ) : null}
    </section>
  );
}

/** A character's own page. A car's lives under Cars: opened from /stories/characters/{id}, it moves there. */
export function CharacterPage({ ws, characterId, place = "characters" }: { ws: string; characterId: string; place?: CastPlace }) {
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
  // The effects in videos come from another maker than the samples (§45.41): known only once the workspace is in.
  const audio = ((workspace?.configuration ?? {}) as Partial<StoriesConfig>).providers?.audio;
  const otherMaker = workspace && audio ? audio !== "builtin-synth" : undefined;
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
  const home: CastPlace = c ? (isCar(c) ? "cars" : "characters") : place;
  const wrongPlace = !!c && home !== place;

  useEffect(() => {
    // An older link (the dashboard's Continue, the library, a chat card) to a car under Characters: the same page under Cars.
    if (wrongPlace && c) storiesGoLater(characterHref(c), { replace: true });
  }, [wrongPlace, c]);

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
      storiesGoLater(storiesHref({ name: home }), { replace: true });
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
        <Notice tone="bad" action={<A href={storiesHref({ name: place })} className="st-btn">{place === "cars" ? "Back to Cars" : "Back to Characters"}</A>}>
          {loaded.error}
        </Notice>
      </section>
    );
  if (!c)
    return (
      <section className="st-page st-studio st-s-make">
        <Busy>{place === "cars" ? "Getting the car…" : "Getting the character…"}</Busy>
      </section>
    );

  return (
    <section className="st-page st-studio st-s-make">
      <header className="st-s-head">
        <div className="st-plate st-s-head__text">
          <BackToCast place={home} />
          <h1 className="st-s-head__title">{c.name}</h1>
          <p className="st-s-head__lede">
            In {count(c.storyCount, "video")}. Changes show in new videos and in a Remake the whole video, never in one already made.
          </p>
        </div>
        <GlassPill icon={<MakeIcon name="delete" size={18} />} onClick={() => setAsking(true)}>
          Delete
        </GlassPill>
      </header>
      {isCar(c) ? (
        <CarDesign
          ws={ws}
          info={info}
          startOpen={false}
          name={c.name}
          characterId={c.characterId}
          pictures={c.references.map((r) => ({ assetId: r.assetId, url: r.url }))}
          onDraft={(input) => setProposal(input)}
        />
      ) : (
        <DesignPanel
          ws={ws}
          info={info}
          name={c.name}
          characterId={c.characterId}
          pictures={c.references.map((r) => ({ assetId: r.assetId, url: r.url }))}
          onDraft={(input) => setProposal(input)}
        />
      )}
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
        otherMaker={otherMaker}
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
