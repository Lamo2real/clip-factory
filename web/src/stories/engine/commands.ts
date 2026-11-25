// The engine's command line (docs/CONTRACTS.md §45.10) without Deno: cli.ts hands it the arguments, a file reader
// and stdout, so the very same commands run under vitest. Every problem is one sentence for stderr and exit code 2.

import { CAR_DETAIL, CAR_DETAIL_V, CAR_DETAIL_WHOLE, PRESET, PRESET_PARTS } from "./carDetail.ts";
import { CATALOG } from "./catalog.ts";
import { drawFrame, ENGINE_VERSION } from "./engine.ts";
import { FORMATS } from "./frame.ts";
import { PROP_STATES, RULES } from "./rules.ts";
import { fitDuration, frameCount, LIMITS, normalizeScript, repairScript, SEATS, sceneList, validateCharacter, validateScript } from "./script.ts";
import { audioTrack, textTrack } from "./tracks.ts";
import type { StoryScript } from "./types.ts";

export interface CliIO {
  /** a file's text; throws when it cannot be read */
  read(path: string): string;
  /** writes to stdout */
  write(text: string): void;
}

/** A problem that ends the command: its sentence goes to stderr and the exit code is 2. */
export class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

/** What `catalog` prints: the vocabulary, the limits, what the free words and numbers mean, and the six sizes a video
 * can have (`formats`, CONTRACTS §45.34; the first is the default). */
export function catalogOutput(): { engine: number; catalog: typeof CATALOG; limits: typeof LIMITS & { seats: typeof SEATS }; rules: typeof RULES; propStates: typeof PROP_STATES; formats: typeof FORMATS; carDetail: CarDetailCatalog } {
  return { engine: ENGINE_VERSION, catalog: CATALOG, limits: { ...LIMITS, seats: SEATS }, rules: RULES, propStates: PROP_STATES, formats: FORMATS, carDetail: { v: CAR_DETAIL_V, rules: CAR_DETAIL, whole: CAR_DETAIL_WHOLE, presets: { profile: PRESET, parts: PRESET_PARTS } } };
}

/** What `catalog` prints about a vehicle's `detail` (CONTRACTS §45.48): the rules the agent reads live, so the engine,
 * the API and the agent never disagree on what a detail may hold. */
export interface CarDetailCatalog {
  v: number;
  rules: typeof CAR_DETAIL;
  whole: string[];
  presets: { profile: typeof PRESET; parts: typeof PRESET_PARTS };
}

function readJson(io: CliIO, path: string | undefined, what: string): unknown {
  if (!path) fail(`a ${what} path is required`);
  let text = "";
  try {
    text = io.read(path);
  } catch {
    fail(`the ${what} file could not be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail(`the ${what} could not be read as JSON`);
  }
}

function valid(io: CliIO, path: string | undefined): StoryScript {
  const result = validateScript(readJson(io, path, "script"));
  if (!result.ok) fail("invalid script: " + result.errors.join("; "));
  return result.script;
}

/** A frame number from the command line: a whole number of 0 or more. */
function frameArg(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value.trim())) fail(`frames needs whole frame numbers of 0 or more (got "${value.slice(0, 20)}")`);
  return Number(value.trim());
}

/** Runs one command; throws CliError for a problem. */
export function runCommand(args: string[], io: CliIO): void {
  const [command, ...rest] = args;
  switch (command) {
    case "validate": {
      const result = validateScript(readJson(io, rest[0], "script"));
      io.write(JSON.stringify(result.ok ? { ok: true } : { ok: false, errors: result.errors }) + "\n");
      return;
    }
    case "normalize":
      io.write(JSON.stringify(normalizeScript(valid(io, rest[0]))) + "\n");
      return;
    case "scenes":
      io.write(JSON.stringify(sceneList(valid(io, rest[0]))) + "\n");
      return;
    case "fit": {
      const seconds = Number(rest[0]);
      if (rest[0] === undefined || !rest[0].trim() || !Number.isFinite(seconds) || seconds <= 0) fail("fit needs a number of seconds");
      io.write(JSON.stringify(fitDuration(valid(io, rest[1]), seconds)) + "\n");
      return;
    }
    case "frames": {
      const script = valid(io, rest[0]);
      const total = frameCount(script);
      const from = frameArg(rest[1], 0);
      const end = frameArg(rest[2], total);
      if (rest[2] !== undefined && from > end) fail(`frames needs from (${from}) at or before to (${end})`);
      const to = Math.min(total, end);
      for (let f = from; f < to; f += 1) io.write(JSON.stringify({ f, p: drawFrame(script, f) }) + "\n");
      return;
    }
    case "text":
      io.write(JSON.stringify(textTrack(valid(io, rest[0]))) + "\n");
      return;
    case "audio":
      io.write(JSON.stringify(audioTrack(valid(io, rest[0]))) + "\n");
      return;
    case "catalog":
      io.write(JSON.stringify(catalogOutput()) + "\n");
      return;
    case "character":
      io.write(JSON.stringify(validateCharacter(readJson(io, rest[0], "character"))) + "\n");
      return;
    case "repair": {
      // after the writer's last try: stray faces become neutral, stray noises go; then the script is checked again
      const { script, changes } = repairScript(readJson(io, rest[0], "script"));
      const result = validateScript(script);
      io.write(JSON.stringify({ script, changes, ...(result.ok ? { ok: true } : { ok: false, errors: result.errors }) }) + "\n");
      return;
    }
    case "version":
      io.write(JSON.stringify({ engine: ENGINE_VERSION }) + "\n");
      return;
    default:
      fail("unknown command; use validate, normalize, fit, frames, scenes, text, audio, catalog, version, character or repair");
  }
}

/** Runs one command and returns its exit code (0, or 2 after writing the problem with `error`). */
export function runCli(args: string[], io: CliIO & { error(text: string): void }): number {
  try {
    runCommand(args, io);
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      io.error(e.message + "\n");
      return 2;
    }
    throw e;
  }
}
