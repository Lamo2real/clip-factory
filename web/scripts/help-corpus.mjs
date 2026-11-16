// Builds Ask Clip Factory's knowledge (docs/CONTRACTS.md §19.2) from the app's own source, with no network:
// the router's pages, the Nav, the whole settings tree (one doc per tree, branch and apple), the screens' headings,
// buttons, labels, tips, toasts and data-help anchors, plus the curated guides in src/features/help/helpKb.json.
// Writes src/features/help/help-corpus.json (committed, so the api build and tests read the same file).
//
//   node scripts/help-corpus.mjs            write the corpus
//   node scripts/help-corpus.mjs --check    fail when the committed corpus, the routes table in
//                                           docs/HELP_ASSISTANT.md or the /v1/help rows of CONTRACTS §19 are stale
//   node scripts/help-corpus.mjs --write-docs   also rewrite the routes table in docs/HELP_ASSISTANT.md
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const web = resolve(import.meta.dirname, "..");
const repo = resolve(web, "..");
const src = join(web, "src");
const OUT = join(src, "features/help/help-corpus.json");
const KB = join(src, "features/help/helpKb.json");
const DOCS = join(repo, "docs/HELP_ASSISTANT.md");
const CONTRACTS = join(repo, "docs/CONTRACTS.md");
const API_ROUTES = join(repo, "api/src/clipfactory_api/routes/__init__.py");

export const METRICS = [
  "best_clip_week_views",
  "week_total_views",
  "week_clips",
  "review_waiting",
  "jobs_running",
  "clips_posted",
  "latest_job",
  "clip_views",
  "skills_on",
  "accounts_connected",
];

/**
 * Stopwords for both retrievers (the corpus carries them to retrieve.py). "off", "on", "up" and numbers carry meaning
 * here; "help" does not (every question asks for help, and a bare "help" should get the suggestion chips).
 */
export const STOPWORDS = `a about after again all am an and any are as at be been before being but by can could did do does doing
for from get got had has have having he her here hers him his how i if in into is it its just me might my
myself need of or our please she should so some than that the their them then there these they this those to
too us very via was we were what whats when where which while who why will with would you your yours i'm im
can't cant don't dont want wanna let lets sure help`
  .split(/\s+/)
  .filter(Boolean);

/** Everyday words → the app's words (§19.2). Added to the question, never replacing it. */
export const SYNONYMS = {
  delete: "throw away",
  remove: "throw away",
  trash: "throw away",
  discard: "throw away",
  confirm: "keep",
  approve: "keep",
  "save clip": "keep",
  retry: "try again",
  redo: "try again",
  insta: "instagram",
  ig: "instagram",
  yt: "youtube",
  "tik tok": "tiktok",
  twitter: "x",
  vod: "source",
  stream: "source",
  video: "source",
  videos: "clips",
  "my clips": "library",
  "my videos": "library",
  link: "source",
  stats: "performance",
  statistics: "performance",
  numbers: "performance",
  views: "performance",
  "sound effect": "sound",
  beep: "sound",
  install: "get the app",
  download: "get the app",
  dark: "reduce motion",
  calm: "reduce motion",
  calmer: "reduce motion",
};

/** Keys, ids and infra words never reach the corpus. "Cookies" stays: it is the YouTube cookies setting. */
export const SENSITIVE =
  /arn:|amazonaws|AKIA[0-9A-Z]{12,}|\b\d{12}\b|[\w.+-]+@[\w-]+\.[\w.]+|s3:\/\/|https?:\/\/[^\s]*\?|\b(?:passwords?|secrets?|tokens?|api keys?|access keys?|lambdas?|dynamodb|bedrock|cognito|cloudfront|agentcore|terraform|jwts?|sub claim)\b/i;
export const DASH = /[\u2013\u2014]/;

const LIMITS = { answer: 400, steps: 6, actions: 2, label: 24 };

/** Em and en dashes in UI strings: "5–10" reads "5 to 10", anything else becomes a comma. */
function undash(s) {
  return s.replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, "$1 to $2").replace(/\s*[\u2013\u2014]\s*/g, ", ");
}

function clean(s) {
  return undash(
    s
      .replace(/\{[^{}]*\}/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+([.,!?])/g, "$1")
      .trim(),
  );
}

/** A UI string worth keeping: has letters, is not code, and is not sensitive. */
function keep(s) {
  return s.length >= 2 && s.length <= 160 && /[A-Za-z]{2}/.test(s) && !/[;=]|=>|\$\{|\bclassName\b/.test(s) && !SENSITIVE.test(s);
}

const uniq = (xs) => Array.from(new Set(xs));
const read = (f) => readFileSync(f, "utf8");
const rel = (f) => relative(web, f).split("\\").join("/");

// ---------- Source scanning ----------

function walk(dir, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name.name)) out.push(full);
  }
  return out;
}

/** Relative imports of a source file that live under screens/ or components/. */
function localImports(file) {
  const out = [];
  for (const m of read(file).matchAll(/from\s+"(\.{1,2}\/[^"]+\.tsx?)"/g)) {
    const target = resolve(dirname(file), m[1]);
    if (/[\\/]src[\\/](screens|components)[\\/]/.test(target) && existsSync(target)) out.push(target);
  }
  return out;
}

/** Shared parts that carry no page-specific words. */
const SKIP_FILES = /components[\\/](ui|Icon|Backdrop|Toasts|PlatformMark|PlatformStack|Sparkline|LiveDot|Nav)\.tsx$/;

/** The files that draw one page: its entry and what it imports, but never another page's own entry file. */
function filesFrom(entry, otherEntries) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || SKIP_FILES.test(f) || (f !== entry && otherEntries.has(f))) continue;
    seen.add(f);
    stack.push(...localImports(f));
  }
  return Array.from(seen).sort();
}

/** Headings, buttons, labels, tips, toasts and empty states of one file. */
function uiStrings(file) {
  const text = read(file);
  const labels = [];
  const ledes = [];
  const notes = [];
  for (const m of text.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/g)) labels.push(clean(m[1]));
  // A button's words follow its last ">" (attributes may hold arrow functions).
  for (const m of text.matchAll(/<(Button|LinkButton)\b[\s\S]*?<\/\1>/g)) {
    const words = m[0].replace(/<\/(Button|LinkButton)>$/, "").split(">").pop() ?? "";
    if (!words.includes("{")) labels.push(clean(words));
  }
  for (const m of text.matchAll(/\b(aria-label|data-tip|title|label)="([^"]+)"/g)) labels.push(clean(m[2]));
  for (const m of text.matchAll(/\blede="([^"]+)"/g)) ledes.push(clean(m[1]));
  for (const m of text.matchAll(/\blede=\{([\s\S]*?)\}\s*\/?>?\n/g)) for (const q of m[1].matchAll(/"([^"]{12,})"/g)) ledes.push(clean(q[1]));
  for (const m of text.matchAll(/<p className="(?:hero__lede|page-head__lede)"[^>]*>([\s\S]*?)<\/p>/g)) ledes.push(clean(m[1]));
  // Toasts and empty states: the short ones are good search words.
  for (const m of text.matchAll(/toast\.(?:success|error|info|undo)\(\s*"([^"]+)"/g)) notes.push(clean(m[1]));
  for (const m of text.matchAll(/<Empty\b[^>]*\btitle="([^"]+)"/g)) notes.push(clean(m[1]));
  return { labels: labels.filter(keep), ledes: ledes.filter(keep), notes: notes.filter(keep) };
}

/** Every data-help id in the source, plus the prefixes of `data-help={`nav-${…}`}` templates. */
export function anchorsIn(files) {
  const ids = new Set();
  const prefixes = new Set();
  for (const f of files) {
    const text = read(f);
    for (const m of text.matchAll(/data-help="([^"]+)"/g)) for (const id of m[1].split(/\s+/)) ids.add(id);
    // Segmented options carry their anchor as `help: "upload-video"`.
    for (const m of text.matchAll(/\bhelp: "([a-z0-9-]+)"/g)) ids.add(m[1]);
    for (const m of text.matchAll(/data-help=\{([^}]*)\}/g)) {
      for (const s of m[1].matchAll(/"([a-z0-9 -]+)"/g)) for (const id of s[1].split(/\s+/)) if (id) ids.add(id);
      for (const t of m[1].matchAll(/`([a-z-]+)-\$\{/g)) prefixes.add(`${t[1]}-`);
    }
  }
  return { ids, prefixes };
}

// ---------- Routes ----------

/** The app's pages, as docs/HELP_ASSISTANT.md lists them: name and path. */
function routesFrom(routerSource, TREES, match) {
  const out = [];
  const add = (path) => {
    const [p, q = ""] = path.split("?");
    out.push({ name: match(p.replace(/\{\w+\}/g, "x"), q ? `?${q}` : "").name, path });
  };
  for (const m of routerSource.matchAll(/path === "([^"]+)"|\^\\\/([a-z]+)\\\/\(/g)) {
    if (m[1] === "/settings") continue;
    if (m[1]) {
      add(m[1]);
      if (m[1] === "/library" && routerSource.includes('query.get("view") === "week"')) add("/library?view=week");
    } else if (m[2]) {
      add(`/${m[2]}/{${m[2].replace(/s$/, "")}Id}`);
    }
  }
  // Settings: the field and every branch page (§15.1).
  const settingsAt = out.findIndex((r) => r.path.startsWith("/get-app"));
  const settings = [{ name: "settings", path: "/settings" }];
  for (const t of TREES) for (const b of t.branches) settings.push({ name: "settings", path: `/settings/${t.slug}/${b.slug}` });
  out.splice(settingsAt < 0 ? out.length : settingsAt, 0, ...settings);
  return out;
}

export function routesTable(routes) {
  return ["| Route | Path |", "|---|---|", ...routes.map((r) => `| ${r.name} | \`${r.path}\` |`)].join("\n");
}

// ---------- Docs ----------

function navItems() {
  const text = read(join(src, "components/Nav.tsx"));
  return Array.from(text.matchAll(/\{ key: "(\w+)", href: "([^"]+)", label: "([^"]+)"/g)).map((m) => ({ key: m[1], href: m[2], label: m[3] }));
}

/** Which component file draws each page, from App.tsx's Screen switch and its imports. */
function screenEntries() {
  const appFile = join(src, "app/App.tsx");
  const text = read(appFile);
  const imports = new Map();
  for (const m of text.matchAll(/import \{ ([^}]+) \} from "(\.\.\/(?:screens|components)\/[^"]+)"/g))
    for (const name of m[1].split(",").map((s) => s.trim())) imports.set(name, resolve(dirname(appFile), m[2]));
  const block = text.slice(text.indexOf("function Screen("));
  const out = new Map();
  for (const m of block.matchAll(/case "(\w+)":([\s\S]*?)(?=case "|default:)/g)) {
    const comp = Array.from(m[2].matchAll(/<([A-Z]\w+)/g))
      .map((c) => c[1])
      .find((c) => imports.has(c));
    if (comp) out.set(m[1], imports.get(comp));
  }
  return out;
}

/** The pages a doc is made for. `blurb` is used when the page has no lede of its own. */
const PAGES = [
  { name: "home", path: "/", nav: "home", title: "Home", words: ["start", "main page"], blurb: "Home is where you start new clips." },
  { name: "jobs", path: "/jobs", nav: "jobs", title: "Jobs", words: ["jobs list"], blurb: "Jobs shows every link or video you added." },
  {
    name: "job",
    path: "/jobs",
    nav: "jobs",
    title: "A job's page",
    where: "Jobs › a job",
    words: ["job steps", "job page"],
    blurb: "A job's page shows each step as your clips are made. Tap a job in Jobs to open it.",
  },
  { name: "review", path: "/review", nav: "review", title: "Review", words: ["check clips"], blurb: "Review is where you check new clips." },
  { name: "library", path: "/library", nav: "library", title: "Library", words: ["kept clips", "posted clips"], blurb: "Library has every clip you kept." },
  {
    name: "clip",
    path: "/library",
    nav: "library",
    title: "A clip's numbers",
    where: "Library › a clip",
    words: ["clip page"],
    blurb: "A clip's page shows how it does on each app. Tap a clip in Library to open it.",
  },
  { name: "get_app", path: "/get-app", title: "Get the app", words: ["install"], blurb: "Get the app puts Clip Factory on this device, next to your other apps." },
];

/** Button words that say nothing about a page ("Go back", "Try again"), so they never make it a page's keyword. */
const GENERIC = /^(?:jobs?|clips?|tap|go|back|try|again|open|see|on|off|each|app|here|now|more)$/;

function pageDocs(nav) {
  const entries = screenEntries();
  const docs = [];
  const files = [];
  for (const p of PAGES) {
    const entry = entries.get(p.name);
    if (!entry) throw new Error(`help-corpus: no screen for route ${p.name} in App.tsx`);
    const item = nav.find((n) => n.key === p.nav);
    const label = item?.label ?? p.title;
    const labels = [];
    const ledes = [];
    const others = new Set(Array.from(entries.values()).filter((f) => f !== entry));
    for (const f of filesFrom(entry, others)) {
      files.push(f);
      const s = uiStrings(f);
      labels.push(...s.labels, ...s.notes);
      ledes.push(...s.ledes);
    }
    // Each word once, and not the page's own name: a page doc must not drown the curated guides by repeating it.
    const own = new Set(`${p.title} ${label}`.toLowerCase().split(/[^a-z0-9]+/));
    const stop = new Set(STOPWORDS);
    const words = labels
      .filter((l) => l.split(" ").length <= 4)
      .flatMap((l) => l.toLowerCase().split(/[^a-z0-9]+/))
      .filter((w) => w.length > 1 && !stop.has(w) && !own.has(w) && !GENERIC.test(w));
    const keywords = uniq([...p.words, ...words]).slice(0, 30);
    const lede = ledes.find((s) => s.length <= LIMITS.answer && /[.!]$/.test(s));
    const open = p.name === "home" ? "Go to Home" : `Open ${label}`;
    docs.push({
      id: `page-${p.name.replace(/_/g, "-")}`,
      kind: "page",
      route: p.path,
      where: p.where ?? label,
      title: p.title,
      keywords,
      answer: lede ?? p.blurb,
      steps: item ? [`Tap **${item.label}**.`] : [`Tap **${p.title}**.`],
      actions: [{ id: `page-${p.name.replace(/_/g, "-")}:open`, label: open, to: p.path, ...(item ? { highlight: [`nav-${item.key}`] } : {}) }],
    });
  }
  return { docs, files };
}

function settingsDocs(TREES) {
  const docs = [];
  const label = (name) => (`Open ${name}`.length <= LIMITS.label ? `Open ${name}` : name.slice(0, LIMITS.label));
  docs.push({
    id: "settings",
    kind: "page",
    route: "/settings",
    where: "Settings",
    title: "Settings",
    keywords: ["settings", "find a setting", "options", "preferences", ...TREES.map((t) => t.name)],
    answer: `Settings has ${TREES.map((t) => t.name).join(", ")}. Type in **Find a setting** to jump to one.`,
    steps: ["Tap **Settings**.", "Type what you want in **Find a setting**."],
    actions: [{ id: "settings:open", label: "Open Settings", to: "/settings", highlight: ["nav-settings"] }],
  });
  for (const t of TREES) {
    docs.push({
      id: `settings-${t.slug}`,
      kind: "page",
      route: `/settings/${t.slug}`,
      where: `Settings › ${t.name}`,
      title: t.name,
      keywords: t.branches.map((b) => b.name),
      answer: `${t.line} It has ${t.branches.map((b) => b.name).join(", ")}.`,
      steps: ["Tap **Settings**.", `Tap **${t.name}**.`],
      actions: [{ id: `settings-${t.slug}:open`, label: label(t.name), to: `/settings/${t.slug}` }],
    });
    for (const b of t.branches) {
      const route = `/settings/${t.slug}/${b.slug}`;
      const where = `Settings › ${t.name} › ${b.name}`;
      const when = b.onlyWhenNotInstalled ? { when: { installed: false } } : {};
      const steps = ["Tap **Settings**.", `Tap **${t.name}**, then **${b.name}**.`];
      docs.push({
        id: `settings-${t.slug}-${b.slug}`,
        kind: "page",
        route,
        where,
        title: b.name,
        keywords: b.apples.map((a) => a.name),
        answer: b.line,
        steps,
        actions: [{ id: `settings-${t.slug}-${b.slug}:open`, label: label(b.name), to: route }],
        ...when,
      });
      for (const a of b.apples) {
        // An apple with its own `href` lives on another page (a platform's setup page, §17.1): go there instead.
        const to = a.href ?? `${route}#${a.id}`;
        docs.push({
          id: `apple-${a.id}`,
          kind: "apple",
          route: to.split("#")[0],
          hash: a.id,
          where,
          title: a.name,
          keywords: (a.words ?? []).filter(keep),
          answer: a.leaf,
          steps: [...steps, `Find **${a.name}**.`],
          actions: [{ id: `apple-${a.id}:open`, label: label(b.name), to, highlight: [a.id] }],
          highlight: [a.id],
          ...when,
        });
      }
    }
  }
  return docs;
}

function guideDocs() {
  const raw = JSON.parse(read(KB));
  return raw.guides.map((g) => {
    for (const text of [g.title, g.answer, g.where, ...g.steps, ...g.keywords, ...(g.actions ?? []).map((a) => a.label), g.live?.text ?? ""]) {
      if (SENSITIVE.test(text)) throw new Error(`help-corpus: guide ${g.id} has a sensitive word: ${text}`);
      if (DASH.test(text)) throw new Error(`help-corpus: guide ${g.id} uses a dash: ${text}`);
    }
    const doc = { id: g.id, kind: "guide", route: g.route };
    if (g.hash) doc.hash = g.hash;
    Object.assign(doc, { where: g.where, title: g.title, keywords: g.keywords, answer: g.answer, steps: g.steps, actions: g.actions ?? [] });
    for (const k of ["highlight", "when", "live", "suggest", "extends"]) if (g[k] !== undefined) doc[k] = g[k];
    return doc;
  });
}

// ---------- Validation ----------

export function validate(corpus, { match, anchors, appleIds }) {
  const problems = [];
  const ids = new Set();
  const actionIds = new Set();
  const routeOk = (to) => {
    const url = new URL(to, "https://app.invalid");
    return url.origin === "https://app.invalid" && match(url.pathname, url.search).name !== "not_found";
  };
  const anchorOk = (id) => anchors.ids.has(id) || appleIds.has(id) || Array.from(anchors.prefixes).some((p) => id.startsWith(p));
  for (const d of corpus.docs) {
    if (ids.has(d.id)) problems.push(`duplicate doc id ${d.id}`);
    ids.add(d.id);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.id)) problems.push(`${d.id}: id is not kebab-case`);
    if (!routeOk(d.route)) problems.push(`${d.id}: route ${d.route} is not a page`);
    if (d.answer.length > LIMITS.answer) problems.push(`${d.id}: answer is over ${LIMITS.answer} characters`);
    if (d.steps.length > LIMITS.steps) problems.push(`${d.id}: more than ${LIMITS.steps} steps`);
    if (d.actions.length > LIMITS.actions) problems.push(`${d.id}: more than ${LIMITS.actions} actions`);
    for (const a of d.actions) {
      if (actionIds.has(a.id)) problems.push(`duplicate action id ${a.id}`);
      actionIds.add(a.id);
      if (a.label.length > LIMITS.label) problems.push(`${a.id}: label over ${LIMITS.label} characters`);
      if (!routeOk(a.to)) problems.push(`${a.id}: ${a.to} is not a page`);
      for (const h of a.highlight ?? []) if (!anchorOk(h)) problems.push(`${a.id}: no data-help anchor "${h}"`);
    }
    for (const h of d.highlight ?? []) if (!anchorOk(h)) problems.push(`${d.id}: no data-help anchor "${h}"`);
    if (d.live && !METRICS.includes(d.live.metric)) problems.push(`${d.id}: unknown live metric ${d.live.metric}`);
    const texts = [d.title, d.where, d.answer, ...d.steps, ...d.keywords, ...d.actions.map((a) => a.label), d.live?.text ?? ""];
    for (const t of texts) {
      if (DASH.test(t)) problems.push(`${d.id}: dash in "${t}"`);
      if (SENSITIVE.test(t)) problems.push(`${d.id}: sensitive text "${t}"`);
    }
  }
  return problems;
}

// ---------- Build ----------

export async function buildCorpus() {
  const { TREES } = await import(pathToFileURL(join(src, "lib/settingsTree.ts")).href);
  const { match } = await import(pathToFileURL(join(src, "lib/router.ts")).href);
  const routerSource = read(join(src, "lib/router.ts"));
  const nav = navItems();
  const pages = pageDocs(nav);
  const guides = guideDocs();
  const docs = [...guides, ...pages.docs, ...settingsDocs(TREES)];
  const routes = routesFrom(routerSource, TREES, match);
  const sourceFiles = uniq([
    "src/lib/router.ts",
    "src/components/Nav.tsx",
    "src/lib/settingsTree.ts",
    "src/app/App.tsx",
    "src/features/help/helpKb.json",
    ...pages.files.map(rel),
  ]).sort();
  const body = {
    app: "clip-factory",
    generatedFrom: sourceFiles,
    routes: routes.map((r) => r.path),
    synonyms: SYNONYMS,
    stopwords: STOPWORDS,
    docs,
  };
  const version = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 12);
  const corpus = { version, ...body };
  const anchors = anchorsIn(walk(src));
  const appleIds = new Set(TREES.flatMap((t) => t.branches.flatMap((b) => b.apples.map((a) => a.id))));
  const problems = validate(corpus, { match, anchors, appleIds });
  return { corpus, routes, problems, text: `${JSON.stringify(corpus, null, 2)}\n` };
}

function replaceBlock(text, table) {
  return text.replace(/(<!-- help-routes:start -->\n)[\s\S]*?(\n<!-- help-routes:end -->)/, `$1${table}$2`);
}

function helpRows(text) {
  return Array.from(text.matchAll(/^\|\s*(GET|POST|PUT|PATCH|DELETE) `\/v1\/(help[^`]*)`/gm)).map((m) => `${m[1]} /v1/${m[2]}`).sort();
}

function apiHelpRoutes(text) {
  return Array.from(text.matchAll(/route\("(GET|POST|PUT|PATCH|DELETE)", "\/v1\/(help[^"]*)"/g)).map((m) => `${m[1]} /v1/${m[2]}`).sort();
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const { routes, problems, text } = await buildCorpus();
  if (problems.length) {
    console.error(`help-corpus: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  const table = routesTable(routes);
  if (args.has("--check")) {
    const fails = [];
    const committed = existsSync(OUT) ? read(OUT) : "";
    if (committed !== text) fails.push("src/features/help/help-corpus.json is stale: run node scripts/help-corpus.mjs and commit it");
    if (existsSync(DOCS)) {
      const docs = read(DOCS);
      if (!docs.includes("<!-- help-routes:start -->")) fails.push("docs/HELP_ASSISTANT.md has no help-routes markers");
      else if (replaceBlock(docs, table) !== docs) fails.push("docs/HELP_ASSISTANT.md routes table is stale: run node scripts/help-corpus.mjs --write-docs");
    } else console.warn("help-corpus: docs/HELP_ASSISTANT.md not found, routes table not checked");
    if (existsSync(CONTRACTS) && existsSync(API_ROUTES)) {
      const want = apiHelpRoutes(read(API_ROUTES));
      const have = helpRows(read(CONTRACTS));
      if (want.length && JSON.stringify(want) !== JSON.stringify(have))
        fails.push(`CONTRACTS.md §19.6 lists ${have.join(", ") || "no help routes"} but the api has ${want.join(", ")}`);
    }
    if (fails.length) {
      console.error(`help-corpus --check failed:\n  ${fails.join("\n  ")}`);
      process.exit(1);
    }
    console.log("help-corpus: up to date");
    return;
  }
  if (!existsSync(OUT) || read(OUT) !== text) writeFileSync(OUT, text);
  if (args.has("--write-docs") && existsSync(DOCS)) {
    const docs = read(DOCS);
    const next = replaceBlock(docs, table);
    if (next !== docs) writeFileSync(DOCS, next);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
