// The engine's command line for the agent (docs/CONTRACTS.md §45.10), run with Deno:
//   deno run --allow-read cli.ts validate <script.json>        → {"ok": true} | {"ok": false, "errors": [...]}
//   deno run --allow-read cli.ts normalize <script.json>       → the normalized script (beat effects into scene lists)
//   deno run --allow-read cli.ts fit <seconds> <script.json>   → the fitted script
//   deno run --allow-read cli.ts frames <script.json> [from] [to] → one JSON line per frame: {"f": n, "p": Prim[]}
//   deno run --allow-read cli.ts scenes <script.json>          → [{"sceneId", "from", "to", "mid"}] (frame numbers)
//   deno run --allow-read cli.ts text <script.json>            → TextEvent[]
//   deno run --allow-read cli.ts audio <script.json>           → AudioEvent[]
//   deno run --allow-read cli.ts catalog                       → the CATALOG and ENGINE_VERSION
//   deno run --allow-read cli.ts version                       → {"engine": n}
// It never reads the network and writes only to stdout (errors to stderr, exit code 2).

import {
  audioTrack,
  CATALOG,
  drawFrame,
  ENGINE_VERSION,
  fitDuration,
  frameCount,
  normalizeScript,
  sceneList,
  textTrack,
  validateScript,
} from "./engine.ts";
import type { StoryScript } from "./types.ts";

// Deno's globals, declared here so the web's type check (which has no Deno types) accepts this file.
declare const Deno: {
  args: string[];
  readTextFileSync(path: string): string;
  stdout: { writeSync(data: Uint8Array): number };
  stderr: { writeSync(data: Uint8Array): number };
  exit(code: number): never;
};

const encoder = new TextEncoder();

function write(text: string): void {
  const bytes = encoder.encode(text);
  let done = 0;
  while (done < bytes.length) done += Deno.stdout.writeSync(bytes.subarray(done));
}

function fail(message: string): never {
  Deno.stderr.writeSync(encoder.encode(message + "\n"));
  Deno.exit(2);
}

function readScript(path: string | undefined): unknown {
  if (!path) fail("a script path is required");
  try {
    return JSON.parse(Deno.readTextFileSync(path));
  } catch {
    fail("the script could not be read as JSON");
  }
}

function valid(path: string | undefined): StoryScript {
  const result = validateScript(readScript(path));
  if (!result.ok) fail("invalid script: " + result.errors.join("; "));
  return result.script;
}

function main(args: string[]): void {
  const [command, ...rest] = args;
  switch (command) {
    case "validate": {
      const result = validateScript(readScript(rest[0]));
      write(JSON.stringify(result.ok ? { ok: true } : { ok: false, errors: result.errors }) + "\n");
      return;
    }
    case "normalize":
      write(JSON.stringify(normalizeScript(valid(rest[0]))) + "\n");
      return;
    case "scenes":
      write(JSON.stringify(sceneList(valid(rest[0]))) + "\n");
      return;
    case "fit": {
      const seconds = Number(rest[0]);
      if (!Number.isFinite(seconds) || seconds <= 0) fail("fit needs a number of seconds");
      write(JSON.stringify(fitDuration(valid(rest[1]), seconds)) + "\n");
      return;
    }
    case "frames": {
      const script = valid(rest[0]);
      const total = frameCount(script);
      const from = rest[1] === undefined ? 0 : Math.max(0, Math.floor(Number(rest[1])));
      const to = rest[2] === undefined ? total : Math.min(total, Math.floor(Number(rest[2])));
      for (let f = from; f < to; f += 1) write(JSON.stringify({ f, p: drawFrame(script, f) }) + "\n");
      return;
    }
    case "text":
      write(JSON.stringify(textTrack(valid(rest[0]))) + "\n");
      return;
    case "audio":
      write(JSON.stringify(audioTrack(valid(rest[0]))) + "\n");
      return;
    case "catalog":
      write(JSON.stringify({ engine: ENGINE_VERSION, catalog: CATALOG }) + "\n");
      return;
    case "version":
      write(JSON.stringify({ engine: ENGINE_VERSION }) + "\n");
      return;
    default:
      fail("unknown command; use validate, normalize, fit, frames, scenes, text, audio, catalog or version");
  }
}

main(Deno.args);
