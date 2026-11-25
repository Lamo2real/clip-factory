// "Realistic vehicles" (CONTRACTS §45.48), WP-A: the schema of a vehicle's optional `detail`. This file pins the rules
// table (the single source), the check (strict for v 1, lenient for a newer v), the shared fixture that the API and the
// agent also run, the family table and the one place a default lives (`resolveDetail`). It also writes the API's copy of
// the rules (api/src/clipfactory_api/workspaces/car_detail.json) and checks it afterwards (STORIES_GOLDENS=write).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BODY_IDS,
  CAR_DETAIL,
  CAR_DETAIL_MAX_CHARS,
  CAR_DETAIL_V,
  CAR_DETAIL_WHOLE,
  DEFAULT_SPOKES,
  FAMILY_FIT,
  PRESET,
  PRESET_PARTS,
  PROFILE_KEYS,
  PROFILE_RANGES,
  checkCarDetail,
  resolveDetail,
  ruleAllows,
  type Resolved,
  type Rule,
} from "../src/stories/engine/carDetail.ts";
import { checkCarLook, DEFAULT_CAR } from "../src/stories/engine/car.ts";
import { CATALOG } from "../src/stories/engine/catalog.ts";
import { VEHICLE_OF, type CarBody, type CarDetail, type CarLook } from "../src/stories/engine/types.ts";

const API_JSON = join(import.meta.dirname, "..", "..", "api", "src", "clipfactory_api", "workspaces", "car_detail.json");
const FIXTURE = join(import.meta.dirname, "fixtures", "car-detail-looks.json");

interface Fixture {
  valid: CarLook[];
  invalid: { look: CarLook; path: string }[];
}
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

const problems = (value: unknown, where = "x"): string[] => {
  const out: string[] = [];
  checkCarDetail(value, where, (m) => out.push(m));
  return out;
};
const lookProblems = (look: unknown): string[] => {
  const out: string[] = [];
  checkCarLook(look, "x", (m) => out.push(m));
  return out;
};
const plain = (over: Partial<CarLook> = {}): CarLook => ({ ...structuredClone(DEFAULT_CAR), ...over });
const withDetail = (detail: unknown, over: Partial<CarLook> = {}): CarLook => ({ ...plain(over), detail: detail as CarDetail });
const R = (detail: CarDetail | undefined, over: Partial<CarLook> = {}): Resolved => resolveDetail({ ...plain(over), ...(detail === undefined ? {} : { detail }) });

/** Every path the types of CarDetail name (design-final 1.1), written out here on purpose. */
const EXPECTED_PATHS = [
  "toon",
  ...["body", ...PROFILE_KEYS].map((k) => `profile.${k}`),
  ...["type", "color", "hoops", "rails"].map((k) => `roof.${k}`),
  ...["shape", "spokes", "tyre", "lip", "dish", "wall", "hub", "rearD"].map((k) => `wheels.${k}`),
  "brakes.disc",
  "brakes.caliper",
  ...["shape", "drl", "h", "lens"].map((k) => `lights.front.${k}`),
  ...["shape", "h", "lens"].map((k) => `lights.rear.${k}`),
  ...["grille", "intake", "splitter", "bumper", "fog"].map((k) => `front.${k}`),
  "bonnet.vent",
  ...["intake", "intakeX", "skirts", "doors", "handles", "crease", "mirror", "rubStrip", "fuelCap"].map((k) => `side.${k}`),
  ...["diffuser", "exhaust", "spoiler", "bumper"].map((k) => `rear.${k}`),
  "arches",
  ...["layout", "color", "width"].map((k) => `stripe.${k}`),
  "twoTone",
  "trim",
  "mirrorColor",
  "finish",
  "extras",
  ...["rows", "seat", "dial", "wheel"].map((k) => `cabin.${k}`),
];

/** A detail with one path set (a profile key rides on a complete profile). */
function detailWith(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split(".");
  if (parts[0] === "profile") return { v: 1, profile: { ...PRESET.sports, [parts[1]!]: value } };
  const out: Record<string, unknown> = { v: 1 };
  let at = out;
  parts.slice(0, -1).forEach((p) => {
    const next: Record<string, unknown> = {};
    at[p] = next;
    at = next;
  });
  at[parts[parts.length - 1]!] = value;
  return out;
}

const MAKES = [
  "ferrari", "lamborghini", "porsche", "mclaren", "maserati", "bugatti", "bentley", "bmw", "audi", "mercedes", "benz", "volkswagen", "toyota", "honda", "nissan", "mazda", "subaru",
  "ford", "chevrolet", "chevy", "dodge", "jeep", "tesla", "volvo", "fiat", "renault", "peugeot", "citroen", "hyundai", "kia", "lexus", "jaguar", "aston", "lotus", "mustang", "corvette",
  "camaro", "hummer", "defender", "wrangler", "beetle", "badge", "logo", "emblem", "brand",
];
const brandless = (text: string): boolean => !MAKES.some((m) => new RegExp(`\\b${m}\\b`, "i").test(text));

describe("the rules table", () => {
  it("has exactly one entry per key of CarDetail (and none for v)", () => {
    expect(Object.keys(CAR_DETAIL).sort()).toEqual([...EXPECTED_PATHS].sort());
    expect(new Set(EXPECTED_PATHS).size).toBe(EXPECTED_PATHS.length);
    expect(CAR_DETAIL_WHOLE).toEqual(["profile"]);
    expect(CAR_DETAIL_V).toBe(1);
    expect(CAR_DETAIL_MAX_CHARS).toBe(2400);
  });

  it("uses only the five rule kinds, each well formed", () => {
    for (const [path, rule] of Object.entries(CAR_DETAIL)) {
      const kinds = ["e", "n", "c", "b", "l"].filter((k) => k in rule);
      expect(kinds, path).toHaveLength(1);
      if ("n" in rule) {
        expect(rule.n.every(Number.isInteger), path).toBe(true);
        expect(rule.n[0], path).toBeLessThanOrEqual(rule.n[1]);
      }
      if ("e" in rule) {
        expect(rule.e.length, path).toBeGreaterThan(1);
        expect(new Set(rule.e).size, path).toBe(rule.e.length);
      }
      if ("l" in rule) expect(rule.max, path).toBe(6);
    }
  });

  it("gives every choice (except the body's) a short label and a one line `draws`", () => {
    let count = 0;
    for (const [path, rule] of Object.entries(CAR_DETAIL)) {
      if (!("e" in rule || "l" in rule) || path === "profile.body") continue;
      const ids = "e" in rule ? rule.e : rule.l;
      expect(Object.keys(rule.label ?? {}).sort(), `${path} labels`).toEqual([...ids].sort());
      expect(Object.keys(rule.draws ?? {}).sort(), `${path} draws`).toEqual([...ids].sort());
      for (const id of ids) {
        const label = rule.label![id]!;
        const draws = rule.draws![id]!;
        expect(label.length, `${path}.${id} label`).toBeGreaterThan(1);
        expect(label.length, `${path}.${id} label`).toBeLessThanOrEqual(14);
        expect(draws.length, `${path}.${id} draws`).toBeGreaterThanOrEqual(8);
        expect(draws.length, `${path}.${id} draws`).toBeLessThanOrEqual(120);
        expect(draws, `${path}.${id}`).not.toMatch(/\n/);
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(150);
  });

  it("holds no make, model, badge or logo word anywhere (ids, labels, draws, body names)", () => {
    const all: string[] = [];
    for (const [path, rule] of Object.entries(CAR_DETAIL)) {
      all.push(path);
      if ("e" in rule || "l" in rule) {
        all.push(...("e" in rule ? rule.e : rule.l), ...Object.values(rule.label ?? {}), ...Object.values(rule.draws ?? {}));
      }
    }
    for (const text of all) expect(brandless(text), text).toBe(true);
    expect(brandless("a ferrari nose")).toBe(false);
    expect(JSON.stringify(PRESET_PARTS)).not.toMatch(/ferrari|porsche|badge|logo/i);
  });

  it("matches the body ids of the catalog", () => {
    expect([...BODY_IDS].sort()).toEqual(CATALOG.carLooks.body.map((b) => b.id).sort());
    expect(Object.keys(PRESET).sort()).toEqual([...BODY_IDS].sort());
    expect(Object.keys(PRESET_PARTS).sort()).toEqual([...BODY_IDS].sort());
    expect((CAR_DETAIL["profile.body"] as { e: string[] }).e).toEqual(BODY_IDS);
  });

  it("writes and checks the API's copy (api/src/clipfactory_api/workspaces/car_detail.json)", () => {
    const now = { v: CAR_DETAIL_V, maxChars: CAR_DETAIL_MAX_CHARS, rules: CAR_DETAIL, whole: CAR_DETAIL_WHOLE };
    if (process.env.STORIES_GOLDENS === "write") writeFileSync(API_JSON, `${JSON.stringify(now, null, 1)}\n`);
    // a changed rule must be written to the API's copy in the same PR (STORIES_GOLDENS=write), or the API drifts
    expect(JSON.parse(readFileSync(API_JSON, "utf8"))).toEqual(JSON.parse(JSON.stringify(now)));
  });
});

describe("the check, rule by rule", () => {
  it("accepts a bare {v:1}, empty groups and a look without detail", () => {
    expect(problems({ v: 1 })).toEqual([]);
    expect(problems({ v: 1, roof: {}, wheels: {}, lights: { front: {}, rear: {} }, stripe: {}, cabin: {} })).toEqual([]);
    expect(lookProblems(plain())).toEqual([]);
  });

  it("refuses what is not an object, and a wrong or missing v", () => {
    for (const bad of ["x", 5, null, true, ["v", 1]]) expect(problems(bad)).toEqual(["x: car.detail must be an object."]);
    for (const v of [undefined, 0, 1.5, "1", -1, null]) expect(problems(v === undefined ? {} : { v }), String(v)).toEqual(["x: car.detail.v must be 1."]);
  });

  it("holds every number rule: whole numbers from min to max, both ends in, one beyond out, floats out", () => {
    let n = 0;
    for (const [path, rule] of Object.entries(CAR_DETAIL)) {
      if (!("n" in rule)) continue;
      const [lo, hi] = rule.n;
      for (const ok of [lo, hi, Math.floor((lo + hi) / 2)]) expect(problems(detailWith(path, ok)), `${path}=${ok}`).toEqual([]);
      for (const bad of [lo - 1, hi + 1, lo + 0.5, "5", null, NaN]) {
        const out = problems(detailWith(path, bad));
        expect(out.length, `${path}=${String(bad)}`).toBe(1);
        expect(out[0], path).toContain(`car.detail.${path} is `);
        expect(out[0], path).toContain(`use a whole number from ${lo} to ${hi}.`);
      }
      n += 1;
    }
    expect(n).toBe(34 + 12); // the profile's numbers and the others
  });

  it("holds every choice rule: each id in, anything else out (also another case or a number)", () => {
    for (const [path, rule] of Object.entries(CAR_DETAIL)) {
      if (!("e" in rule)) continue;
      for (const id of rule.e) expect(problems(detailWith(path, id)), `${path}=${id}`).toEqual([]);
      for (const bad of ["nope", rule.e[0]!.toUpperCase() + "x", 5, null, ""]) {
        const out = problems(detailWith(path, bad));
        expect(out.length, `${path}=${String(bad)}`).toBe(1);
        expect(out[0], path).toContain(`use one of ${rule.e.join(", ")}.`);
      }
    }
  });

  it("holds every colour rule: lower case #rrggbb only", () => {
    const paths = Object.entries(CAR_DETAIL).filter(([, r]) => "c" in r).map(([p]) => p);
    expect(paths).toHaveLength(8);
    for (const path of paths) {
      expect(problems(detailWith(path, "#0a1b2c"))).toEqual([]);
      for (const bad of ["#0A1B2C", "#fff", "#12345g", "0a1b2c", "red", 5, null, "#0a1b2c "]) {
        const out = problems(detailWith(path, bad));
        expect(out.length, `${path}=${String(bad)}`).toBe(1);
        expect(out[0]).toContain('use a colour like "#d8352a".');
      }
    }
  });

  it("holds every true/false rule: real booleans only", () => {
    const paths = Object.entries(CAR_DETAIL).filter(([, r]) => "b" in r).map(([p]) => p);
    expect(paths.sort()).toEqual(["front.fog", "roof.rails", "side.fuelCap", "side.rubStrip"]);
    for (const path of paths) {
      expect(problems(detailWith(path, true))).toEqual([]);
      expect(problems(detailWith(path, false))).toEqual([]);
      for (const bad of ["true", 1, 0, null]) expect(problems(detailWith(path, bad)), `${path}=${String(bad)}`).toHaveLength(1);
    }
  });

  it("holds the extras list: up to 6, no repeats, known ids, a real list", () => {
    const ids = (CAR_DETAIL["extras"] as { l: string[] }).l;
    expect(ids).toHaveLength(12);
    expect(problems({ v: 1, extras: [] })).toEqual([]);
    expect(problems({ v: 1, extras: ids.slice(0, 6) })).toEqual([]);
    expect(problems({ v: 1, extras: ids.slice(6) })).toEqual([]);
    expect(problems({ v: 1, extras: ids.slice(0, 7) })).toHaveLength(1);
    expect(problems({ v: 1, extras: [ids[0], ids[0]] })).toHaveLength(1);
    expect(problems({ v: 1, extras: ["rocket"] })).toHaveLength(1);
    expect(problems({ v: 1, extras: ids[0] })).toHaveLength(1);
    expect(problems({ v: 1, extras: [ids[0], 5] })).toHaveLength(1);
    expect(problems({ v: 1, extras: { 0: ids[0] } })[0]).toContain("use a list of at most 6 different ones of bull_bar,");
  });

  it("refuses unknown keys by their dotted path, and a group that is not an object", () => {
    expect(problems({ v: 1, colour: "#ffffff" })).toEqual(["x: car.detail.colour is not a known detail."]);
    expect(problems({ v: 1, roof: { glow: true } })).toEqual(["x: car.detail.roof.glow is not a known detail."]);
    expect(problems({ v: 1, lights: { front: { shape: "round", glow: 1 } } })).toEqual(["x: car.detail.lights.front.glow is not a known detail."]);
    expect(problems({ v: 1, foo: { bar: 1, baz: 2 } })).toHaveLength(2);
    expect(problems({ v: 1, foo: {} })).toEqual(["x: car.detail.foo is not a known detail."]);
    expect(problems({ v: 1, roof: "open" })).toEqual(['x: car.detail.roof is "open"; use an object.']);
    expect(problems({ v: 1, lights: { front: "round" } })).toEqual(['x: car.detail.lights.front is "round"; use an object.']);
    expect(problems({ v: 1, toon: {} })).toHaveLength(1);
    expect(problems({ v: 1, constructor: 1 })).toEqual(["x: car.detail.constructor is not a known detail."]);
  });

  it("needs the profile whole: every key, or none", () => {
    expect(problems({ v: 1, profile: { ...PRESET.sedan } })).toEqual([]);
    const half: Record<string, unknown> = { ...PRESET.sedan };
    delete half["lh"];
    expect(problems({ v: 1, profile: half })).toEqual(["x: car.detail.profile needs all of its numbers."]);
    expect(problems({ v: 1, profile: { body: "sedan" } })).toEqual(["x: car.detail.profile needs all of its numbers."]);
    expect(problems({ v: 1, profile: 5 })).toEqual(["x: car.detail.profile needs all of its numbers."]);
    expect(problems({ v: 1, profile: {} })).toEqual(["x: car.detail.profile needs all of its numbers."]);
    expect(Object.keys(PRESET.sedan)).toHaveLength(35);
  });

  it("caps the whole detail at 2,400 characters", () => {
    const base: Record<string, unknown> = { v: 1, pad: "" };
    const room = CAR_DETAIL_MAX_CHARS - JSON.stringify(base).length;
    const at = (n: number) => problems({ v: 1, pad: "y".repeat(n) }).filter((m) => m.includes("too long"));
    expect(at(room)).toEqual([]);
    expect(at(room + 1)).toEqual(["x: car.detail is too long."]);
    // the largest legal detail is far under the cap
    const full = fixture.valid.map((l) => JSON.stringify(l.detail ?? {}).length);
    expect(Math.max(...full)).toBeLessThan(CAR_DETAIL_MAX_CHARS - 600);
  });

  it("names the place and says one short sentence per problem", () => {
    const out = problems({ v: 1, toon: 5.5, roof: { type: "x" }, extras: [1] }, "scene 2, car 1");
    expect(out).toHaveLength(3);
    for (const m of out) {
      expect(m.startsWith("scene 2, car 1: car.detail.")).toBe(true);
      expect(m.endsWith(".")).toBe(true);
      expect(m).not.toContain("\n");
    }
  });
});

describe("strict for v 1, lenient for a newer v", () => {
  it("skips unknown keys, unknown ids and ranges that may have grown, when v is a newer whole number", () => {
    expect(problems({ v: 2, colour: "#fff", roof: { type: "gull_wing", glow: true }, toon: 500, extras: ["rocket"], profile: 5 })).toEqual([]);
    expect(problems({ v: 7 })).toEqual([]);
    expect(problems("x")).toEqual(["x: car.detail must be an object."]);
    expect(problems({ v: 2.5, colour: 1 })).not.toEqual([]); // not a whole number: strict
    expect(problems({ v: "2" })).not.toEqual([]);
  });

  it("draws a newer look as the default for what it does not know", () => {
    const r = R({ v: 2, roof: { type: "gull_wing" }, wheels: { shape: "laser", spokes: 7 }, toon: 900, surprise: 1 } as unknown as CarDetail, { body: "sports" });
    expect(r.roof.type).toBe("closed");
    expect(r.wheels.shape).toBe(R({ v: 1 }, { body: "sports" }).wheels.shape); // the classic style decides
    expect(r.wheels.spokes).toBe(7); // a known key with a valid value still counts
    expect(r.toon).toBe(30);
  });

  it("is what checkCarLook does: strict at v 1, lenient above", () => {
    expect(lookProblems(withDetail({ v: 1, glow: 1 }))).toEqual(["x: car.detail.glow is not a known detail."]);
    expect(lookProblems(withDetail({ v: 2, glow: 1 }))).toEqual([]);
    expect(lookProblems(withDetail("nope"))).toEqual(["x: car.detail must be an object."]);
    expect(lookProblems(withDetail(undefined))).toEqual([]);
  });
});

describe("the shared fixture (also read by the API's and the agent's tests)", () => {
  it("has about 45 cases covering every kind of problem", () => {
    expect(fixture.valid.length).toBeGreaterThanOrEqual(30);
    expect(fixture.invalid.length).toBeGreaterThanOrEqual(40);
    expect(fixture.valid.length + fixture.invalid.length).toBeGreaterThanOrEqual(75);
  });

  it("accepts every valid look, through checkCarDetail and through checkCarLook", () => {
    fixture.valid.forEach((look, i) => {
      expect(lookProblems(look), `valid ${i}`).toEqual([]);
      if (look.detail !== undefined) expect(problems(look.detail), `valid ${i}`).toEqual([]);
    });
  });

  it("refuses every invalid look, naming the path", () => {
    for (const [i, c] of fixture.invalid.entries()) {
      const out = lookProblems(c.look);
      expect(out.length, `invalid ${i} ${c.path}`).toBeGreaterThan(0);
      const needle = c.path === "" ? "car.detail " : `car.detail.${c.path} `;
      expect(
        out.some((m) => m.includes(needle)),
        `invalid ${i} ${c.path}: ${out.join(" | ")}`,
      ).toBe(true);
      expect(lookProblems({ ...c.look, detail: undefined }), `invalid ${i} without detail`).toEqual([]);
    }
  });

  it("holds the extremes: the smallest and the largest profile, 6 extras, every id of every list", () => {
    const paths = new Set<string>();
    for (const l of fixture.valid) {
      const flat = (o: unknown, p: string): void => {
        if (o !== null && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) flat(v, p ? `${p}.${k}` : k);
        else paths.add(p);
      };
      flat(l.detail ?? {}, "");
    }
    // every rule's path appears in some valid look
    for (const p of Object.keys(CAR_DETAIL)) expect(paths.has(p), `fixture never uses ${p}`).toBe(true);
    // every id of every choice appears in some valid look
    const seen = new Map<string, Set<unknown>>();
    for (const l of fixture.valid) {
      const get = (o: unknown, parts: string[]): unknown => parts.reduce<unknown>((a, k) => (a !== null && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);
      for (const [path, rule] of Object.entries(CAR_DETAIL)) {
        if (!("e" in rule)) continue;
        const v = get(l.detail, path.split("."));
        if (v !== undefined) (seen.get(path) ?? seen.set(path, new Set()).get(path)!).add(v);
      }
    }
    for (const [path, rule] of Object.entries(CAR_DETAIL)) {
      if (!("e" in rule) || path === "profile.body") continue;
      const miss = rule.e.filter((id) => !seen.get(path)?.has(id));
      expect(miss, `${path} misses some choices`).toEqual([]);
    }
    const profiles = fixture.valid.map((l) => l.detail?.profile).filter(Boolean);
    for (const k of PROFILE_KEYS) {
      expect(profiles.some((p) => (p as unknown as Record<string, number>)[k] === PROFILE_RANGES[k][0]), `${k} min`).toBe(true);
      expect(profiles.some((p) => (p as unknown as Record<string, number>)[k] === PROFILE_RANGES[k][1]), `${k} max`).toBe(true);
    }
  });
});

describe("the presets", () => {
  it("has a complete, in-range profile for every body, named for its body", () => {
    for (const body of BODY_IDS) {
      const p = PRESET[body] as unknown as Record<string, unknown>;
      expect(Object.keys(p), body).toHaveLength(35);
      expect(p["body"], body).toBe(body);
      expect(problems({ v: 1, profile: p }), body).toEqual([]);
    }
  });

  it("keeps the nine drawn bodies as the design's table says and the other three as copies of compact", () => {
    expect(PRESET.sports.lh).toBe(360);
    expect(PRESET.sports.wh).toBe(150);
    expect(PRESET.bus.panes).toBe(5);
    expect(PRESET.van.cowlX).toBe(10);
    expect(PRESET.pickup.deckX).toBe(56);
    for (const body of ["motorbike", "plane", "boat"] as CarBody[]) expect({ ...PRESET[body], body: "compact" }).toEqual(PRESET.compact);
  });

  it("makes each body's typical parts a valid detail on its own", () => {
    for (const body of BODY_IDS) expect(problems({ v: 1, ...PRESET_PARTS[body] }), body).toEqual([]);
    expect(PRESET_PARTS.sports.front?.splitter).toBe("lip");
    expect(PRESET_PARTS.sports.rear?.spoiler).toBe("lip");
    expect(PRESET_PARTS.suv.arches).toBe("square");
    expect(PRESET_PARTS.suv.side?.skirts).toBe("boards");
    expect(PRESET_PARTS.bus.side?.doors).toBe(2);
  });

  it("is frozen in shape: a profile's keys are the rules' keys", () => {
    expect(Object.keys(PRESET.sedan).sort()).toEqual(["body", ...PROFILE_KEYS].sort());
    expect(Object.keys(CAR_DETAIL).filter((p) => p.startsWith("profile.")).length).toBe(35);
  });
});

describe("resolveDetail: the one place a default lives", () => {
  const deepNoUndefined = (o: unknown, path: string): void => {
    expect(o, path).not.toBeUndefined();
    if (o !== null && typeof o === "object" && path !== ".car" && path !== ".detail") for (const [k, v] of Object.entries(o)) deepNoUndefined(v, `${path}.${k}`);
  };

  it("decides everything for a bare {v:1} on every body (no undefined anywhere)", () => {
    for (const body of BODY_IDS) {
      const r = R({ v: 1 }, { body });
      deepNoUndefined(r, "");
      expect(r.family, body).toBe(VEHICLE_OF[body]);
      expect(r.profile, body).toEqual(PRESET[body]);
      expect(r.fromPhotos, body).toBe(false);
      expect(r.toon).toBe(30);
      expect(r.trim).toBe("#23252b");
      expect(r.finish).toBe(PRESET_PARTS[body].finish ?? "gloss");
    }
  });

  it("is a copy: the preset and the look are never changed", () => {
    const car = withDetail({ v: 1, extras: ["antenna"] }, { body: "sports" });
    const before = JSON.stringify(car);
    const frozen = JSON.stringify(PRESET);
    const r = resolveDetail(car);
    r.profile.lh = 1;
    r.extras.push("ladder");
    expect(JSON.stringify(car)).toBe(before);
    expect(JSON.stringify(PRESET)).toBe(frozen);
  });

  it("takes the profile only while it was measured as this body", () => {
    const mine = { ...PRESET.sports, lh: 379, body: "sports" as const };
    const same = R({ v: 1, profile: mine }, { body: "sports" });
    expect(same.fromPhotos).toBe(true);
    expect(same.profile.lh).toBe(379);
    const other = R({ v: 1, profile: mine }, { body: "sedan" });
    expect(other.fromPhotos).toBe(false);
    expect(other.profile).toEqual(PRESET.sedan);
    // and the numbers wait untouched: back to sports they are used again
    expect(R({ v: 1, profile: mine }, { body: "sports" }).profile.lh).toBe(379);
    // a half or bad profile is ignored, whatever else the detail says
    const half = { ...mine } as Record<string, unknown>;
    delete half["tipH"];
    expect(R({ v: 1, profile: half as never }, { body: "sports" }).fromPhotos).toBe(false);
    expect(R({ v: 1, profile: { ...mine, lh: 9999 } }, { body: "sports" }).profile).toEqual(PRESET.sports);
  });

  it("maps the classic wheel style to a shape, spokes and tyre", () => {
    const want = { steel: ["steel", 8], hubcap: ["cap", 8], alloy: ["straight", 5], sport: ["split", 5], offroad: ["block", 6] } as const;
    for (const [style, [shape, spokes]] of Object.entries(want)) {
      const r = R({ v: 1 }, { body: "hatchback", wheels: { style: style as CarLook["wheels"]["style"], rim: "#222222", size: 1 } });
      expect([style, r.wheels.shape, r.wheels.spokes]).toEqual([style, shape, spokes]);
    }
    expect(R({ v: 1 }, { body: "hatchback", wheels: { style: "offroad", rim: "#222222", size: 1 } }).wheels.tyre).toBe(44);
    expect(R({ v: 1 }, { body: "hatchback", wheels: { style: "alloy", rim: "#222222", size: 1 } }).wheels.tyre).toBe(PRESET_PARTS.hatchback.wheels?.tyre);
  });

  it("lets a detail key beat the classic field, and a named shape bring its own spokes", () => {
    const sport = { style: "sport" as const, rim: "#111111", size: 1 };
    expect(R({ v: 1, wheels: { shape: "mesh" } }, { wheels: sport }).wheels).toMatchObject({ shape: "mesh", spokes: DEFAULT_SPOKES.mesh });
    expect(R({ v: 1, wheels: { shape: "mesh", spokes: 7 } }, { wheels: sport }).wheels).toMatchObject({ shape: "mesh", spokes: 7 });
    expect(R({ v: 1, wheels: { spokes: 9 } }, { wheels: sport }).wheels).toMatchObject({ shape: "split", spokes: 9 });
    expect(R({ v: 1, wheels: { tyre: 22, lip: 10, dish: 80, wall: "white", hub: "#aa0000", rearD: 60 } }).wheels).toMatchObject({ tyre: 22, lip: 10, dish: 80, wall: "white", hub: "#aa0000", rearD: 60 });
    expect(R({ v: 1 }).wheels.rearD).toBe(PRESET[DEFAULT_CAR.body].wheelD);
    expect(R({ v: 1 }).wheels.hub).toBeNull();
  });

  it("maps the classic lamps, then lets the detail beat them", () => {
    const r = R({ v: 1 }, { lights: { front: "slim", rear: "bar" } });
    expect([r.lights.front.shape, r.lights.rear.shape]).toEqual(["slim", "bar"]);
    expect(R({ v: 1 }, { lights: { front: "square", rear: "square" } }).lights).toMatchObject({ front: { shape: "square" }, rear: { shape: "square" } });
    const d = R({ v: 1, lights: { front: { shape: "swept", drl: "hook", h: 40, lens: "yellow" }, rear: { shape: "c_shape", h: 55, lens: "smoked" } } }, { lights: { front: "round", rear: "round" } });
    expect(d.lights.front).toEqual({ shape: "swept", drl: "hook", h: 40, lens: "yellow" });
    expect(d.lights.rear).toEqual({ shape: "c_shape", h: 55, lens: "smoked" });
    expect(R({ v: 1 }).lights.front).toMatchObject({ drl: "none", h: null, lens: "clear" });
    expect(R({ v: 1 }).lights.rear).toMatchObject({ h: null, lens: "red" });
  });

  it("maps the spoiler: classic `spoiler` is a wing, a detail key wins, else the body's own", () => {
    expect(R({ v: 1 }, { body: "sedan", extra: "spoiler" }).rear.spoiler).toBe("wing");
    expect(R({ v: 1, rear: { spoiler: "lip" } }, { body: "sedan", extra: "spoiler" }).rear.spoiler).toBe("lip");
    expect(R({ v: 1 }, { body: "sedan", extra: "none" }).rear.spoiler).toBe("none");
    expect(R({ v: 1 }, { body: "sports", extra: "none" }).rear.spoiler).toBe("lip");
  });

  it("maps the classic pattern to a stripe and a two-tone, the detail beating it", () => {
    const stripe = (pattern: CarLook["pattern"], detail: CarDetail = { v: 1 }) => R(detail, { body: "sedan", pattern, accent: "#ab12cd" }).stripe;
    expect(stripe("racing_stripes")).toEqual({ layout: "twin", color: "#ab12cd", width: 50 });
    expect(stripe("stripe").layout).toBe("side");
    expect(stripe("plain").layout).toBe("none");
    expect(stripe("two_tone").layout).toBe("none");
    expect(stripe("plain", { v: 1, stripe: { layout: "centre", color: "#111111", width: 60 } })).toEqual({ layout: "centre", color: "#111111", width: 60 });
    expect(stripe("racing_stripes", { v: 1, stripe: { layout: "pin" } }).layout).toBe("pin");
    expect(R({ v: 1 }, { pattern: "two_tone" }).twoTone).toBe("roof");
    expect(R({ v: 1, twoTone: "lower" }, { pattern: "two_tone" }).twoTone).toBe("lower");
    expect(R({ v: 1 }, { pattern: "plain" }).twoTone).toBeNull();
  });

  it("reads the roof: closed by default, open and targa open the outline, a van and a bus refuse them", () => {
    expect(R({ v: 1 }).roof).toEqual({ type: "closed", color: null, hoops: "none", rails: false });
    const spider = R({ v: 1, roof: { type: "open", hoops: "twin" } }, { body: "sports" });
    expect(spider.open).toBe(true);
    expect(spider.roof.hoops).toBe("twin");
    expect(R({ v: 1, roof: { type: "targa", hoops: "bar" } }, { body: "sports" }).open).toBe(true);
    expect(R({ v: 1, roof: { type: "soft_top", color: "#222222" } }, { body: "sports" })).toMatchObject({ open: false, roof: { type: "soft_top", color: "#222222" } });
    expect(R({ v: 1, roof: { type: "open" } }, { body: "van" }).roof.type).toBe("closed");
    expect(R({ v: 1, roof: { type: "targa" } }, { body: "bus" }).roof.type).toBe("closed");
    expect(R({ v: 1, roof: { type: "glass" } }, { body: "bus" }).roof.type).toBe("glass");
    expect(R({ v: 1, roof: { type: "open" } }, { body: "pickup" }).open).toBe(true);
    expect(R({ v: 1, roof: { type: "open" } }, { body: "boat" }).open).toBe(true);
    expect(R({ v: 1, roof: { type: "soft_top" } }, { body: "boat" }).roof.type).toBe("closed");
    expect(R({ v: 1, roof: { type: "open" } }, { body: "motorbike" }).roof.type).toBe("closed");
    // hoops belong to an open top only; rails to a closed one
    expect(R({ v: 1, roof: { hoops: "twin", rails: true } }, { body: "sedan" }).roof).toMatchObject({ hoops: "none", rails: true });
    expect(R({ v: 1, roof: { type: "open", rails: true } }, { body: "sedan" }).roof.rails).toBe(false);
  });

  it("counts the rows by body, lets the detail beat them, and lets the inside photos beat the seat key", () => {
    const rows = (body: CarBody, detail: CarDetail = { v: 1 }) => R(detail, { body }).cabin.rows;
    expect([rows("sports"), rows("pickup"), rows("motorbike"), rows("bus"), rows("sedan"), rows("suv"), rows("van"), rows("plane")]).toEqual([1, 1, 1, 3, 2, 2, 2, 2]);
    expect(rows("sports", { v: 1, cabin: { rows: 2 } })).toBe(2);
    expect(rows("bus", { v: 1, cabin: { rows: 1 } })).toBe(1);
    expect(R({ v: 1 }).cabin.seat).toBeNull();
    expect(R({ v: 1, cabin: { seat: "#101010", dial: "#ffd21f", wheel: "flat" } }).cabin).toMatchObject({ seat: "#101010", dial: "#ffd21f", wheel: "flat" });
    const inside = { seat: "#334455", dash: "#222222" };
    expect(R({ v: 1 }, { interior: inside }).cabin.seat).toBe("#334455");
    expect(R({ v: 1, cabin: { seat: "#101010" } }, { interior: inside }).cabin.seat).toBe("#334455"); // read only when `interior` is absent
  });

  it("keeps the classic colours: the accent is the mirror's and the stripe's default, the trim is dark", () => {
    const r = R({ v: 1 }, { accent: "#12ab34" });
    expect(r.mirrorColor).toBe("#12ab34");
    expect(r.stripe.color).toBe("#12ab34");
    expect(R({ v: 1, mirrorColor: "#000000", trim: "#101010" }, { accent: "#12ab34" })).toMatchObject({ mirrorColor: "#000000", trim: "#101010" });
  });

  it("starts each body from its typical parts", () => {
    expect(R({ v: 1 }, { body: "sports", extra: "none" })).toMatchObject({ front: { splitter: "lip" }, rear: { spoiler: "lip", diffuser: "fins" }, brakes: { disc: "drilled", caliper: "#c8102e" }, finish: "metallic" });
    expect(R({ v: 1 }, { body: "suv" })).toMatchObject({ arches: "square", side: { skirts: "boards", doors: 2 }, roof: { rails: true } });
    expect(R({ v: 1, front: { splitter: "blade" } }, { body: "sports" }).front).toMatchObject({ splitter: "blade", intake: "wide" }); // one key does not reset its group
    expect(R({ v: 1, arches: "clad" }, { body: "suv" }).arches).toBe("clad");
    expect(R({ v: 1 }, { body: "sedan" }).side.intakeX).toBe(66);
  });

  it("drops what does not fit the family and tells the drawer", () => {
    const all: CarDetail = {
      v: 1,
      roof: { rails: true },
      brakes: { disc: "drilled" },
      front: { grille: "mesh", intake: "wide", splitter: "blade", bumper: "chrome", fog: true },
      bonnet: { vent: "scoop" },
      side: { intake: "scoop", skirts: "deep", doors: 3, handles: "chrome", crease: "double", mirror: "stalk", rubStrip: true, fuelCap: true },
      rear: { diffuser: "deep", exhaust: "quad", spoiler: "big_wing", bumper: "black" },
      arches: "clad",
      extras: ["bull_bar", "antenna", "ladder", "mudflaps", "light_bar", "roof_rails", "spare_wheel"],
    };
    const bus = R(all, { body: "bus" });
    expect(bus.fits).toMatchObject({ profile: true, side: true, bonnet: false, arches: false });
    expect(bus.front).toMatchObject({ grille: "mesh", bumper: "chrome", intake: "none", splitter: "none", fog: false });
    expect(bus.side).toMatchObject({ doors: 3, skirts: "none", handles: "none", mirror: "none", intake: "none" });
    expect(bus.rear).toMatchObject({ bumper: "black", exhaust: "none", spoiler: "none", diffuser: "none" }); // only `stack` fits a bus
    expect(R({ ...all, rear: { exhaust: "stack" } }, { body: "bus" }).rear.exhaust).toBe("stack");
    expect(bus.bonnet.vent).toBe("none");
    expect(bus.arches).toBe("round");
    expect(bus.extras).toEqual(["antenna", "ladder", "mudflaps", "light_bar", "roof_rails"]);

    const bike = R(all, { body: "motorbike" });
    expect(bike.fits).toMatchObject({ profile: false, wheels: true, brakes: true, frontLight: true, rearLight: false, front: false, side: false, cabin: false });
    expect(bike.fromPhotos).toBe(false);
    expect(bike.rear).toMatchObject({ exhaust: "quad", spoiler: "none", diffuser: "none", bumper: "body" });
    expect(bike.front.grille).toBe("none");
    expect(bike.extras).toEqual(["antenna", "mudflaps"]);
    expect(bike.roof.rails).toBe(false);
    expect(bike.cabin).toEqual({ rows: 1, seat: null, dial: null, wheel: "round" });

    const plane = R(all, { body: "plane" });
    expect(plane.fits).toMatchObject({ wheels: true, brakes: false, rearLight: false, side: false, cabin: true });
    expect(plane.brakes.disc).toBe("none");
    expect(plane.extras).toEqual(["antenna"]);
    expect(plane.rear.exhaust).toBe("none");

    const boat = R({ ...all, roof: { type: "open" } }, { body: "boat" });
    expect(boat.fits).toMatchObject({ wheels: false, brakes: false, front: false, rear: false });
    expect(boat.extras).toEqual(["antenna", "ladder"]);
    expect(boat.open).toBe(true);

    const pickup = R(all, { body: "pickup" });
    expect(pickup.extras).toHaveLength(6);
    expect(pickup.side.doors).toBe(3);
    expect(pickup.fits.profile).toBe(true);
  });

  it("gives motorbike, plane and boat their preset outline whatever the detail carries", () => {
    for (const body of ["motorbike", "plane", "boat"] as CarBody[]) {
      const r = R({ v: 1, toon: 90, profile: { ...PRESET[body], lh: 500 } }, { body });
      expect(r.profile, body).toEqual(PRESET[body]);
      expect(r.fromPhotos, body).toBe(false);
      expect(r.toon, body).toBe(30);
    }
  });

  it("tolerates extras with unknown ids, repeats and more than six", () => {
    const r = R({ v: 1, extras: ["rocket", "antenna", "antenna", "bull_bar", "ladder", "snorkel", "tow_hook", "shark_fin", "spare_wheel"] as never });
    expect(r.extras).toEqual(["antenna", "bull_bar", "ladder", "snorkel", "tow_hook", "shark_fin"]);
    expect(R({ v: 1, extras: "antenna" as never }, { body: "suv" }).extras).toEqual([]);
  });

  it("never throws, whatever the editor state holds", () => {
    const junk: unknown[] = [null, 5, "x", [], {}, { v: 9 }, { v: 1, roof: 5, wheels: null, lights: { front: 3 }, extras: { a: 1 }, profile: "p", toon: "30" }, { v: 1, profile: { body: "sports" } }, { __proto__: { v: 1 }, constructor: 1 }];
    for (const body of BODY_IDS) {
      for (const j of junk) {
        const r = resolveDetail({ ...plain({ body }), detail: j as CarDetail });
        expect(r.family).toBe(VEHICLE_OF[body]);
        deepNoUndefined(r, "");
      }
    }
    // and a look with an unknown body or style still resolves
    expect(resolveDetail({ ...plain(), body: "tank" as never, detail: { v: 1 } }).family).toBe("car");
    expect(resolveDetail({ ...plain(), wheels: { style: "wooden" as never, rim: "#000000", size: 1 }, detail: { v: 1 } }).wheels.shape).toBe("straight");
  });

  it("gives every family a fit that names only real keys", () => {
    for (const [family, fit] of Object.entries(FAMILY_FIT)) {
      for (const [group, keys] of [["front", fit.front], ["bonnet", fit.bonnet], ["side", fit.side], ["rear", fit.rear]] as const) {
        for (const k of keys) expect(CAR_DETAIL[`${group}.${k}`], `${family} ${group}.${k}`).toBeDefined();
      }
    }
    expect(Object.keys(FAMILY_FIT).sort()).toEqual(["boat", "bus", "car", "motorbike", "plane", "truck"]);
    expect(FAMILY_FIT.car.extras).toHaveLength(12);
  });

  it("resolves every valid fixture look without a problem and keeps its classic fields", () => {
    for (const look of fixture.valid) {
      const before = JSON.stringify(look);
      const r = resolveDetail(look);
      deepNoUndefined(r, "");
      expect(JSON.stringify(look)).toBe(before);
      if (look.detail?.profile !== undefined && look.detail.profile.body === look.body && FAMILY_FIT[VEHICLE_OF[look.body]].profile) expect(r.profile).toEqual(look.detail.profile);
    }
  });

  it("reads the owner's look: open, two hoops, split wheels, yellow calipers, a centre stripe, one row", () => {
    const owner = fixture.valid[0]!;
    const r = resolveDetail(owner);
    expect(r).toMatchObject({
      open: true,
      fromPhotos: true,
      roof: { type: "open", hoops: "twin" },
      wheels: { shape: "split", spokes: 5, tyre: 22 },
      brakes: { disc: "ceramic", caliper: "#ffd21f" },
      stripe: { layout: "centre", color: "#111111", width: 60 },
      cabin: { rows: 1, wheel: "flat", dial: "#ffd21f" },
      rear: { exhaust: "high", spoiler: "ducktail", diffuser: "fins" },
      front: { intake: "split3", splitter: "blade" },
      side: { intake: "scoop", intakeX: 66 },
      finish: "satin",
    });
  });
});

describe("rule helpers", () => {
  it("ruleAllows agrees with the check for each kind", () => {
    const rules: [Rule, unknown, boolean][] = [
      [{ e: ["a", "b"] }, "a", true],
      [{ e: ["a", "b"] }, "c", false],
      [{ n: [1, 3] }, 3, true],
      [{ n: [1, 3] }, 3.5, false],
      [{ c: true }, "#aabbcc", true],
      [{ c: true }, "#AABBCC", false],
      [{ b: true }, false, true],
      [{ b: true }, 0, false],
      [{ l: ["a", "b"], max: 1 }, ["a"], true],
      [{ l: ["a", "b"], max: 1 }, ["a", "b"], false],
    ];
    for (const [rule, value, ok] of rules) expect(ruleAllows(rule, value)).toBe(ok);
  });
});
