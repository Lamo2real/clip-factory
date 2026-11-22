// The engine's command line for the agent (docs/CONTRACTS.md §45.10), run with Deno:
//   deno run --allow-read cli.ts validate <script.json>        → {"ok": true} | {"ok": false, "errors": [...]}
//   deno run --allow-read cli.ts normalize <script.json>       → the normalized script (beat effects and the place's
//                                                                 sounds into scene lists)
//   deno run --allow-read cli.ts fit <seconds> <script.json>   → the fitted script
//   deno run --allow-read cli.ts frames <script.json> [from] [to] → one JSON line per frame: {"f": n, "p": Prim[]}
//   deno run --allow-read cli.ts scenes <script.json>          → [{"sceneId", "from", "to", "mid"}] (frame numbers)
//   deno run --allow-read cli.ts text <script.json>            → TextEvent[]
//   deno run --allow-read cli.ts audio <script.json>           → AudioEvent[]
//   deno run --allow-read cli.ts catalog                       → {"engine": n, "catalog": CATALOG, "limits": {...},
//                                                                 "rules": [{id, text}], "propStates": {...}}
//   deno run --allow-read cli.ts version                       → {"engine": n}
//   deno run --allow-read cli.ts character <character.json>    → {"ok": true} | {"ok": false, "errors": [...]}
//                                                               (the character agent's CharacterInput)
// It never reads the network and writes only to stdout (errors to stderr, exit code 2). The commands themselves are
// commands.ts, so the web's tests run them too.

import { runCli } from "./commands.ts";

// Deno's globals, declared here so the web's type check (which has no Deno types) accepts this file.
declare const Deno: {
  args: string[];
  readTextFileSync(path: string): string;
  stdout: { writeSync(data: Uint8Array): number };
  stderr: { writeSync(data: Uint8Array): number };
  exit(code: number): never;
};

const encoder = new TextEncoder();

function writeAll(out: { writeSync(data: Uint8Array): number }, text: string): void {
  const bytes = encoder.encode(text);
  let done = 0;
  while (done < bytes.length) done += out.writeSync(bytes.subarray(done));
}

const code = runCli(Deno.args, {
  read: (path) => Deno.readTextFileSync(path),
  write: (text) => writeAll(Deno.stdout, text),
  error: (text) => writeAll(Deno.stderr, text),
});
if (code !== 0) Deno.exit(code);
