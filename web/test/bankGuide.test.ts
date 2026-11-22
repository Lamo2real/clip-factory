// Your bank's steps and words (docs/CONTRACTS.md §40.5.2, §40.5.13 web): the step ids, roles and autos are the
// server's (bank_steps.json when BA's file is there); every card is kid-proof (≤ 6-word titles, ≤ 26-word lines, at
// most 4 lines a card); the Opens are https (the one mailto: aside); bold is only Enable Banking's own labels; "API"
// only inside **API applications**; the check's and the results' sentences word for word; the app ID found inside a
// pasted message; the email link; the picker's order and search; and the never-words.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BANK_GUIDE,
  BANK_KEEPS,
  BANK_NEVER,
  BANK_STATUS_ICON,
  CHECK_TEXT,
  DONE_NOT,
  DONE_OK,
  ENABLE_BANKING_LABELS,
  PICKER_LEAD,
  PICKER_NEW,
  RESULT_TEXT,
  SWEDEN_FIRST,
  bankError,
  bankStepNumber,
  copyValue,
  countryName,
  filterBanks,
  findAppId,
  firstLine,
  mailtoOf,
  mainLabel,
  numberedBankSteps,
  resultSentence,
  sortBanks,
  tryAgainAt,
  type BankStep,
} from "../src/getpaid/bank.ts";
import { BANK_SCENARIOS, bankScenario, bankViewOf } from "../src/api/mock/bank.ts";

const REPO = join(import.meta.dirname, "..", "..");
const STEPS_FILE = join(REPO, "api", "tests", "fixtures", "bank_steps.json");
const words = (t: string) => t.trim().split(/\s+/).length;
const bolds = (t: string) => [...t.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1]!);
/** Our own words: Enable Banking's **bold** labels taken out. */
const ours = (t: string) => t.replace(/\*\*[^*]+\*\*/g, "");
const texts = (s: BankStep) => [s.title, ...s.say, s.lead ?? "", ...(s.ifYouSee ?? []).flatMap((h) => [h.see, h.do]), ...(s.copy ?? []).map((c) => c.label)];

describe("the steps (§40.5.2)", () => {
  it("have the contract's ids, roles and autos, in order", () => {
    expect(BANK_GUIDE.steps.map((s) => `${s.id}:${s.role}`)).toEqual([
      "bank-ask:optional",
      "bank-account:numbered",
      "bank-key:numbered",
      "bank-app:numbered",
      "bank-details:numbered",
      "bank-appid:numbered",
      "bank-link:numbered",
      "bank-connect:numbered",
    ]);
    expect(numberedBankSteps()).toHaveLength(7);
    expect(bankStepNumber("bank-ask")).toBeNull();
    expect(bankStepNumber("bank-connect")).toBe(7);
    // His green answer is the normal way for 1, 3 and 4 (they also tick themselves); 2, 5, 6 and 7 tick themselves.
    const manual = (id: string) => BANK_GUIDE.steps.find((s) => s.id === id)!.manual !== false;
    expect(BANK_GUIDE.steps.filter((s) => manual(s.id)).map((s) => s.id)).toEqual(["bank-ask", "bank-account", "bank-app", "bank-details"]);
    expect(BANK_GUIDE.steps.filter((s) => s.auto).map((s) => s.id)).toEqual(["bank-account", "bank-key", "bank-app", "bank-details", "bank-appid", "bank-link", "bank-connect"]);
    const done = Object.fromEntries(BANK_GUIDE.steps.map((s) => [s.id, s.doneLabel ?? null]));
    expect(done).toMatchObject({ "bank-ask": "I asked", "bank-account": "I'm in", "bank-app": "I did this", "bank-details": "I did this", "bank-link": "I linked them" });
    expect(BANK_GUIDE.steps.map((s) => s.action ?? null)).toEqual([null, null, "make_bank_key", null, null, "save_app_id", null, "connect_bank"]);
  });

  it.skipIf(!existsSync(STEPS_FILE))("equal the server's STEPS (api/tests/fixtures/bank_steps.json)", () => {
    const raw = JSON.parse(readFileSync(STEPS_FILE, "utf8")) as unknown;
    const body = raw && typeof raw === "object" && "steps" in (raw as object) ? (raw as { steps: unknown }).steps : raw;
    const list: { id: string; role?: string; auto?: unknown; manual?: unknown }[] = Array.isArray(body)
      ? (body as { id: string }[])
      : Object.entries(body as Record<string, unknown>).map(([id, v]) => ({ id, ...(v && typeof v === "object" ? (v as object) : { role: v }) }));
    expect(list.map((s) => s.id)).toEqual(BANK_GUIDE.steps.map((s) => s.id));
    for (const s of list) {
      const mine = BANK_GUIDE.steps.find((x) => x.id === s.id)!;
      if (typeof s.role === "string" && ["optional", "numbered"].includes(s.role)) expect(s.role, s.id).toBe(mine.role);
      if (typeof s.manual === "boolean") expect(s.manual, s.id).toBe(mine.manual !== false);
      if (typeof s.auto === "boolean") expect(s.auto, s.id).toBe(!!mine.auto);
    }
  });

  it("are kid-proof: titles of 6 words or fewer, lines of 26 or fewer, at most 4 lines a card", () => {
    for (const s of BANK_GUIDE.steps) {
      expect(words(s.title), s.title).toBeLessThanOrEqual(6);
      expect(s.say.length, s.id).toBeGreaterThanOrEqual(1);
      expect(s.say.length, s.id).toBeLessThanOrEqual(4);
      for (const t of [...s.say, s.lead ?? "", ...(s.ifYouSee ?? []).map((h) => h.do)].filter(Boolean)) expect(words(t), t).toBeLessThanOrEqual(26);
    }
  });

  it("open https pages only, the email's mailto: aside", () => {
    for (const s of BANK_GUIDE.steps) {
      if (!s.open) continue;
      if (s.mail) expect(s.open.url, s.id).toBe("mailto:");
      else expect(s.open.url, s.id).toMatch(/^https:\/\/enablebanking\.com\//);
    }
    expect(BANK_GUIDE.steps.filter((s) => s.mail).map((s) => s.id)).toEqual(["bank-ask"]);
    expect(BANK_GUIDE.steps.find((s) => s.id === "bank-account")!.open).toEqual({ label: "Open Enable Banking", url: "https://enablebanking.com/sign-in/" });
    for (const id of ["bank-app", "bank-link"]) expect(BANK_GUIDE.steps.find((s) => s.id === id)!.open).toEqual({ label: "Open your Enable Banking apps", url: "https://enablebanking.com/cp/applications" });
    // Step 4 has no Open (the page is already open), so it is never the vermilion.
    expect(BANK_GUIDE.steps.find((s) => s.id === "bank-details")!.open).toBeUndefined();
  });

  it("bold only Enable Banking's own labels; API and ASPSP only inside them; never the screen's banned words", () => {
    for (const s of BANK_GUIDE.steps)
      for (const t of texts(s)) {
        for (const b of bolds(t)) expect(ENABLE_BANKING_LABELS as readonly string[], `${s.id}: ${b}`).toContain(b);
        expect(ours(t), t).not.toMatch(/\bAPI\b|\bASPSP\b/);
        expect(BANK_NEVER.test(ours(t).replace(/\.pem\b/g, "")), t).toBe(false);
      }
    // "bank key", never certificate (except Enable Banking's own two labels) or RSA, JWT or PEM.
    const all = BANK_GUIDE.steps.flatMap(texts).join(" ");
    expect(ours(all).replace(/\.pem\b/g, "")).not.toMatch(/certificate|\bRSA\b|\bJWT\b|\bPEM\b|consent|session|PSD2|AISP|token/i);
    expect(all).toContain("**Public certificate in PEM format**");
    expect(all).toContain("**Generate outside the browser and import public certificate**");
    expect(BANK_GUIDE.steps.find((s) => s.id === "bank-app")!.copy).toEqual([{ label: "Bank key", from: "publicKeyPem", short: true }]);
    expect(BANK_GUIDE.steps.find((s) => s.id === "bank-app")!.ifYouSee!.at(-1)!.copy).toEqual({ label: "Other bank key", from: "certificatePem", short: true });
    // Step 6 says "Don't tap it" next to Share, Request activation and Request unrestriction.
    const link = BANK_GUIDE.steps.find((s) => s.id === "bank-link")!;
    for (const see of ["**Share**", "**Request activation** or **Request unrestriction**"]) expect(link.ifYouSee!.find((h) => h.see === see)!.do).toMatch(/^Don't tap it\./);
  });

  it("the main action's words are next.label's (§40.5.9)", () => {
    const by = (id: string) => BANK_GUIDE.steps.find((s) => s.id === id)!;
    expect(mainLabel(by("bank-account"), false)).toBe("Open Enable Banking");
    expect(mainLabel(by("bank-key"), false)).toBe("Make my bank key");
    expect(mainLabel(by("bank-app"), false)).toBe("Open your Enable Banking apps");
    expect(mainLabel(by("bank-details"), false)).toBeNull();
    expect(mainLabel(by("bank-appid"), false)).toBe("Save");
    expect(mainLabel(by("bank-appid"), true)).toBe("Check again");
    expect(mainLabel(by("bank-link"), false)).toBe("Open your Enable Banking apps");
    expect(mainLabel(by("bank-connect"), false)).toBe("Connect your bank");
    expect(mainLabel(by("bank-ask"), false)).toBeNull();
  });
});

describe("the app ID, the email, the country (§40.5.2)", () => {
  it("keeps the first 8-4-4-4-12 match found anywhere in the paste, and only it", () => {
    const msg = "New application Clip Factory with id 0F8C2A4E-9B1D-4C6E-8A3F-5D7B9E1C2A40 has been added. Also 11111111-2222-3333-4444-555555555555.";
    expect(findAppId(msg)).toBe("0f8c2a4e-9b1d-4c6e-8a3f-5d7b9e1c2a40");
    expect(findAppId("0f8c2a4e9b1d4c6e8a3f5d7b9e1c2a40")).toBeNull();
    expect(findAppId("hello")).toBeNull();
  });

  it("builds the email's mailto: from values.ask, each part percent-encoded", () => {
    const v = bankViewOf(bankScenario("fresh"), { country: "SE", crOn: true });
    const url = mailtoOf(v.values.ask);
    expect(url.startsWith("mailto:support.api@enablebanking.com?subject=")).toBe(true);
    const q = new URLSearchParams(url.split("?")[1]);
    expect(q.get("subject")).toBe("Personal use: my own creator income on my own account");
    expect(q.get("body")).toBe(v.values.ask.body);
    expect(url).not.toMatch(/[ \n]/);
    expect(v.values.ask.body).toContain("I'm a private person in Sweden.");
    expect(copyValue("askTo", v)).toBe("support.api@enablebanking.com");
  });

  it("shows a long value's first line and …", () => {
    expect(firstLine("-----BEGIN PUBLIC KEY-----\nMIIC\n-----END PUBLIC KEY-----")).toBe("-----BEGIN PUBLIC KEY----- …");
    expect(firstLine("Clip Factory")).toBe("Clip Factory");
  });

  it("names his Money country in English, else your country", () => {
    expect(countryName("SE")).toBe("Sweden");
    expect(countryName(null)).toBe("your country");
    expect(countryName("ZZ")).toBe("your country");
  });
});

describe("the picker (§40.5.2 Connect)", () => {
  it("puts Sweden's most used banks first, in order, then A to Z; typing only filters", () => {
    const banks = ["Ålandsbanken", "Wise", "Nordea", "Avanza", "Swedbank", "SEB", "PayPal", "Handelsbanken", "Marginalen Bank"].map((name) => ({ name }));
    expect(sortBanks(banks).map((b) => b.name)).toEqual(["Swedbank", "Handelsbanken", "SEB", "Nordea", "PayPal", "Wise", "Avanza", "Marginalen Bank", "Ålandsbanken"]);
    expect(SWEDEN_FIRST.slice(0, 4)).toEqual(["Swedbank", "Handelsbanken", "SEB", "Nordea"]);
    expect(filterBanks(sortBanks(banks), "han").map((b) => b.name)).toEqual(["Handelsbanken"]);
    expect(filterBanks(banks, "alands").map((b) => b.name)).toEqual(["Ålandsbanken"]);
    expect(filterBanks(banks, "")).toHaveLength(banks.length);
    expect(PICKER_LEAD).toBe("Pick a bank you linked on Enable Banking.");
    expect(PICKER_NEW).toBe("New bank? Link it on Enable Banking first: tap **Link accounts**, then come back.");
  });
});

describe("the sentences, word for word (§40.5.4, §40.5.5)", () => {
  it("the check's", () => {
    expect(CHECK_TEXT).toEqual({
      ok: "Enable Banking knows Clip Factory, and your app is active.",
      not_active: "Saved. Next: link your bank accounts (step 6).",
      redirect_missing: "Paste the return address in **Allowed redirect URLs (one per line)**. On your app tap ⋮, then **Edit**, then **Save**.",
      sandbox: "That's a Sandbox app. Do steps 3 and 4 again, and tap **Production** first. Then paste the new app ID here.",
      key_wrong: "Enable Banking doesn't know this key. Do steps 3 and 4 again to make a new app. Then paste its app ID here.",
      not_found: "Enable Banking doesn't know that app ID. Copy it again.",
      down: "Enable Banking didn't answer. Try again in a few minutes.",
    });
  });

  it("the results', with Reconnect Swedbank for a reconnect and your bank without a lastConnect", () => {
    expect(resultSentence("bank_connected", "Swedbank")).toBe("Clip Factory can see money coming into Swedbank now. It looks once a day.");
    expect(resultSentence("bank_denied", "Swedbank", true)).toBe("You stopped at the bank. Tap Reconnect Swedbank to try again.");
    expect(resultSentence("bank_denied")).toBe("You stopped at the bank. Tap Connect your bank to try again.");
    expect(resultSentence("bank_no_accounts", "SEB")).toBe("Enable Banking didn't share an account. Link it on Enable Banking first (step 6). Then tap Connect your bank again.");
    expect(resultSentence("bank_business_only")).toBe(
      "That bank only shared a business account. Clip Factory reads private accounts only. Pick your private account at your bank, then tap Connect your bank again.",
    );
    expect(resultSentence("bank_expired", "Nordea", true)).toBe("That took too long. Tap Reconnect Nordea again.");
    expect(resultSentence("bank_key_wrong")).toBe("Enable Banking didn't know your bank key. Tap Check again in step 5.");
    expect(resultSentence("bank_error")).toBe("Something went wrong. Tap Connect your bank again in a few minutes.");
    expect(Object.keys(RESULT_TEXT)).toHaveLength(7);
    expect(DONE_OK).toBe("Done! Go back to Clip Factory. You can close this tab.");
    expect(DONE_NOT).toBe("Your bank didn't connect. Go back to Clip Factory to see what to do.");
  });

  it("What Clip Factory keeps, fixed", () => {
    expect(BANK_KEEPS).toEqual([
      "Only money from apps: the day, the amount and which app.",
      "Payments it asks you about stay until you answer, at most 180 days.",
      "Never your account number, your name or any other payment.",
      "Your bank and PayPal logins stay with them. Clip Factory never sees them.",
      "Enable Banking forgets your bank's answer within a minute.",
      "Forget my bank removes every payment and bank link Clip Factory kept.",
    ]);
  });

  it("keeps the bank routes' own codes and retryAt, and says the time as Try again at 14:15.", () => {
    const e = bankError(429, { error: { code: "rate_limited", message: "Clip Factory checked a moment ago.", retryAt: "2026-11-22T13:15:00.000Z" } });
    expect(e.status).toBe(429);
    expect(e.bankCode).toBe("rate_limited");
    expect(e.message).toBe("Clip Factory checked a moment ago.");
    expect(tryAgainAt(e.retryAt)).toMatch(/^Try again at \d{2}:\d{2}\.$/);
    expect(bankError(409, { error: { code: "no_country", message: "Pick your country in Money settings first." } }).bankCode).toBe("no_country");
    expect(tryAgainAt(undefined)).toBe("");
  });
});

describe("the statuses' words (§40.5.9), as the pretend server makes them", () => {
  it("every status has words, a tone and an icon; none says Live, Connected, Not connected or disconnected", () => {
    const seen = new Set<string>();
    for (const name of BANK_SCENARIOS.filter((n) => n !== "off")) {
      const v = bankViewOf(bankScenario(name), { country: "SE", crOn: true });
      seen.add(v.status);
      expect(BANK_STATUS_ICON[v.status], name).toBeTruthy();
      for (const t of [v.pill, v.line, ...v.links.flatMap((l) => [l.pill, l.line])]) expect(/\b(Live|Connected|Not connected|disconnected)\b/i.test(t), `${name}: ${t}`).toBe(false);
    }
    expect([...seen].sort()).toEqual(["can_see", "cant_read", "ended", "ending_soon", "look_in_bank", "not_started", "setting_up", "stopped_at_bank"]);
    expect(Object.keys(BANK_STATUS_ICON).sort()).toEqual(["can_see", "cant_read", "checking", "ended", "ending_soon", "look_in_bank", "not_started", "setting_up", "stopped", "stopped_at_bank"]);
  });

  it("the pretend first read: Swedbank, 143 of 180 days, four rows (two of them questions)", () => {
    const v = bankViewOf(bankScenario("connected"), { country: "SE", crOn: true });
    expect(v.links).toHaveLength(1);
    expect([v.links[0]!.bank, v.links[0]!.daysLeft, v.links[0]!.totalDays]).toEqual(["Swedbank", 143, 180]);
    expect(v.rows.map((r) => [r.place, r.how])).toEqual([
      ["youtube", "payout"],
      ["meta", "payer"],
    ]);
    // The same day as the pretend YouTube page's Google payment (SEK 1,234.56 on 23 Oct), so its pair line shows.
    expect(v.rows[0]!.howText).toBe("matches Google's payment of 23 Oct");
    expect(v.pairs).toEqual([{ place: "youtube", payoutDate: "2026-10-23", amountMicros: 1_234_560_000, currency: "SEK", reachedOn: "2026-10-28" }]);
    expect(v.asks.map((a) => [a.suggested, a.title, a.yesLabel])).toEqual([
      ["x", "Is this money from X?", "Yes, it's X"],
      ["youtube", "Is this money from YouTube?", "Yes, it's YouTube"],
    ]);
    expect(v.reached.totals).toEqual([{ currency: "SEK", amountMicros: 2_146_960_000 }]);
    expect(v.reached.notYet).toBe("No money from TikTok, X or Content Rewards reached your bank yet.");
    expect(v.fold).toBe("Set up ✓ (Enable Banking knows your app)");
    expect(v.next).toBeNull();
    const ending = bankViewOf(bankScenario("ending"), { country: "SE", crOn: true });
    expect(ending.next).toMatchObject({ stepId: null, label: "Reconnect Swedbank", vermilion: true });
    expect(ending.pill).toBe("Link ends in 9 days");
    expect(bankViewOf(bankScenario("days90"), { country: "SE", crOn: true }).links[0]!.totalDays).toBe(90);
  });

  it("says nothing untrue: a stopped link was last read before it stopped; a first connect has no payer he named yet", () => {
    const stopped = bankViewOf(bankScenario("stopped_at_bank"), { country: "SE", crOn: true });
    expect(Date.parse(stopped.links[0]!.checkedAt!)).toBeLessThan(Date.now() - 86_400_000);
    // A question brought back (Not from YouTube?) has no hint any more: the server's words, never "names no app".
    const s = bankScenario("connected");
    Object.assign(s.deposits[0]!, { state: "needs_you", place: undefined, how: undefined, suggested: null, hint: undefined, kind: "place" });
    const back = bankViewOf(s, { country: "SE", crOn: true }).asks.find((a) => a.depositId === s.deposits[0]!.depositId)!;
    expect([back.title, back.line]).toEqual(["Where is this money from?", "Pick where this money is from."]);
  });
});

describe("BA's server view, read from its golden cases (api/tests/fixtures/bank_view_cases.json)", () => {
  const CASES = join(REPO, "api", "tests", "fixtures", "bank_view_cases.json");
  type Golden = { name: string; crOn: boolean; expect: { places?: Record<string, unknown>; asks?: { title: string; line: string }[] } };
  const all = (): Golden[] => Object.values(JSON.parse(readFileSync(CASES, "utf8")) as Record<string, Golden[]>).flat();

  it.skipIf(!existsSync(CASES))("names Content Rewards in places exactly while it is on (the sheet's row follows it)", () => {
    const cases = all().filter((c) => c.expect.places);
    expect(cases.length).toBeGreaterThan(3);
    expect(cases.some((c) => c.crOn)).toBe(true);
    for (const c of cases) expect("contentrewards" in c.expect.places!, c.name).toBe(c.crOn);
  });

  it.skipIf(!existsSync(CASES))("a question with no suggestion and no hint says Pick where this money is from., as the pretend server does", () => {
    const lines = all().flatMap((c) => (c.expect.asks ?? []).filter((a) => a.title === "Where is this money from?").map((a) => a.line));
    expect(lines).toContain("Pick where this money is from.");
    expect(lines.join(" ")).not.toContain("names no app");
  });
});
