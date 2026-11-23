// Splits the Playwright tests over CI's browser shards by time (.github/workflows/ci.yml, web-e2e and web-e2e-webkit).
// Playwright's own --shard splits by count in file order, which put all of contrast.spec.ts in one shard; these lists
// are built from each test's saved time instead. Every shard but the last runs the tests named in its list
// (e2e/shards/<group>-<n>.txt). The last shard runs every other test of its projects (--test-list-invert over all the
// lists), so a new or renamed test always runs; it only lands in that shard until the lists are rebuilt.
//
//   node scripts/e2e-shards.mjs args <group> <shard> <total>   one CI shard's Playwright arguments, one per line
//   node scripts/e2e-shards.mjs check     every test of every project runs in exactly one shard (Playwright's own
//                                         --list per shard); web-checks runs it, so a list can never drop a test
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

/** One CI shard's arguments. The last shard's list of what to leave out is all the other lists together. */
export function shardArgs(group, shard, total, outDir) {
  const g = GROUPS[group];
  if (!g) fail(`unknown group "${group}" (one of: ${Object.keys(GROUPS).join(", ")})`);
  if (total !== g.shards) {
    fail(`ci.yml runs ${group} in ${total} shards but scripts/e2e-shards.mjs splits it into ${g.shards}: change both, then run build`);
  }
  if (!Number.isInteger(shard) || shard < 1 || shard > total) fail(`shard ${shard} is not between 1 and ${total}`);
  const numbers = listNumbers(group);
  const args = g.projects.map((p) => `--project=${p}`);
  if (shard < total) return [...args, `--test-list=${listFile(group, shard)}`];
  const rest = join(outDir, `${group}-rest.txt`);
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

async function check() {
  const all = await listTests([]);
  const grouped = Object.values(GROUPS).flatMap((g) => g.projects);
  const missing = all.projects.filter((p) => !grouped.includes(p));
  if (missing.length) fail(`playwright.config.ts has projects no CI shard runs: ${missing.join(", ")} (add them to GROUPS in scripts/e2e-shards.mjs)`);
  const times = readTimings();
  const estimate = estimator(times, all.tests);
  const out = mkdtempSync(join(tmpdir(), "e2e-shards-"));
  let bad = 0;
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
      // Playwright itself picks each shard's tests, with the exact arguments CI passes.
      const shards = Array.from({ length: g.shards }, (_, i) => i + 1);
      const picked = await pool(
        shards.map((n) => () => listTests(shardArgs(group, n, g.shards, out))),
        4,
      );
      const runs = new Map(tests.map((t) => [t.id, []]));
      picked.forEach(({ tests: chosen }, i) => {
        for (const t of chosen) {
          if (!runs.has(t.id)) {
            console.error(`::error::${group} shard ${i + 1} runs a test outside ${g.projects.join(", ")}: ${t.id}`);
            bad++;
          } else runs.get(t.id).push(i + 1);
        }
      });
      for (const [id, where] of runs) {
        if (where.length === 0) {
          console.error(`::error::no ${group} shard runs ${id}`);
          bad++;
        } else if (where.length > 1) {
          console.error(`::error::${id} runs in ${group} shards ${where.join(" and ")}: it is in more than one list`);
          bad++;
        }
      }
      for (const e of entries) {
        if (!tests.some((t) => matches(e, t))) console.log(`::warning::e2e/shards/${group}-${e.n}.txt names no test any more: ${e.line}`);
      }
      const secs = picked.map(({ tests: chosen }) => chosen.reduce((s, t) => s + estimate(t), 0));
      const mean = secs.reduce((a, b) => a + b, 0) / secs.length;
      secs.forEach((s, i) => {
        const what = i + 1 === g.shards ? " (the rest)" : "";
        console.log(`${group} ${i + 1}/${g.shards}${what}: ${picked[i].tests.length} tests, about ${(s / 60).toFixed(1)} worker-minutes`);
        if (s > mean * 1.3 && s - mean > 120) {
          console.log(`::warning::${group} shard ${i + 1} is ${Math.round((s / mean - 1) * 100)}% over the mean: run node scripts/e2e-shards.mjs build`);
        }
      });
      console.log(`${group}: all ${tests.length} tests run, each in exactly one of ${g.shards} shards.`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  if (bad) fail(`${bad} test(s) would run in no shard or in more than one: fix e2e/shards (node scripts/e2e-shards.mjs build)`);
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
  for (const [group, g] of Object.entries(GROUPS)) {
    const tests = all.tests.filter((t) => g.projects.includes(t.project));
    const total = tests.reduce((s, t) => s + estimate(t), 0);
    // A file whose tests take more than an eighth of a shard is split test by test; smaller files stay whole, so a
    // new test in them goes with the rest of its file.
    const cap = total / g.shards / 8;
    const files = new Map();
    for (const t of tests) {
      const k = `[${t.project}]${SEP}${t.file}`;
      files.set(k, [...(files.get(k) ?? []), t]);
    }
    const units = [];
    let leftover = 0;
    for (const [line, ts] of files) {
      const secs = ts.reduce((s, t) => s + estimate(t), 0);
      if (secs <= cap) units.push({ lines: [line], secs });
      else {
        for (const t of ts) {
          if (unlistable(t)) leftover += estimate(t);
          else units.push({ lines: [t.key], secs: estimate(t) });
        }
      }
    }
    // Longest first, each to the shard with the least so far; the last shard starts with what no line can name.
    units.sort((a, b) => b.secs - a.secs || (a.lines[0] < b.lines[0] ? -1 : 1));
    const bins = Array.from({ length: g.shards }, () => ({ lines: [], secs: 0 }));
    bins[g.shards - 1].secs = leftover;
    for (const u of units) {
      const bin = bins.reduce((best, b) => (b.secs < best.secs ? b : best));
      bin.lines.push(...u.lines);
      bin.secs += u.secs;
    }
    for (const f of readdirSync(DIR)) if (new RegExp(`^${group}-\\d+\\.txt$`).test(f)) rmSync(join(DIR, f));
    bins.slice(0, -1).forEach((b, i) => {
      const head = [
        `# ${group} shard ${i + 1} of ${g.shards}: about ${(b.secs / 60).toFixed(1)} worker-minutes (${b.lines.length} lines).`,
        "# Written by: node scripts/e2e-shards.mjs build (from timings.tsv). The last shard runs every test in no list.",
      ];
      writeFileSync(listFile(group, i + 1), [...head, ...b.lines.sort()].join("\n") + "\n");
    });
    const mins = bins.map((b) => (b.secs / 60).toFixed(1));
    console.log(`${group}: ${tests.length} tests, ${(total / 60).toFixed(1)} worker-minutes, shards [${mins.join(", ")}] (the last is the rest)`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "args") {
  const [group, shard, total] = rest;
  const out = process.env.RUNNER_TEMP || tmpdir();
  for (const a of shardArgs(group, Number(shard), Number(total), out)) console.log(a);
} else if (cmd === "check") {
  await check().catch((e) => fail(e.message));
} else if (cmd === "timings") {
  await timings(rest).catch((e) => fail(e.message));
} else if (cmd === "build") {
  await build().catch((e) => fail(e.message));
} else {
  fail("usage: node scripts/e2e-shards.mjs args <group> <shard> <total> | check | timings <log>... | build");
}
