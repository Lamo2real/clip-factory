// Builds Ask's always-included app knowledge (docs/CONTRACTS.md §28.2) with no network:
//   A. the app map: every help-corpus doc compacted to one block (where, route, title, answer, steps, buttons);
//   B. the owner manual: docs/SETUP_POSTING.md, the user-facing parts of docs/BUSINESS_REQUIREMENTS.md,
//      config/platforms.json, the model labels of config/models.json (no ids) and the kid-proof words of §12.4;
//   C. the library: one file per section of CONTRACTS (§0-§28), DECISIONS (ADR-1…) and the other project docs,
//      read on demand by the read_app_doc tool; the pack carries only its index (id, title, one line).
// Everything passes the secrets filter (keys, tokens, account ids, ARNs with an account, emails, URLs with a query,
// Cognito ids) first. Writes api/src/clipfactory_api/ask/knowledge.json and api/src/clipfactory_api/ask/library/*.md.
//
//   node scripts/ask-knowledge.mjs           write them
//   node scripts/ask-knowledge.mjs --check   fail when the committed files are stale or the pack is over its size cap
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const web = resolve(import.meta.dirname, "..");
const repo = resolve(web, "..");
const CORPUS = join(web, "src/features/help/help-corpus.json");
const OUT_DIR = join(repo, "api/src/clipfactory_api/ask");
const OUT = join(OUT_DIR, "knowledge.json");
const LIBRARY = join(OUT_DIR, "library");
/** Rough tokens: four characters each. The pack must stay under 110k tokens (CI fails above). */
export const MAX_TOKENS = 110_000;
export const charsToTokens = (n) => Math.ceil(n / 4);

/** The same patterns as api/src/clipfactory_api/ask/redact.py (tests check both against one list of samples). */
export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[^\s"'`)\]]+/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,})/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /https?:\/\/[^\s"'`<>)\]]*\?[^\s"'`<>)\]]+/g,
  /\b(?:eu|us|ap|ca|sa|me|af|il|mx)-[a-z]+-\d_[A-Za-z0-9]{9}\b/g,
  /\b(?:aws_secret_access_key|secret_access_key|client_secret|api_key|apikey|password|passwd|token)\s*[=:]\s*["']?[A-Za-z0-9_\-./+=]{8,}/gi,
  /(?<!\d)\d{12}(?!\d)/g,
];
const CLIENT_ID = /(client[ _-]?id\W{0,4})[a-z0-9]{26}\b/gi;
export const HIDDEN = "[hidden]";

export function redact(text) {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, HIDDEN);
  return out.replace(CLIENT_ID, (_m, pre) => pre + HIDDEN);
}

/**
 * A setup step's own link (web/src/setup/*.ts, written by us): on a platform host with no secret-looking query
 * parameter it is kept whole, so Ask can read and name the exact page (Facebook step 1 opens
 * /pages/?category=your_pages). Anything else still goes through redact().
 */
const SETUP_LINK_HOSTS = /^(?:[a-z0-9-]+\.)*(?:facebook\.com|instagram\.com|tiktok\.com|google\.com|youtube\.com|x\.com|contentrewards\.com|whop\.com)$/;
const SECRET_PARAM = /(?:^|[_-])(?:token|key|secret|code|password|pass|sig|signature|auth|session)(?:$|[_-])/i;
export function setupLink(url) {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.keys()];
    if (u.protocol === "https:" && SETUP_LINK_HOSTS.test(u.hostname) && !params.some((k) => SECRET_PARAM.test(k)) && !u.username) {
      return url;
    }
  } catch {
    /* not a URL: redact below */
  }
  return redact(url);
}

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** Splits markdown into its `## ` sections: [{heading, text}]. Text before the first heading is "intro". */
export function sections(md) {
  const out = [];
  let current = { heading: "", text: "" };
  for (const line of md.split("\n")) {
    if (/^## /.test(line)) {
      if (current.heading || current.text.trim()) out.push(current);
      current = { heading: line.slice(3).trim(), text: line + "\n" };
    } else current.text += line + "\n";
  }
  if (current.heading || current.text.trim()) out.push(current);
  return out;
}

/** The first plain sentence of a section, for the index line (≤ 160 characters). */
function firstLine(text) {
  for (const raw of text.split("\n").slice(1)) {
    const line = raw.replace(/^[*>\-\s#|]+/, "").replace(/[`*_]/g, "").trim();
    if (line.length > 20 && !line.startsWith("```") && !/^-{3,}$/.test(line)) return line.slice(0, 160);
  }
  return "";
}

// ---------- A. the app map ----------

export function appMap(corpus) {
  const actions = [];
  const blocks = [];
  for (const d of corpus.docs) {
    const route = d.route + (d.hash ? `#${d.hash}` : "");
    const lines = [`### ${d.id} · ${d.where} · ${route} · ${d.title}`, d.answer];
    if (d.steps?.length) lines.push(...d.steps.map((s, i) => `${i + 1}. ${s}`));
    if (d.actions?.length) {
      lines.push("Buttons: " + d.actions.map((a) => `${a.id} (${a.label} → ${a.to})`).join("; "));
      for (const a of d.actions) {
        const row = { id: a.id, label: a.label, to: a.to };
        if (a.highlight?.length) row.highlight = a.highlight;
        actions.push(row);
      }
    }
    blocks.push(lines.join("\n"));
  }
  const text =
    "Every page, setting and guide of Clip Factory. Each block: id · where · route · title, then the answer, the steps " +
    "and the buttons (action ids for show_app_buttons).\n\n" +
    blocks.join("\n\n");
  return { text, actions };
}

// ---------- B. the owner manual ----------

function businessParts(md) {
  const keep = ["Functional requirements", "Non-functional requirements", "Design and experience requirements", "Out of scope"];
  return sections(md)
    .filter((s) => keep.some((k) => s.heading.startsWith(k)))
    .map((s) => s.text.trim())
    .join("\n\n");
}

function platformsText(cfg) {
  const lines = [];
  for (const id of cfg.order ?? Object.keys(cfg.platforms)) {
    const p = cfg.platforms[id];
    if (!p) continue;
    const bits = [`label ${p.label}`];
    if (p.slowNote) bits.push(`numbers: ${p.slowNote}`);
    if (p.minIntervalMinutes) bits.push(`numbers refresh at most every ${p.minIntervalMinutes} min`);
    if (p.manualCooldownMinutes) bits.push(`manual refresh every ${p.manualCooldownMinutes} min`);
    if (p.scopes) bits.push(`Connect asks for: ${p.scopes.map((s) => s.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")).join(", ")}`);
    lines.push(`- ${id}: ${bits.join("; ")}`);
  }
  return lines.join("\n");
}

function modelsText(models) {
  return models.clipModels
    .map((id) => `- ${models.models[id].label}: ${models.models[id].line ?? ""}${id === models.agentModel ? " (the default)" : ""}`)
    .join("\n");
}

function kidProof(contracts) {
  const at = contracts.indexOf("### 12.4");
  if (at < 0) return "";
  const end = contracts.indexOf("\n### ", at + 5);
  return contracts.slice(at, end < 0 ? undefined : end).trim();
}

/** The setup guides' steps (web/src/setup/*.ts), numbered 1…N per platform as the guide screens number them. */
export async function setupSteps() {
  const { GUIDES, SETUP_ORDER, allSteps } = await import(pathToFileURL(join(web, "src/setup/index.ts")).href);
  const out = {};
  for (const platform of SETUP_ORDER) {
    const guide = GUIDES[platform];
    const partOf = new Map(guide.parts.flatMap((p) => p.steps.map((s) => [s.id, p])));
    out[platform] = allSteps(guide).map((s, i) => {
      const part = partOf.get(s.id);
      const row = { id: s.id, n: i + 1, part: part?.id ?? "", partTitle: part?.title ?? "", title: s.title };
      // The step's own words for Ask's read_setup_guide tool (§28.4): never in the cached prompt, only on request.
      row.say = s.say.map(redact);
      if (s.ifYouSee?.length) row.ifYouSee = s.ifYouSee.map((x) => ({ see: redact(x.see), do: redact(x.do) }));
      if (s.open && /^https:\/\//.test(s.open.url)) row.open = { label: s.open.label, url: setupLink(s.open.url) };
      row.checkedOn = guide.checkedOn;
      if (s.optional) row.optional = true;
      if (s.auto) row.auto = s.auto;
      if (s.gate) row.gate = s.gate;
      return row;
    });
  }
  // Content Rewards (docs/CONTRACTS.md §38.17): its own guide, CR_GUIDE, under `contentrewards` next to the five.
  // Each part is numbered 1…N as its own screen numbers it (setup, Join a campaign on Campaigns, the money steps for
  // each Finance answer), so Ask never calls a money step "step 5" and its button never reads "step None". The
  // unnumbered "said no?" card belongs to step 3 (Connect), so it carries 3.
  const cr = await import(pathToFileURL(join(web, "src/setup/contentrewards.ts")).href);
  const crRows = [];
  // The money steps are one list per answer to "Do you see Finance?" (Money › Content Rewards numbers them so).
  const money = cr.CR_GUIDE.parts.filter((p) => p.id === "move" || p.id === "bank").flatMap((p) => p.steps);
  const moneyN = (s) => money.filter((x) => x.finance === (s.finance === "yes" ? "yes" : "no") || x.finance === "both").indexOf(s) + 1;
  for (const part of cr.CR_GUIDE.parts) {
    part.steps.forEach((s, i) => {
      const n = part.id === "move" || part.id === "bank" ? moneyN(s) : i + 1;
      const row = { id: s.id, n, part: part.id, partTitle: part.title, title: s.title };
      row.say = s.say.map(redact);
      if (s.ifYouSee?.length) row.ifYouSee = s.ifYouSee.map((x) => ({ see: redact(x.see), do: redact(x.do) }));
      if (s.open && /^https:\/\//.test(s.open.url)) row.open = { label: s.open.label, url: setupLink(s.open.url) };
      if (s.folds?.length) row.folds = s.folds.map((f) => ({ question: redact(f.question), say: f.say.map(redact) }));
      row.checkedOn = cr.CR_GUIDE.checkedOn;
      if (s.auto) row.auto = s.auto;
      if (s.finance) row.finance = s.finance;
      crRows.push(row);
    });
    if (part.id === "setup") {
      const p = cr.CR_PILOT;
      const connectN = part.steps.findIndex((s) => s.id === "connect") + 1;
      crRows.push({ id: p.id, n: connectN, part: "setup", partTitle: part.title, title: p.title, say: p.say.map(redact), checkedOn: cr.CR_GUIDE.checkedOn, auto: p.auto });
    }
  }
  out.contentrewards = crRows;
  return { steps: out, names: { ...Object.fromEntries(SETUP_ORDER.map((p) => [p, GUIDES[p].name])), contentrewards: cr.CR_GUIDE.name } };
}

function stepsText({ steps, names }) {
  return Object.entries(steps)
    .map(([platform, list]) => {
      const lines = [`### ${names[platform]} (Settings › Posting › Set up posting › ${names[platform]}, /settings/posting/setup/${platform})`];
      let part = "";
      for (const s of list) {
        if (s.partTitle !== part) {
          part = s.partTitle;
          lines.push(`Part: ${part}`);
        }
        lines.push(`${s.n === null ? "-" : `${s.n}.`} ${s.id} · ${s.title}${s.optional ? " (optional)" : ""}${s.auto ? ` (ticks itself: ${s.auto})` : ""}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/** Every place in Settings (web/src/lib/settingsTree.ts): tree › branch (route), then its apples with their leaf. */
export async function settingsPlaces() {
  const { TREES, settingsPath } = await import(pathToFileURL(join(web, "src/lib/settingsTree.ts")).href);
  const lines = [];
  const routes = ["/", "/jobs", "/review", "/library", "/settings", "/get-app", "/settings/clip-making/skills/new"];
  for (const tree of TREES) {
    routes.push(settingsPath(tree.slug));
    for (const branch of tree.branches) {
      const path = settingsPath(tree.slug, branch.slug);
      routes.push(path);
      lines.push(`Settings › ${tree.name} › ${branch.name} (${path}): ${branch.line}`);
      for (const apple of branch.apples) lines.push(`  - ${apple.name} (#${apple.id}): ${apple.leaf}`);
    }
  }
  return { text: lines.join("\n"), routes };
}

// ---------- C. the library ----------

const LIBRARY_DOCS = [
  ["CONTRACTS.md", "contracts", "§"],
  ["DECISIONS.md", "adr", "ADR"],
  ["ARCHITECTURE.md", "architecture", ""],
  ["DEPLOYMENT.md", "deployment", ""],
  ["SECURITY.md", "security", ""],
  ["TESTING.md", "testing", ""],
  ["UX_DESIGN_SYSTEM.md", "ux", ""],
  ["HELP_ASSISTANT.md", "help-assistant", ""],
  ["AGENT.md", "agent", ""],
  ["SETUP_POSTING.md", "setup-posting", ""],
  ["BUSINESS_REQUIREMENTS.md", "business", ""],
];

export function library() {
  const entries = [];
  for (const [file, prefix] of LIBRARY_DOCS) {
    const path = join(repo, "docs", file);
    if (!existsSync(path)) continue;
    const seen = new Set();
    for (const s of sections(read(path))) {
      if (!s.heading) continue;
      let id;
      const num = s.heading.match(/^(\d+)\./);
      const adr = s.heading.match(/^ADR-(\d+)/);
      if (prefix === "contracts" && num) id = `contracts-${num[1]}`;
      else if (prefix === "adr" && adr) id = `adr-${adr[1]}`;
      else id = `${prefix}-${slug(s.heading)}`;
      while (seen.has(id)) id += "-2";
      seen.add(id);
      const text = redact(s.text.trim()) + "\n";
      entries.push({ id, title: `${file.replace(/\.md$/, "")}: ${s.heading}`.slice(0, 160), line: redact(firstLine(s.text)), text });
    }
  }
  return entries;
}

// ---------- the pack ----------

export async function build() {
  const corpus = JSON.parse(read(CORPUS));
  const contracts = read(join(repo, "docs/CONTRACTS.md"));
  const map = appMap(corpus);
  const models = JSON.parse(read(join(repo, "config/models.json")));
  const platforms = JSON.parse(read(join(repo, "config/platforms.json")));
  const manual = [
    "## Setting up posting, per platform (docs/SETUP_POSTING.md)\n\n" + read(join(repo, "docs/SETUP_POSTING.md")).trim(),
    "## What Clip Factory does (docs/BUSINESS_REQUIREMENTS.md)\n\n" + businessParts(read(join(repo, "docs/BUSINESS_REQUIREMENTS.md"))),
    "## Platforms\n\n" + platformsText(platforms),
    "## AI models for clip jobs (Settings › Clip making › Clips › AI model)\n\n" + modelsText(models),
    "## Kid-proof words\n\n" + kidProof(contracts),
  ].join("\n\n");
  const setup = await setupSteps();
  const places = await settingsPlaces();
  const platformRoutes = Object.keys(setup.steps).map((p) => `/settings/posting/setup/${p}`);
  const parts = [
    { id: "app-map", title: "App map: every page, setting and guide", text: redact(map.text) },
    { id: "owner-manual", title: "Owner manual", text: redact(manual) },
    {
      id: "setup-steps",
      title: "Setup steps per platform (ids and titles, numbered as the guide shows them)",
      text: redact(stepsText(setup)),
    },
    { id: "settings-places", title: "Every place in Settings", text: redact(places.text) },
  ];
  const lib = library();
  const body = {
    parts,
    library: lib.map(({ id, title, line, text }) => ({ id, title, line, chars: text.length })),
    actions: map.actions,
    setupSteps: setup.steps,
    routes: [...new Set([...places.routes, ...platformRoutes])].sort(),
  };
  const hash = createHash("sha256");
  hash.update(JSON.stringify(body));
  for (const e of lib) hash.update(e.text);
  let version = hash.digest("hex").slice(0, 12);
  // Twelve digits in a row look like an AWS account id, so the server's redact() would hide the version.
  if (/^\d+$/.test(version)) version = `a${version.slice(1)}`;
  const pack = { version, ...body };
  return { pack, lib };
}

export function packTokens(pack) {
  return charsToTokens(pack.parts.reduce((n, p) => n + p.text.length, 0) + pack.library.reduce((n, e) => n + e.id.length + e.title.length + e.line.length + 6, 0));
}

async function main() {
  const check = process.argv.includes("--check");
  const { pack, lib } = await build();
  const tokens = packTokens(pack);
  if (tokens > MAX_TOKENS) {
    console.error(`ask knowledge is ${tokens} tokens, over the ${MAX_TOKENS} cap (docs/CONTRACTS.md §28.2)`);
    process.exit(1);
  }
  const json = JSON.stringify(pack, null, 1) + "\n";
  const wanted = new Map(lib.map((e) => [`${e.id}.md`, e.text]));
  if (check) {
    const stale = [];
    if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== json) stale.push("knowledge.json");
    const have = existsSync(LIBRARY) ? readdirSync(LIBRARY).filter((f) => f.endsWith(".md")) : [];
    for (const [name, text] of wanted) if (!existsSync(join(LIBRARY, name)) || readFileSync(join(LIBRARY, name), "utf8") !== text) stale.push(`library/${name}`);
    for (const name of have) if (!wanted.has(name)) stale.push(`library/${name} (extra)`);
    if (stale.length) {
      console.error(`Ask knowledge is stale (${stale.slice(0, 5).join(", ")}${stale.length > 5 ? ", …" : ""}). Run: node scripts/ask-knowledge.mjs`);
      process.exit(1);
    }
    console.log(`ask knowledge is up to date: version ${pack.version}, about ${tokens} tokens, ${lib.length} library sections`);
    return;
  }
  mkdirSync(LIBRARY, { recursive: true });
  for (const name of readdirSync(LIBRARY)) if (name.endsWith(".md") && !wanted.has(name)) rmSync(join(LIBRARY, name));
  for (const [name, text] of wanted) {
    const path = join(LIBRARY, name);
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
  }
  if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== json) writeFileSync(OUT, json);
  console.log(`ask knowledge: version ${pack.version}, about ${tokens} tokens, ${lib.length} library sections, ${pack.actions.length} buttons`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
