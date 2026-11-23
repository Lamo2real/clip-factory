// Splits the Playwright tests over CI's browser shards by time (.github/workflows/ci.yml, web-e2e and web-e2e-webkit).
// Playwright's own --shard splits by count in file order, which put all of contrast.spec.ts in one shard; these lists
// are built from each test's saved time instead. Every shard but the last runs the tests named in its list
// (e2e/shards/<group>-<n>.txt). The last shard runs every other test of its projects (--test-list-invert over all the
// lists), so a new or renamed test always runs; it only lands in that shard until the lists are rebuilt.
//
// B3 (the owner, 23 Nov: "Yes, trim them"): a run is one of three modes (MODES), which ci.yml's changes job picks.
// A pull request leaves out the screenshots project and the @contrast-full part of contrast.spec.ts, which run every
// night; one that changes a style, token, glass or theme file also runs @contrast-full. Every mode uses the same lists.
//
//   node scripts/e2e-shards.mjs args <group> <shard> <total> [mode]   one CI shard's Playwright arguments, one per
//                                         line (mode: core, style or full; full when left out)
//   node scripts/e2e-shards.mjs check     in every mode, every test that mode runs is in exactly one shard
//                                         (Playwright's own --list per shard), the nightly (full) mode runs every
//                                         test, and ci.yml picks only these modes (full at night) and passes them to
//                                         every shard; web-checks runs it, so a list, a tag or ci.yml can never drop
//                                         a test
//   node scripts/e2e-shards.mjs timings <log>...   saves the times of CI job logs (`gh run view <id> --log`) in
//                                         e2e/shards/timings.tsv, keeping the saved time of a test the logs lack
//   node scripts/e2e-shards.mjs build     rebuilds the lists from e2e/shards/timings.tsv (run it when check warns
//                                         that a shard got slow, or after a big new spec)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const web = resolve(import.meta.dirname, "..");
const DIR = join(web, "e2e/shards");
const TIMINGS = join(DIR, "timings.tsv");
const CLI = join(web, "node_modules/@playwright/test/cli.js");
const SEP = " › ";

// The CI groups: each is one matrix job in ci.yml, run with these --project flags, in this many shards.
export const GROUPS = {
  chromium: { projects: ["chromium", "screenshots"], shards: 7 },
  webkit: { projects: ["webkit", "webkit-phone"], shards: 5 },
};

// What each mode leaves out: whole projects (skip), and the tests with this tag (drop, matched with --grep-invert).
//   full   the nightly run and a run by hand: every test.
//   style  a pull request that changes a style, token, glass or theme file: all but the screenshots (174 tests that
//          only take pictures; CI never keeps them).
//   core   every other pull request: also without @contrast-full. contrast.spec.ts's @contrast-core part still runs:
//          one width per breakpoint group (375 and 1440 px) in one background mode (the browser's own look, light).
export const MODES = {
  core: { skip: ["screenshots"], drop: "contrast-full", what: "every other pull request" },
  style: { skip: ["screenshots"], drop: null, what: "a pull request that changes a style file" },
  full: { skip: [], drop: null, what: "the nightly run and a run by hand" },
};
// The tags (JSON reports name them without the @) and the one file that may use them: each of its tests has one.
const CONTRAST = "contrast.spec.ts";
const CONTRAST_TAGS = ["contrast-core", "contrast-full"];

/** Whether a mode runs this test (a test from `listTests`). */
const runsIn = (mode, t) => !MODES[mode].skip.includes(t.project) && !(MODES[mode].drop && t.tags.includes(MODES[mode].drop));

/** The first mode that runs a test: core (every pull request), style (also style changes) or full (only at night). */
const firstMode = (t) => Object.keys(MODES).find((m) => runsIn(m, t));

const listFile = (group, n) => join(DIR, `${group}-${n}.txt`);

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

/** The list files of a group on disk must be exactly 1..shards-1: a list no shard runs would hide its tests. */
function listNumbers(group) {
  const re = new RegExp(`^${group}-(\\d+)\\.txt$`);
  const have = readdirSync(DIR)
    .map((f) => f.match(re)?.[1])
    .filter((n) => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  const want = Array.from({ length: GROUPS[group].shards - 1 }, (_, i) => i + 1);
  if (have.join(",") !== want.join(",")) {
    fail(
      `e2e/shards has ${group} lists [${have.join(", ")}] but ${group} runs ${GROUPS[group].shards} shards, so it needs ` +
        `lists [${want.join(", ")}] (the last shard runs the rest). Run: node scripts/e2e-shards.mjs build`,
    );
  }
  return want;
}

/** A list's entries: "[project] › file.spec.ts" (the whole file) or "[project] › file.spec.ts › title › ...". */
function readList(path) {
  const entries = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      const tokens = line.split("›").map((t) => t.trim());
      const project = tokens[0]?.match(/^\[([^\]]+)\]$/)?.[1];
      if (!project || !/\.spec\.ts$/.test(tokens[1] ?? "")) fail(`${path}:${i + 1}: not "[project] › file.spec.ts[ › title]": ${line}`);
      entries.push({ line, project, file: tokens[1], titles: tokens.slice(2) });
    });
  return entries;
}

/** One CI shard's arguments in a mode. The last shard's list of what to leave out is all the other lists together. */
export function shardArgs(group, shard, total, outDir, mode = "full") {
  const g = GROUPS[group];
  if (!g) fail(`unknown group "${group}" (one of: ${Object.keys(GROUPS).join(", ")})`);
  const m = MODES[mode];
  if (!m) fail(`unknown mode "${mode}" (one of: ${Object.keys(MODES).join(", ")})`);
  if (total !== g.shards) {
    fail(`ci.yml runs ${group} in ${total} shards but scripts/e2e-shards.mjs splits it into ${g.shards}: change both, then run build`);
  }
  if (!Number.isInteger(shard) || shard < 1 || shard > total) fail(`shard ${shard} is not between 1 and ${total}`);
  const numbers = listNumbers(group);
  const projects = g.projects.filter((p) => !m.skip.includes(p));
  if (!projects.length) fail(`the ${mode} mode leaves out every project of ${group}`);
  const args = [...projects.map((p) => `--project=${p}`), ...(m.drop ? [`--grep-invert=@${m.drop}`] : [])];
  if (shard < total) return [...args, `--test-list=${listFile(group, shard)}`];
  const rest = join(outDir, `${group}-${mode}-rest.txt`);
  writeFileSync(rest, numbers.map((n) => readFileSync(listFile(group, n), "utf8")).join("\n"));
  return [...args, `--test-list-invert=${rest}`];
}

/** Runs `playwright test --list --reporter=json` with extra arguments; returns its tests, one per project. */
function listTests(args) {
  return new Promise((ok, no) => {
    const child = spawn(process.execPath, [CLI, "test", "--list", "--reporter=json", ...args], {
      cwd: web,
      env: { ...process.env, CI: process.env.CI || "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      if (code !== 0) return no(new Error(`playwright test --list ${args.join(" ")} exited ${code}\n${err}${out.slice(0, 2000)}`));
      let report;
      try {
        report = JSON.parse(out);
      } catch {
        return no(new Error(`playwright test --list ${args.join(" ")} printed no JSON\n${err}${out.slice(0, 2000)}`));
      }
      if (report.errors?.length) return no(new Error(report.errors.map((e) => e.message).join("\n")));
      const tests = [];
      const walk = (suite, titles) => {
        for (const spec of suite.specs ?? []) {
          for (const t of spec.tests) {
            const all = [...titles, spec.title];
            tests.push({
              project: t.projectName,
              file: spec.file,
              titles: all,
              tags: spec.tags ?? [],
              key: `[${t.projectName}]${SEP}${spec.file}${SEP}${all.join(SEP)}`,
              id: `[${t.projectName}]${SEP}${spec.file}:${spec.line}:${spec.column}${SEP}${all.join(SEP)}`,
            });
          }
        }
        for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
      };
      for (const file of report.suites ?? []) walk(file, []);
      ok({ tests, projects: (report.config?.projects ?? []).map((p) => p.name) });
    });
  });
}

/** Runs the jobs with at most `n` at a time. */
async function pool(jobs, n) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await jobs[i]();
      }
    }),
  );
  return results;
}

function readTimings() {
  const times = new Map();
  if (!existsSync(TIMINGS)) return times;
  for (const line of readFileSync(TIMINGS, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    times.set(line.slice(tab + 1), Number(line.slice(0, tab)));
  }
  return times;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Seconds per test: its saved time, else its file's median, else its project's median, else 10 s. */
function estimator(times, tests) {
  const byFile = new Map();
  const byProject = new Map();
  for (const t of tests) {
    const s = times.get(t.key);
    if (s === undefined) continue;
    const f = `${t.project}|${t.file}`;
    byFile.set(f, [...(byFile.get(f) ?? []), s]);
    byProject.set(t.project, [...(byProject.get(t.project) ?? []), s]);
  }
  return (t) => {
    const saved = times.get(t.key);
    if (saved !== undefined) return saved;
    const f = byFile.get(`${t.project}|${t.file}`);
    if (f) return median(f);
    const p = byProject.get(t.project);
    return p ? median(p) : 10;
  };
}

/** Whether a list entry names this test (Playwright's rule: same project and file, and the titles start the same). */
const matches = (e, t) => e.project === t.project && e.file === t.file && e.titles.every((title, i) => t.titles[i] === title);

/** A test a list line cannot name on its own: Playwright splits the line at every › and trims each part. */
const unlistable = (t) => t.titles.some((s) => !s || s !== s.trim() || s.includes("›") || s.includes("\n"));

/** B3's tags: only contrast.spec.ts uses them, and each of its tests has exactly one; each has at least one test. */
function checkTags(tests) {
  let bad = 0;
  const count = Object.fromEntries(CONTRAST_TAGS.map((tag) => [tag, 0]));
  for (const t of tests) {
    const has = CONTRAST_TAGS.filter((tag) => t.tags.includes(tag));
    for (const tag of has) count[tag]++;
    if (t.file === CONTRAST && has.length !== 1) {
      console.error(`::error::${t.id} needs exactly one of @${CONTRAST_TAGS.join(" and @")} (it has ${has.length ? `@${has.join(", @")}` : "neither"})`);
      bad++;
    } else if (t.file !== CONTRAST && has.length) {
      console.error(`::error::${t.id} is tagged @${has.join(", @")}, which only ${CONTRAST} may use (pull requests would leave it out)`);
      bad++;
    }
  }
  for (const [tag, n] of Object.entries(count)) {
    if (!n) {
      console.error(`::error::no test in ${CONTRAST} is tagged @${tag}`);
      bad++;
    }
  }
  return bad;
}

/**
 * B3's other half is in ci.yml: its changes job picks the mode (e2e_mode) and each shard step passes it here. A mode
 * it names must be one of MODES, the nightly run and a run by hand must be full (or the tests only the nightly run has
 * would run nowhere), and every group's shard step must pass the mode on.
 */
function checkCi() {
  const CI = join(web, "../.github/workflows/ci.yml");
  if (!existsSync(CI)) {
    console.log(`::warning::${CI} is not here, so the modes it picks are not checked`);
    return 0;
  }
  const ci = readFileSync(CI, "utf8");
  const problems = [];
  const named = [...ci.matchAll(/\bsay e2e_mode (\w+)\b(?!")|\beverything "[^"]*" (\w+);/g)].map((m) => m[1] ?? m[2]);
  if (!named.length) problems.push("its changes job sets no e2e_mode");
  for (const m of new Set(named)) if (!MODES[m]) problems.push(`its changes job sets e2e_mode ${m}, which is not a mode here (${Object.keys(MODES).join(", ")})`);
  if (!/^\s*schedule \| workflow_dispatch\) everything "[^"]*" full;/m.test(ci)) problems.push("the nightly run and a run by hand (schedule | workflow_dispatch) must use the full mode");
  for (const group of Object.keys(GROUPS)) {
    const line = `node scripts/e2e-shards.mjs args ${group} "$SHARD" "$TOTAL" "$MODE"`;
    if (!ci.includes(line)) problems.push(`no shard step runs: ${line}`);
  }
  const passed = ci.match(/^\s*MODE: \$\{\{ needs\.changes\.outputs\.e2e_mode \}\}$/gm)?.length ?? 0;
  if (passed !== Object.keys(GROUPS).length) problems.push(`${passed} shard step(s) set MODE from needs.changes.outputs.e2e_mode; ${Object.keys(GROUPS).length} should`);
  for (const p of problems) console.error(`::error::.github/workflows/ci.yml: ${p}`);
  if (!problems.length) console.log(`ci.yml: the changes job picks only known modes (${[...new Set(named)].join(", ")}), the nightly run is full, and every shard step passes the mode.`);
  return problems.length;
}

async function check() {
  const all = await listTests([]);
  const grouped = Object.values(GROUPS).flatMap((g) => g.projects);
  const missing = all.projects.filter((p) => !grouped.includes(p));
  if (missing.length) fail(`playwright.config.ts has projects no CI shard runs: ${missing.join(", ")} (add them to GROUPS in scripts/e2e-shards.mjs)`);
  // The nightly run must be the one that runs everything, so no test is ever in no run at all.
  if (MODES.full.skip.length || MODES.full.drop) fail("the full mode (the nightly run) must leave nothing out");
  let bad = checkTags(all.tests) + checkCi();
  const times = readTimings();
  const estimate = estimator(times, all.tests);
  const out = mkdtempSync(join(tmpdir(), "e2e-shards-"));
  try {
    for (const [group, g] of Object.entries(GROUPS)) {
      const numbers = listNumbers(group);
      const tests = all.tests.filter((t) => g.projects.includes(t.project));
      const entries = numbers.flatMap((n) =>
        readList(listFile(group, n)).map((e) => {
          if (!g.projects.includes(e.project)) fail(`e2e/shards/${group}-${n}.txt names project ${e.project}, which ${group} does not run: ${e.line}`);
          return { ...e, n };
        }),
      );
      for (const e of entries) {
        if (!tests.some((t) => matches(e, t))) console.log(`::warning::e2e/shards/${group}-${e.n}.txt names no test any more: ${e.line}`);
      }
      // Playwright itself picks each shard's tests in each mode, with the exact arguments CI passes. Modes that give
      // a shard the same arguments are listed once.
      const shards = Array.from({ length: g.shards }, (_, i) => i + 1);
      const seen = new Map();
      const jobs = [];
      const picks = Object.keys(MODES).map((mode) =>
        shards.map((n) => {
          const args = shardArgs(group, n, g.shards, out, mode);
          const key = args.map((a) => a.replace(`-${mode}-rest.txt`, "-rest.txt")).join(" ");
          if (!seen.has(key)) {
            seen.set(key, jobs.length);
            jobs.push(() => listTests(args));
          }
          return seen.get(key);
        }),
      );
      const listed = await pool(jobs, 4);
      for (const [i, mode] of Object.keys(MODES).entries()) {
        const picked = picks[i].map((j) => listed[j]);
        const want = tests.filter((t) => runsIn(mode, t));
        const runs = new Map(want.map((t) => [t.id, []]));
        picked.forEach(({ tests: chosen }, s) => {
          for (const t of chosen) {
            if (!runs.has(t.id)) {
              console.error(`::error::${group} shard ${s + 1} runs a test the ${mode} mode leaves out (or one outside ${g.projects.join(", ")}): ${t.id}`);
              bad++;
            } else runs.get(t.id).push(s + 1);
          }
        });
        for (const [id, where] of runs) {
          if (where.length === 0) {
            console.error(`::error::no ${group} shard runs ${id} in the ${mode} mode (${MODES[mode].what})`);
            bad++;
          } else if (where.length > 1) {
            console.error(`::error::${id} runs in ${group} shards ${where.join(" and ")} in the ${mode} mode: it is in more than one list`);
            bad++;
          }
        }
        const secs = picked.map(({ tests: chosen }) => chosen.reduce((sum, t) => sum + estimate(t), 0));
        const mean = secs.reduce((a, b) => a + b, 0) / secs.length;
        secs.forEach((sec, s) => {
          const what = s + 1 === g.shards ? " (the rest)" : "";
          console.log(`${group} ${mode} ${s + 1}/${g.shards}${what}: ${picked[s].tests.length} tests, about ${(sec / 60).toFixed(1)} worker-minutes`);
          if (sec > mean * 1.3 && sec - mean > 120) {
            console.log(`::warning::${group} shard ${s + 1} is ${Math.round((sec / mean - 1) * 100)}% over the mean in the ${mode} mode: run node scripts/e2e-shards.mjs build`);
          }
        });
        const left = tests.length - want.length;
        const note = left ? `; it leaves out ${left} that a later mode runs` : "";
        console.log(`${group} ${mode} (${MODES[mode].what}): all ${want.length} of its tests run, each in exactly one of ${g.shards} shards${note}.`);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  if (bad) fail(`${bad} problem(s): a test would run in no shard or in more than one, or a B3 tag or ci.yml's mode is wrong (see above; lists: node scripts/e2e-shards.mjs build)`);
  console.log("Every test runs in the nightly (full) run; pull requests leave out only the screenshots and @contrast-full.");
}

async function timings(files) {
  if (!files.length) fail("usage: node scripts/e2e-shards.mjs timings <job log>...");
  // The list reporter's lines: "✓  12 [chromium] › e2e/a.spec.ts:3:5 › title › title (retry #1) (2.3s)"; skips have no time.
  const done = /[✓✘]\s+\d+ \[([\w-]+)\] › (?:e2e\/)?([\w./-]+\.spec\.ts):\d+:\d+ › (.*?)(?: \(retry #\d+\))? \((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/;
  const skipped = /\s-\s+\d+ \[([\w-]+)\] › (?:e2e\/)?([\w./-]+\.spec\.ts):\d+:\d+ › (.*?)\s*$/;
  const seen = new Map();
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      let m = line.match(done);
      let s;
      if (m) {
        const v = Number(m[4]);
        s = m[5] === "ms" ? v / 1000 : m[5] === "m" ? v * 60 : v;
      } else if ((m = line.match(skipped))) s = 0.2;
      else continue;
      const key = `[${m[1]}]${SEP}${m[2]}${SEP}${m[3]}`;
      seen.set(key, [...(seen.get(key) ?? []), s]);
    }
  }
  if (!seen.size) fail("no Playwright test lines in those logs");
  const times = readTimings();
  for (const [key, xs] of seen) times.set(key, Math.round(median(xs) * 10) / 10);
  // Only tests that still exist are kept, so the file never grows with deleted or renamed ones.
  const now = new Set((await listTests([])).tests.map((t) => t.key));
  for (const key of times.keys()) if (!now.has(key)) times.delete(key);
  const lines = [...times].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, s]) => `${s}\t${k}`);
  const head = "# Seconds per test (median of the CI logs given), written by: node scripts/e2e-shards.mjs timings <log>...";
  writeFileSync(TIMINGS, `${head}\n${lines.join("\n")}\n`);
  console.log(`e2e/shards/timings.tsv: ${seen.size} tests from ${files.length} log(s), ${times.size} saved in all`);
}

async function build() {
  const all = await listTests([]);
  const times = readTimings();
  const estimate = estimator(times, all.tests);
  const modes = Object.keys(MODES);
  for (const [group, g] of Object.entries(GROUPS)) {
    const tests = all.tests.filter((t) => g.projects.includes(t.project));
    const total = tests.reduce((s, t) => s + estimate(t), 0);
    // A file whose tests take more than an eighth of a shard, or whose tests run in different modes, is split test by
    // test; other files stay whole, so a new test in them goes with the rest of its file.
    const cap = total / g.shards / 8;
    const files = new Map();
    for (const t of tests) {
      const k = `[${t.project}]${SEP}${t.file}`;
      files.set(k, [...(files.get(k) ?? []), t]);
    }
    const units = [];
    const leftover = Object.fromEntries(modes.map((m) => [m, 0]));
    for (const [line, ts] of files) {
      const secs = ts.reduce((s, t) => s + estimate(t), 0);
      const kinds = new Set(ts.map(firstMode));
      if (secs <= cap && kinds.size === 1) units.push({ lines: [line], secs, mode: firstMode(ts[0]) });
      else {
        for (const t of ts) {
          if (unlistable(t)) leftover[firstMode(t)] += estimate(t);
          else units.push({ lines: [t.key], secs: estimate(t), mode: firstMode(t) });
        }
      }
    }
    // Longest first, each to the shard with the least so far, one mode at a time (core, then what style adds, then
    // what full adds), so the shards stay even in every mode. The last shard starts with what no line can name.
    const bins = Array.from({ length: g.shards }, () => ({ lines: [], by: Object.fromEntries(modes.map((m) => [m, 0])), secs: 0 }));
    const last = bins[g.shards - 1];
    for (const m of modes) {
      last.by[m] += leftover[m];
      last.secs += leftover[m];
    }
    for (const m of modes) {
      const mine = units.filter((u) => u.mode === m).sort((a, b) => b.secs - a.secs || (a.lines[0] < b.lines[0] ? -1 : 1));
      for (const u of mine) {
        const bin = bins.reduce((best, b) => (b.by[m] < best.by[m] || (b.by[m] === best.by[m] && b.secs < best.secs) ? b : best));
        bin.lines.push(...u.lines);
        bin.by[m] += u.secs;
        bin.secs += u.secs;
      }
    }
    // Worker-minutes of a shard in a mode: what it runs is its own mode's tests and those of every mode before it.
    const inMode = (b, m) => modes.slice(0, modes.indexOf(m) + 1).reduce((s, x) => s + b.by[x], 0) / 60;
    for (const f of readdirSync(DIR)) if (new RegExp(`^${group}-\\d+\\.txt$`).test(f)) rmSync(join(DIR, f));
    bins.slice(0, -1).forEach((b, i) => {
      const per = modes.map((m) => `${inMode(b, m).toFixed(1)} ${m}`).join(", ");
      const head = [
        `# ${group} shard ${i + 1} of ${g.shards}: about ${per} worker-minutes (${b.lines.length} lines).`,
        "# Written by: node scripts/e2e-shards.mjs build (from timings.tsv). The last shard runs every test in no list.",
      ];
      writeFileSync(listFile(group, i + 1), [...head, ...b.lines.sort()].join("\n") + "\n");
    });
    for (const m of modes) {
      const mins = bins.map((b) => inMode(b, m).toFixed(1));
      const n = tests.filter((t) => runsIn(m, t)).length;
      console.log(`${group} ${m}: ${n} tests, shards [${mins.join(", ")}] worker-minutes (the last is the rest)`);
    }
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "args") {
  const [group, shard, total, mode = "full"] = rest;
  const out = process.env.RUNNER_TEMP || tmpdir();
  for (const a of shardArgs(group, Number(shard), Number(total), out, mode)) console.log(a);
  const m = MODES[mode];
  const left = [...m.skip.map((p) => `the ${p} project`), ...(m.drop ? [`the @${m.drop} tests`] : [])];
  console.error(`${mode} run (${m.what}): ${left.length ? `leaves out ${left.join(" and ")}; the nightly run has them` : "every test"}`);
} else if (cmd === "check") {
  await check().catch((e) => fail(e.message));
} else if (cmd === "timings") {
  await timings(rest).catch((e) => fail(e.message));
} else if (cmd === "build") {
  await build().catch((e) => fail(e.message));
} else {
  fail("usage: node scripts/e2e-shards.mjs args <group> <shard> <total> [core|style|full] | check | timings <log>... | build");
}
