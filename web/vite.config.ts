import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const root = import.meta.dirname;

/** Lists public/ files worth precaching (icons, manifest), as site-absolute URLs. */
function publicFiles(dir = join(root, "public")): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    // Clips Funded's sound samples (public/sounds/, 4 MB, docs/CONTRACTS.md §45.41) load only when one is played.
    if (dir === join(root, "public") && name === "sounds") continue;
    if (statSync(full).isDirectory()) out.push(...publicFiles(full));
    // The big 1024px icon is only downloaded during the posting setup (§17.2): not worth precaching.
    else if (name !== "config.json" && name !== "clip-factory-1024.png") out.push("/" + relative(join(root, "public"), full).split("\\").join("/"));
  }
  return out;
}

/** Reads the current commit from .git without running git (works in CI checkouts and plain clones). */
function gitShortSha(): string | null {
  try {
    const gitDir = join(root, "..", ".git");
    if (!existsSync(join(gitDir, "HEAD"))) return null;
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 7);
    const ref = /^ref: (.+)$/.exec(head)?.[1];
    if (!ref) return null;
    const loose = join(gitDir, ref);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim().slice(0, 7);
    const packed = existsSync(join(gitDir, "packed-refs")) ? readFileSync(join(gitDir, "packed-refs"), "utf8") : "";
    const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/**
 * The version this build reports (import.meta.env.VITE_APP_VERSION) and compares with /version.json:
 * VITE_APP_VERSION from the environment, else the git short sha, else "dev" (which never asks to update).
 */
export function appVersion(): string {
  const fromEnv = process.env.VITE_APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  return gitShortSha() ?? "dev";
}

/**
 * Emits version.json with this build's version. The deploy overwrites it with the release areas
 * (scripts/release-areas.sh); this copy keeps local previews and first deploys consistent.
 */
function versionFile(version: string): Plugin {
  return {
    name: "cf-version-file",
    apply: "build",
    generateBundle() {
      const body = { version, builtAt: new Date().toISOString(), areas: [] as string[] };
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify(body) + "\n" });
    },
  };
}

/**
 * Emits sw.js from sw/sw.js with the build's version and the exact list of hashed assets, so a new
 * deploy installs a new worker that precaches the new shell and drops the old cache.
 */
function serviceWorker(appVer: string): Plugin {
  return {
    name: "cf-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const version = `${appVer}-${Date.now().toString(36)}`;
      // Fonts outside the Latin subset load (and get cached) only if a page ever needs them.
      const assets = Object.keys(bundle)
        .filter((f) => !/\.(woff2?|ttf)$/.test(f) || (/-latin-(?!ext)/.test(f) && f.endsWith(".woff2")))
        .map((f) => "/" + f);
      const precache = Array.from(new Set(["/", "/index.html", ...assets.filter((a) => a !== "/version.json"), ...publicFiles()]));
      const source = readFileSync(join(root, "sw/sw.js"), "utf8")
        .replace("__CF_VERSION__", JSON.stringify(version))
        .replace("__CF_PRECACHE__", JSON.stringify(precache));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

/**
 * Ask Clip Factory's corpus for the API (docs/CONTRACTS.md §19.2): emits assets/help-corpus.<sha256-12>.json
 * (immutable, cached) and names it in index.html (uploaded no-cache) with a cf-help-corpus meta tag, so the API
 * always reads the corpus of the UI that is deployed. The app itself imports the corpus lazily.
 */
export function helpCorpusFile(source: Buffer | string): string {
  return `assets/help-corpus.${createHash("sha256").update(source).digest("hex").slice(0, 12)}.json`;
}

function helpCorpus(): Plugin {
  let fileName = "";
  return {
    name: "cf-help-corpus",
    apply: "build",
    buildStart() {
      const source = readFileSync(join(root, "src/features/help/help-corpus.json"));
      fileName = helpCorpusFile(source);
      this.emitFile({ type: "asset", fileName, source });
    },
    transformIndexHtml() {
      return [{ tag: "meta", attrs: { name: "cf-help-corpus", content: `/${fileName}` }, injectTo: "head" }];
    },
  };
}

export default defineConfig(({ mode }) => {
  // `vite --mode mock` is the same as VITE_MOCK=1: the whole UI runs on the in-memory API.
  if (mode === "mock") process.env.VITE_MOCK ??= "1";
  const version = appVersion();
  return {
    plugins: [react(), helpCorpus(), versionFile(version), serviceWorker(version)],
    define: { "import.meta.env.VITE_APP_VERSION": JSON.stringify(version) },
    // The app imports config/monetization.json from the repo root (docs/CONTRACTS.md §25.2): let the dev server read it.
    // stories/config: Lamo Stories' own config (docs/CONTRACTS.md §45.34), read by its screens in dev mode only.
    server: { port: 5173, fs: { allow: [root, join(root, "..", "config"), join(root, "..", "stories", "config")] } },
    build: { outDir: "dist", sourcemap: false, target: "es2022" },
  };
});
