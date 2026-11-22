// Each character keeps its own faces and noises (docs/CONTRACTS.md §45.34; request 1 §5.C "Facial expressions", "that
// character should look and behave consistently in future animations"): a cast member copied with its expressions
// makes only those faces and only the noises of its voice, validateScript says so in a sentence the writer can act on,
// repairScript (cli.ts repair) fixes what is left after the writer's last try and says what it changed, and a face an
// action implies shows only when the character has it. Old scripts (a cast without expressions) stay valid. Also: the
// noises' voice is AudioEvent's own field, and the writer's rules tell it about own faces and the frame's shape.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { catalogOutput, runCli } from "../src/stories/engine/commands.ts";
import { audioTrack, drawFrame, normalizeScript, repairScript, validateScript } from "../src/stories/engine/engine.ts";
import type { VoicedAudioEvent } from "../src/stories/engine/tracks.ts";
import type { AudioEvent, Expression, ScriptRepair, StoryScript } from "../src/stories/engine/types.ts";

const ENGINE = join(import.meta.dirname, "../src/stories/engine");
const raw = (name: string): StoryScript => JSON.parse(readFileSync(join(ENGINE, "fixtures", name), "utf8")) as StoryScript;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function errorsOf(s: unknown): string[] {
  const r = validateScript(s);
  return r.ok ? [] : r.errors;
}

function valid(s: unknown): StoryScript {
  const r = validateScript(s);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return normalizeScript(r.script);
}

/** The sample with Lamo's own faces copied into the cast (as the agent copies them from the saved character). */
function withFaces(faces: Expression[] = ["neutral", "happy", "surprised", "shocked", "relieved"]): StoryScript {
  const s = clone(raw("sample-script.json"));
  s.cast.c1!.expressions = faces;
  return s;
}

describe("a character's own faces and noises", () => {
  it("old scripts, whose cast has no expressions, stay valid with any face and noise of the catalog", () => {
    for (const name of ["sample-script.json", "ice-skid.json"]) expect(errorsOf(raw(name)), name).toEqual([]);
    const s = clone(raw("sample-script.json"));
    s.scenes[0]!.beats[0]!.face = "angry";
    s.scenes[0]!.beats[0]!.noise = "yelp";
    expect(errorsOf(s)).toEqual([]);
  });

  it("a cast that carries its faces keeps to them: the fixtures with their faces copied in are valid", () => {
    expect(errorsOf(withFaces())).toEqual([]);
  });

  it("a face the character does not have is refused, naming the character and its own faces", () => {
    const s = withFaces(["neutral", "happy", "surprised"]);
    expect(errorsOf(s)).toEqual([
      'scene 1 (s1) beat 1: Lamo (c1) does not make the face "shocked"; Lamo\'s own faces are neutral, happy and surprised. Use one of those, or leave face out.',
      'scene 2 (s2) beat 1: Lamo (c1) does not make the face "relieved"; Lamo\'s own faces are neutral, happy and surprised. Use one of those, or leave face out.',
    ]);
  });

  it("a noise the character does not make is refused, and a character with no noises is told so", () => {
    const s = withFaces();
    s.scenes[1]!.beats[0]!.noise = "laugh";
    expect(errorsOf(s)).toEqual(['scene 2 (s2) beat 1: Lamo (c1) does not make the noise "laugh"; Lamo\'s own noises are gasp and phew. Use one of those, or leave noise out.']);
    s.cast.c1!.voice.noises = [];
    expect(errorsOf(s)).toEqual([
      'scene 1 (s1) beat 1: Lamo (c1) does not make the noise "gasp"; Lamo makes no noises; leave noise out.',
      'scene 2 (s2) beat 1: Lamo (c1) does not make the noise "laugh"; Lamo makes no noises; leave noise out.',
    ]);
  });

  it("an unknown face is still the catalog's sentence, and a beat with no face or noise is always fine", () => {
    const s = withFaces();
    s.scenes[0]!.beats[0]!.face = "smug" as Expression;
    expect(errorsOf(s).join("\n")).toMatch(/face "smug" is not in the catalog/);
    const quiet = withFaces(["neutral", "happy", "surprised"]);
    for (const sc of quiet.scenes) {
      for (const b of sc.beats) {
        delete b.face;
        delete b.noise;
      }
    }
    expect(errorsOf(quiet)).toEqual([]);
  });

  it("the cast's own faces are known faces with neutral among them", () => {
    for (const faces of [[], ["happy", "sad"], ["neutral", "smug"], ["neutral", "neutral", "happy"]] as Expression[][]) {
      expect(errorsOf(withFaces(faces)).join("\n"), faces.join(",")).toMatch(/cast c1: expressions must be the character's own faces: different faces of neutral, happy, .*with neutral among them/);
    }
  });

  it("a face an action implies (a gasp's shock) shows only when the character has it; otherwise its last face stays", () => {
    const gasp = (faces: Expression[] | undefined) => {
      const s = clone(raw("sample-script.json"));
      delete s.scenes[0]!.beats[0]!.face;
      if (faces) s.cast.c1!.expressions = faces;
      return valid(s);
    };
    const neutral = (() => {
      const s = clone(raw("sample-script.json"));
      s.scenes[0]!.beats[0]!.face = "neutral";
      s.cast.c1!.expressions = ["neutral", "happy", "surprised", "relieved"];
      return valid(s);
    })();
    const frame = 15; // half a second in: the gasp is on
    expect(drawFrame(gasp(["neutral", "happy", "surprised", "relieved"]), frame)).toEqual(drawFrame(neutral, frame));
    expect(drawFrame(gasp(undefined), frame)).not.toEqual(drawFrame(neutral, frame));
    expect(drawFrame(gasp(["neutral", "happy", "shocked", "relieved"]), frame)).toEqual(drawFrame(gasp(undefined), frame));
  });
});

describe("repairScript, after the writer's last try", () => {
  const stray = () => {
    const s = withFaces(["neutral", "happy", "surprised"]);
    s.scenes[1]!.beats[0]!.noise = "laugh";
    return s;
  };

  it("makes a stray face neutral and leaves a stray noise out, says what it changed, and the script is valid", () => {
    const input = stray();
    const before = clone(input);
    const { script, changes } = repairScript(input);
    expect(input).toEqual(before);
    expect(changes).toEqual<ScriptRepair[]>([
      { sceneId: "s1", beat: 0, castId: "c1", field: "face", was: "shocked", now: "neutral", text: 'scene 1 (s1) beat 1: Lamo\'s face "shocked" is now "neutral" (Lamo\'s own faces are neutral, happy and surprised).' },
      { sceneId: "s2", beat: 0, castId: "c1", field: "face", was: "relieved", now: "neutral", text: 'scene 2 (s2) beat 1: Lamo\'s face "relieved" is now "neutral" (Lamo\'s own faces are neutral, happy and surprised).' },
      { sceneId: "s2", beat: 0, castId: "c1", field: "noise", was: "laugh", now: null, text: 'scene 2 (s2) beat 1: Lamo\'s noise "laugh" is left out (Lamo\'s own noises are gasp and phew).' },
    ]);
    expect(errorsOf(script)).toEqual([]);
    const fixed = script as StoryScript;
    expect(fixed.scenes[1]!.beats[0]).toEqual({ at: 0.5, dur: 1, who: "c1", do: "celebrate", face: "neutral" });
    // the rest of the script is as it was
    expect({ ...fixed, scenes: [] }).toEqual({ ...before, scenes: [] });
    expect(fixed.scenes[0]!.beats[0]!.sfx).toBe("skid");
  });

  it("changes nothing in a script that keeps to its faces, or in a cast without them, and running it twice is the same", () => {
    expect(repairScript(withFaces()).changes).toEqual([]);
    const old = clone(raw("sample-script.json"));
    old.scenes[0]!.beats[0]!.face = "angry";
    const r = repairScript(old);
    expect(r.changes).toEqual([]);
    expect(r.script).toBe(old);
    const once = repairScript(stray()).script;
    expect(repairScript(once).changes).toEqual([]);
  });

  it("leaves anything that is not a script alone", () => {
    for (const v of [null, 3, "x", [], { cast: {} }]) expect(repairScript(v)).toEqual({ script: v, changes: [] });
  });

  it("cli.ts repair prints the repaired script, the changes and the check of the result", () => {
    let out = "";
    const io = { read: () => JSON.stringify(stray()), write: (t: string) => (out += t), error: () => undefined };
    expect(runCli(["repair", "script.json"], io)).toBe(0);
    const got = JSON.parse(out) as { script: StoryScript; changes: ScriptRepair[]; ok: boolean; errors?: string[] };
    expect(got.ok).toBe(true);
    expect(got.changes.map((c) => `${c.sceneId}.${c.field}`)).toEqual(["s1.face", "s2.face", "s2.noise"]);
    expect(got.script.scenes[0]!.beats[0]!.face).toBe("neutral");
    // a script with another problem says so after the repair
    out = "";
    const other = stray();
    other.fps = 25 as 30;
    io.read = () => JSON.stringify(other);
    expect(runCli(["repair", "script.json"], io)).toBe(0);
    const bad = JSON.parse(out) as { ok: boolean; errors: string[] };
    expect(bad.ok).toBe(false);
    expect(bad.errors).toEqual(["fps is 25; it must be 30."]);
  });
});

describe("the writer's rules", () => {
  const rule = (id: string) => catalogOutput().rules.find((r) => r.id === id)?.text ?? "";

  it("say each character keeps its own faces and noises", () => {
    expect(rule("own_faces")).toMatch(/expressions list makes only those faces/);
    expect(rule("own_faces")).toMatch(/only the noises in its voice\.noises/);
  });

  it("say what shape the frame is and that x and y stay 0 to 1 of it", () => {
    const text = rule("frame_shape");
    for (const words of ["9:16", "1:1", "16:9", "1080 × 1920", "720 × 1280", "1080 × 1080", "720 × 720", "1920 × 1080", "1280 × 720", "0 to 1 of that frame"]) expect(text).toContain(words);
  });
});

describe("a noise's voice is AudioEvent's own field", () => {
  it("is typed on AudioEvent, and VoicedAudioEvent is the same type", () => {
    expectTypeOf<VoicedAudioEvent>().toEqualTypeOf<AudioEvent>();
    expectTypeOf<AudioEvent["voice"]>().toEqualTypeOf<"babble" | "hum" | undefined>();
    const s = valid(raw("ice-skid.json"));
    const noises: AudioEvent[] = audioTrack(s).filter((e) => e.kind === "noise");
    expect(noises.length).toBeGreaterThan(0);
    for (const e of noises) expect(["babble", "hum"]).toContain(e.voice);
    expect(audioTrack(s).filter((e) => e.kind === "sfx").every((e) => e.voice === undefined)).toBe(true);
  });
});
