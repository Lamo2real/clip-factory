// A character's reference pictures (docs/CONTRACTS.md §45.8, §45.5): up to 8 pictures of the look the owner is aiming
// for, kept with the character and shown next to the rig (they never change the rig). Each goes straight to storage
// with a presigned PUT and a progress bar; the server then checks its size and type. Also the AI picture button,
// shown only when AI pictures are on in Lamo Stories › Settings › Video › Picture maker (§45.34). A picture dropped on
// the section is sent like a picked one (§45.40); while it is full or sending, a drop says why.
import { useEffect, useRef, useState } from "react";
import { putFile } from "../../api/upload.ts";
import { DropOverlay } from "../../components/DropOverlay.tsx";
import { A } from "../../components/ui.tsx";
import { usePoll } from "../../lib/hooks.ts";
import { useFileDrop } from "../../lib/useFileDrop.ts";
import { storiesApi } from "../api/client.ts";
import type { Character } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { celebrate, Notice, ProgressBar } from "./kit.tsx";
import { CHAR_LIMITS } from "./looks.ts";
import { say } from "./words.ts";

const TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX = 10 * 1024 * 1024;

/** Why this file cannot be a reference picture, or null. */
export function fileProblem(f: { type: string; size: number }): string | null {
  if (!TYPES.includes(f.type)) return "Pick a PNG, JPG or WebP picture.";
  if (f.size > MAX) return "That picture is too big. Pick one under 10 MB.";
  return null;
}

export function References({ ws, character, onChange }: { ws: string; character: Character; onChange: (c: Character) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Pictures sent from this device, shown from the file itself until the server's own link loads. */
  const [local, setLocal] = useState<Record<string, string>>({});
  const full = character.references.length >= CHAR_LIMITS.refs;
  /** Why a drop can't come in now (the drag shows it, the drop is refused with it). */
  const busyLine = full ? `You have ${CHAR_LIMITS.refs} pictures. Delete one first.` : progress !== null ? "Wait a moment." : null;
  const drop = useFileDrop({ scope: "element", checkFile: fileProblem, onFiles: ([f]) => f && void send(f), busy: busyLine });

  useEffect(
    () => () => {
      for (const url of Object.values(local)) URL.revokeObjectURL(url);
    },
    // Only on unmount: each picture's own URL lives as long as the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function send(file: File) {
    setProblem(null);
    const bad = fileProblem(file);
    if (bad) return setProblem(bad);
    setProgress(0);
    try {
      const target = await storiesApi().referenceUpload(ws, character.characterId, { filename: file.name, contentType: file.type, size: file.size });
      await putFile({ key: target.assetId, uploadUrl: target.uploadUrl, headers: target.headers }, file, setProgress);
      const next = await storiesApi().referenceComplete(ws, character.characterId, target.assetId);
      if (typeof URL.createObjectURL === "function") setLocal((m) => ({ ...m, [target.assetId]: URL.createObjectURL(file) }));
      onChange(next);
      celebrate(input.current?.parentElement ?? null, 60);
    } catch (e) {
      setProblem(say(e, "The picture did not arrive. Try again."));
    } finally {
      setProgress(null);
    }
  }

  async function remove(assetId: string) {
    setProblem(null);
    try {
      onChange(await storiesApi().deleteReference(ws, character.characterId, assetId));
    } catch (e) {
      setProblem(say(e));
    }
  }

  return (
    <section className="st-s-refs st-drop-host" aria-labelledby="st-refs-title" {...drop.bind}>
      <h2 className="st-s-refs__title" id="st-refs-title">
        Pictures to aim for
      </h2>
      <p className="st-s-refs__lede">Add up to {CHAR_LIMITS.refs} pictures of the look you want. They stay with {character.name} and never change the drawing.</p>
      {character.references.length ? (
        <ul className="st-s-refs__list">
          {character.references.map((r, i) => (
            <li key={r.assetId} className="st-s-refs__item">
              <img src={local[r.assetId] ?? r.url} alt={`Picture ${i + 1} for ${character.name}`} width={88} height={88} />
              <button type="button" className="st-s-iconbtn st-s-refs__remove" aria-label={`Remove picture ${i + 1}`} onClick={() => void remove(r.assetId)}>
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {progress !== null ? (
        <div className="st-s-refs__sending">
          <span>Sending the picture…</span>
          <ProgressBar value={progress} label="Sending the picture" />
        </div>
      ) : (
        <span className="st-s-refs__add">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="st-s-sr"
            id={`st-ref-${character.characterId}`}
            disabled={full}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void send(f);
            }}
          />
          <label htmlFor={`st-ref-${character.characterId}`} className="st-btn" aria-disabled={full || undefined}>
            {full ? `${CHAR_LIMITS.refs} pictures is the most` : "Add a picture"}
          </label>
        </span>
      )}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      <DropOverlay drop={drop} scope="element" look="stories" words={{ file: "Drop your picture here", busy: busyLine ?? undefined }} />
    </section>
  );
}

/**
 * The AI picture of a character (only when AI pictures are on). It waits for the picture, checking every 2 s. An older
 * pick of Amazon Nova Canvas (`ended`, §45.37 G7) says Amazon ended it, with one tap to Stability AI's pictures
 * (`onReplace`); nothing switches by itself.
 */
export function Portrait({
  ws,
  character,
  aiOn,
  ended = false,
  onReplace,
  onChange,
}: {
  ws: string;
  character: Character;
  aiOn: boolean;
  ended?: boolean;
  onReplace?: () => Promise<void>;
  onChange: (c: Character) => void;
}) {
  const [waiting, setWaiting] = useState<{ since: number; was: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);

  async function replaceMaker() {
    if (!onReplace || replacing) return;
    setProblem(null);
    setReplacing(true);
    try {
      await onReplace();
    } catch (e) {
      setProblem(say(e));
    } finally {
      setReplacing(false);
    }
  }

  usePoll(
    async () => {
      if (!waiting) return;
      const c = await storiesApi().getCharacter(ws, character.characterId);
      if ((c.portrait?.assetId ?? null) !== waiting.was) {
        setWaiting(null);
        onChange(c);
        celebrate(null, 70);
      } else if (Date.now() - waiting.since > 180_000) {
        setWaiting(null);
        setProblem("The picture is taking too long. Try again in a minute.");
      }
    },
    waiting !== null,
    2000,
  );

  async function make() {
    setProblem(null);
    try {
      await storiesApi().makePortrait(ws, character.characterId);
      setWaiting({ since: Date.now(), was: character.portrait?.assetId ?? null });
    } catch (e) {
      setProblem(say(e));
    }
  }

  return (
    <section className="st-s-portrait" aria-labelledby="st-portrait-title">
      <h2 className="st-s-refs__title" id="st-portrait-title">
        AI picture
      </h2>
      {character.portrait ? <img className="st-s-portrait__img" src={character.portrait.url} alt={`AI picture of ${character.name}`} width={120} height={120} /> : null}
      {aiOn ? (
        <>
          <p className="st-s-refs__lede">Only for the app and the Library. Videos always use the drawing.</p>
          <button type="button" className="st-btn" aria-disabled={waiting !== null || undefined} onClick={() => waiting === null && void make()}>
            {waiting ? "Drawing the picture…" : character.portrait ? "Make a new AI picture" : "Make an AI picture"}
          </button>
        </>
      ) : ended ? (
        <>
          <p className="st-s-refs__lede" role="status">
            Amazon Nova Canvas: Ended by Amazon on 30 Sep 2026. It cannot make AI pictures any more, and nothing switches by itself. Stability AI
            pictures run in the US (Oregon).
          </p>
          {onReplace ? (
            <button type="button" className="st-btn" aria-disabled={replacing || undefined} onClick={() => void replaceMaker()}>
              {replacing ? "Switching…" : "Use Stability AI pictures"}
            </button>
          ) : null}
          <p className="st-s-refs__lede">
            Or pick another in <A href={storiesHref({ name: "settings", section: "video" })}>Settings › Video › Picture maker</A>.
          </p>
        </>
      ) : (
        <p className="st-s-refs__lede">
          AI pictures are off. You can turn them on in <A href={storiesHref({ name: "settings", section: "video" })}>Settings › Video › Picture maker</A>.
        </p>
      )}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
    </section>
  );
}
