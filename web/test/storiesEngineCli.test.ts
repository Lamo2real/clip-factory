// The Lamo Stories engine's command line (CONTRACTS §45.10): the agent runs `deno run --allow-read cli.ts …`; cli.ts
// only hands Deno's arguments, files and stdout to commands.ts, which these tests run directly. Every problem is one
// sentence on stderr with exit code 2, and `catalog` tells the writer what the script's free words mean.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogOutput, runCli } from "../src/stories/engine/commands.ts";
import { CATALOG, ENGINE_VERSION, frameCount, LIMITS, normalizeScript, validateScript } from "../src/stories/engine/engine.ts";
import type { StoryScript } from "../src/stories/engine/types.ts";

const ENGINE = join(import.meta.dirname, "../src/stories/engine");
const SAMPLE = join(ENGINE, "fixtures", "sample-script.json");

/** Runs one command against real files, or against `files` (path → text) when given. */
function run(args: string[], files: Record<string, string> = {}): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = runCli(args, {
    read: (path) => (path in files ? files[path]! : readFileSync(path, "utf8")),
    write: (text) => {
      out += text;
    },
    error: (text) => {
      err += text;
    },
  });
  return { code, out, err };
}

const lines = (text: string) => text.split("\n").filter(Boolean);

describe("cli.ts frames", () => {
  const total = frameCount((validateScript(JSON.parse(readFileSync(SAMPLE, "utf8"))) as { ok: true; script: StoryScript }).script);

  it("prints one JSON line per frame, all of them or from..to", () => {
    expect(lines(run(["frames", SAMPLE]).out)).toHaveLength(total);
    const some = lines(run(["frames", SAMPLE, "2", "5"]).out).map((l) => JSON.parse(l) as { f: number; p: unknown[] });
    expect(some.map((x) => x.f)).toEqual([2, 3, 4]);
    expect(some.every((x) => x.p.length > 0)).toBe(true);
    // a to past the end stops at the last frame
    expect(lines(run(["frames", SAMPLE, String(total - 2), String(total + 50)]).out)).toHaveLength(2);
  });

  for (const [from, to] of [
    ["abc", "3"],
    ["0", "xyz"],
    ["-1", "3"],
    ["1.5", "3"],
    ["", "3"],
    ["2", "1e3"],
  ] as const) {
    it(`frames ${JSON.stringify(from)} ${JSON.stringify(to)} is refused with exit code 2 and nothing on stdout`, () => {
      const r = run(["frames", SAMPLE, from, to]);
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/^frames needs whole frame numbers of 0 or more/);
    });
  }

  it("a from after to is refused", () => {
    const r = run(["frames", SAMPLE, "5", "3"]);
    expect(r).toEqual({ code: 2, out: "", err: "frames needs from (5) at or before to (3)\n" });
  });

  it("an invalid script is refused with its problems", () => {
    const r = run(["frames", "bad.json"], { "bad.json": JSON.stringify({ engine: 1 }) });
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^invalid script: .*fps is nothing; it must be 30/);
  });
});

describe("the other commands", () => {
  it("validate prints ok, or the problems (exit 0 either way)", () => {
    expect(run(["validate", SAMPLE])).toEqual({ code: 0, out: '{"ok":true}\n', err: "" });
    const bad = run(["validate", "bad.json"], { "bad.json": "{}" });
    expect(bad.code).toBe(0);
    expect((JSON.parse(bad.out) as { ok: boolean; errors: string[] }).errors.length).toBeGreaterThan(3);
  });

  it("normalize, fit, scenes, text and audio print JSON", () => {
    const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as StoryScript;
    const normalized = JSON.parse(run(["normalize", SAMPLE]).out) as StoryScript;
    expect(normalized).toEqual(normalizeScript((validateScript(sample) as { ok: true; script: StoryScript }).script));
    const fitted = JSON.parse(run(["fit", "5", SAMPLE]).out) as StoryScript;
    expect(fitted.scenes.reduce((a, sc) => a + sc.durationSec, 0)).toBeCloseTo(5, 5);
    expect(JSON.parse(run(["scenes", SAMPLE]).out)).toEqual([
      { sceneId: "s1", from: 0, to: 90, mid: 45 },
      { sceneId: "s2", from: 90, to: 180, mid: 135 },
    ]);
    expect(Array.isArray(JSON.parse(run(["text", SAMPLE]).out))).toBe(true);
    expect(Array.isArray(JSON.parse(run(["audio", SAMPLE]).out))).toBe(true);
    expect(JSON.parse(run(["version"]).out)).toEqual({ engine: ENGINE_VERSION });
  });

  it("fit needs a number of seconds", () => {
    for (const s of ["abc", "0", "-3", ""]) expect(run(["fit", s, SAMPLE])).toEqual({ code: 2, out: "", err: "fit needs a number of seconds\n" });
  });

  it("a missing file, a file that is not JSON and an unknown command each exit 2 with a sentence", () => {
    expect(run(["validate"])).toEqual({ code: 2, out: "", err: "a script path is required\n" });
    expect(run(["validate", "/no/such/file.json"])).toEqual({ code: 2, out: "", err: "the script file could not be read\n" });
    expect(run(["validate", "x.json"], { "x.json": "not json" })).toEqual({ code: 2, out: "", err: "the script could not be read as JSON\n" });
    expect(run(["dance"]).code).toBe(2);
    expect(run([]).err).toMatch(/^unknown command; use validate, normalize, fit, frames/);
  });

  it("character checks a CharacterInput", () => {
    const c1 = (JSON.parse(readFileSync(join(ENGINE, "fixtures", "ice-skid.json"), "utf8")) as StoryScript).cast.c1!;
    const good = { name: "Lamo", description: "", personality: "", traits: [], look: c1.look, movementStyle: c1.movementStyle, voice: c1.voice, expressions: ["neutral", "happy", "scared"] };
    expect(run(["character", "c.json"], { "c.json": JSON.stringify(good) }).out).toBe('{"ok":true}\n');
    const bad = JSON.parse(run(["character", "c.json"], { "c.json": JSON.stringify({ ...good, expressions: undefined, description: "x".repeat(900) }) }).out) as { ok: boolean; errors: string[] };
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toMatch(/description must be text of at most 400/);
    expect(bad.errors.join(" ")).toMatch(/expressions must be at least 3/);
  });
});

describe("cli.ts catalog tells the writer what the script's words mean", () => {
  const out = JSON.parse(run(["catalog"]).out) as ReturnType<typeof catalogOutput>;
  const rule = (id: string) => out.rules.find((r) => r.id === id)?.text ?? "";

  it("carries the engine version, the catalog, the limits, the rules and the prop states", () => {
    expect(Object.keys(out)).toEqual(["engine", "catalog", "limits", "rules", "propStates", "formats"]);
    expect(out.engine).toBe(ENGINE_VERSION);
    expect(out.catalog).toEqual(CATALOG);
    expect(out.limits).toEqual({ ...LIMITS, seats: { car: 2, truck: 1 } });
    expect(out.rules.length).toBeGreaterThanOrEqual(8);
    for (const r of out.rules) {
      expect(r.id).toMatch(/^[a-z_]+$/);
      expect(r.text.length).toBeGreaterThan(20);
    }
  });

  it("a skid's dir is the side the rear slides to, and steering into it is the steer of the same side", () => {
    const text = rule("skid_dir");
    expect(text).toMatch(/dir is the side the car's REAR slides to/);
    expect(text).toContain('"Rear slides right" is {do: "skid", dir: "right"}');
    expect(text).toMatch(/steer_right at the same time \(the steering arrow then points right\)/);
    expect(text).toMatch(/"Rear slides left" is dir: "left" with steer_left/);
    expect(text).toMatch(/nose points left/);
  });

  it("spin dir, side-view dir and top-view rot are explained", () => {
    expect(rule("spin_dir")).toMatch(/dir "right" is clockwise/);
    expect(rule("side_dir")).toMatch(/On skid, spin or tyre_burst, dir is only the side of the slide: the car keeps going nose first/);
    expect(rule("top_rot")).toMatch(/rot is its heading in degrees clockwise from nose-up: 0 drives up the frame, 90 to the right/);
    expect(rule("arrow_rot")).toMatch(/points up at rot 0/);
  });

  it("lists every prop state word the engine reads, in the rules and as data", () => {
    expect(out.propStates).toEqual({
      car: ["parked", "driving", "lights", "brakes", "flat"],
      truck: ["parked", "driving", "lights", "brakes", "flat"],
      arrow: ["curve_left", "curve_right"],
      tree: ["pine", "snow"],
      phone: ["ring", "on"],
    });
    const kinds = new Set(CATALOG.props.map((p) => p.id));
    for (const [kind, words] of Object.entries(out.propStates)) {
      expect(kinds.has(kind as never), kind).toBe(true);
      for (const w of words!) expect(rule("prop_state"), `${kind} ${w}`).toContain(w);
    }
    // ice-skid's s5 arrow uses one of them
    const ice = JSON.parse(readFileSync(join(ENGINE, "fixtures", "ice-skid.json"), "utf8")) as StoryScript;
    const states = ice.scenes.flatMap((sc) => sc.props.filter((p) => p.state).map((p) => [p.kind, p.state!] as const));
    for (const [kind, state] of states) for (const w of state.split(/[\s,]+/)) expect(out.propStates[kind] ?? [], `${kind} ${w}`).toContain(w);
  });
});
