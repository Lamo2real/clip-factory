// Your bank's steps and words (docs/CONTRACTS.md §40.5.2): plain data like the Get paid guides (§40.1), checked against
// Enable Banking's Control Panel on 22 Nov 2026. Bold is Enable Banking's own label, word for word. The screens draw
// it, the tests check it; the server's bank/__init__.py STEPS has the same ids, roles and autos. Only small pure
// helpers live here (finding the app ID in a paste, the email link, the picker's order, the fixed sentences).
import { ApiError, errorFromResponse } from "../api/errors.ts";
import type { BankAppCode, BankPlace, BankResult, BankStatus, BankStepId, BankView } from "../api/types.ts";
import type { IconName } from "../components/Icon.tsx";
import type { GetPaidStep } from "./types.ts";

export const BANK_PATH = "/settings/posting/getpaid/bank";
export const BANK_DONE_PATH = "/bank-done";
/** "22 Nov 2026" */
export const BANK_CHECKED = "22 Nov 2026";
export const BANK_TIME = "About 25 minutes · Free";
export const BANK_NAME = "Your bank";

export type BankAction = "make_bank_key" | "save_app_id" | "check_app" | "connect_bank";
/** The server's STEPS role: the optional email first, then the seven the ring counts. */
export type BankRole = "optional" | "numbered";
/** Where a Copy chip's words come from: fixed words, or one of the server's `values` / the key's two parts. */
export type BankCopyFrom = keyof Omit<BankView["values"], "ask"> | "askTo" | "askBody" | "publicKeyPem" | "certificatePem";

export interface BankCopy {
  /** Enable Banking's own label in bold, or Clip Factory's own words ("Bank key"). */
  label: string;
  from: BankCopyFrom;
  /** The chip shows only the first line and "…", and copies the whole thing (the bank key, the email). */
  short?: boolean;
}

/** One Your bank step card: §40.1's GetPaidStep shape, plus a paste box, an upload box and Clip Factory's own actions. */
export interface BankStep extends Omit<GetPaidStep, "id" | "role" | "action" | "auto" | "copy" | "ifYouSee" | "paid" | "phone" | "shared"> {
  id: BankStepId;
  role: BankRole;
  /** Ticks itself (the server's steps[].by "auto"); the words are the server's `auto`. */
  auto?: boolean;
  /** The step's main button is Clip Factory's own (Make my bank key, Save, Connect your bank), not an Open. */
  action?: BankAction;
  copy?: BankCopy[];
  /** "If you see X, do Y"; a hint may carry a Copy chip of its own ("Other bank key"). */
  ifYouSee?: { see: string; do: string; copy?: BankCopy }[];
  /** Step 5's paste box: its label. */
  paste?: { label: string };
  /** Step 5's .pem path, folded under it. */
  upload?: { fold: string; better: string; label: string; cantPick: string; pasteLabel: string };
  /** "Enable Banking may show this a little differently. Look for the same words." */
  unseen?: boolean;
  /** The Open is a mailto: address built from `values.ask` (the one Open that isn't https). */
  mail?: boolean;
}

export interface BankGuide {
  name: "Your bank";
  checkedOn: "2026-11-22";
  minutes: 25;
  cost: "Free";
  steps: BankStep[];
}

const CP = "https://enablebanking.com/cp/applications";
export const OPEN_APPS = { label: "Open your Enable Banking apps", url: CP } as const;
export const UNSEEN = "Enable Banking may show this a little differently. Look for the same words.";
export const GENERATE_OUTSIDE = "**Generate outside the browser and import public certificate**";

export const BANK_GUIDE: BankGuide = {
  name: "Your bank",
  checkedOn: "2026-11-22",
  minutes: 25,
  cost: "Free",
  steps: [
    {
      id: "bank-ask",
      role: "optional",
      icon: "comment",
      title: "Ask Enable Banking first",
      doneLabel: "I asked",
      lead: "Enable Banking is free for your own private use. Ask them if your app money counts. It's your choice.",
      open: { label: "Open email", url: "mailto:" },
      mail: true,
      say: ["Tap Open email, then Send. Then come back and tap I asked."],
      copy: [
        { label: "Their email", from: "askTo" },
        { label: "The email", from: "askBody", short: true },
      ],
      ifYouSee: [
        { see: "a yes from them", do: "Great. Do step 1." },
        { see: "a no from them", do: "Don't do the next steps. Your bank's app still shows what arrived. If you did them already, tap Forget my bank at the bottom." },
        { see: "no answer", do: "It's your choice. You can wait, or go on." },
      ],
    },
    {
      id: "bank-account",
      role: "numbered",
      icon: "user",
      title: "Make an Enable Banking account",
      doneLabel: "I'm in",
      auto: true,
      unseen: true,
      open: { label: "Open Enable Banking", url: "https://enablebanking.com/sign-in/" },
      say: ["Type your email. Tap the button under it.", "Open the email from Enable Banking. Tap its link.", "Then come back here and tap I'm in.", UNSEEN],
      ifYouSee: [
        { see: "**Sign up →** or **Get started**", do: "Tap it. It's the same page." },
        { see: "**Authenticator app**", do: "You can skip it. Once it's on, it can never be turned off." },
      ],
    },
    {
      id: "bank-key",
      role: "numbered",
      icon: "key",
      title: "Make your bank key",
      manual: false,
      auto: true,
      action: "make_bank_key",
      say: [
        "Tap Make my bank key.",
        "Clip Factory makes a secret key and keeps it locked away. Only Clip Factory can use it.",
        "It isn't your bank login.",
        "You copy its public part in the next step. That part is safe to share.",
      ],
    },
    {
      id: "bank-app",
      role: "numbered",
      icon: "plusSquare",
      title: "Add Clip Factory on Enable Banking",
      doneLabel: "I did this",
      auto: true,
      open: OPEN_APPS,
      say: [
        "It opens **API applications**.",
        "Under **Add a new application**, tap **Production**.",
        `Pick ${GENERATE_OUTSIDE}.`,
        "Paste your bank key in **Public certificate in PEM format**:",
      ],
      copy: [{ label: "Bank key", from: "publicKeyPem", short: true }],
      ifYouSee: [
        { see: "**Sandbox** still picked", do: "Tap **Production**. A Sandbox app can't read real banks, and it can't be changed later." },
        {
          see: "**Generate in the browser (using SubtleCrypto) and export private key** was picked and your computer saved a .pem file",
          do: `Better: make a new app and pick ${GENERATE_OUTSIDE}. Or add that file in step 5, then delete it.`,
        },
        { see: "Enable Banking says no to the bank key", do: "Copy this one instead:", copy: { label: "Other bank key", from: "certificatePem", short: true } },
      ],
    },
    {
      id: "bank-details",
      role: "numbered",
      icon: "fileText",
      title: "Fill in the app's details",
      doneLabel: "I did this",
      auto: true,
      say: ["Paste each one in its box:", "Type your own email in **Email for data protection matters**.", "Tap **Register**."],
      copy: [
        { label: "**Application name**", from: "appName" },
        { label: "**Allowed redirect URLs (one per line)**", from: "redirectUri" },
        { label: "**Application description**", from: "description" },
        { label: "**Privacy URL of the application**", from: "privacyUrl" },
        { label: "**Terms URL of the application**", from: "termsUrl" },
      ],
      copyAt: 1,
      ifYouSee: [
        { see: "**New application … has been added.**", do: "Done. The long code in it is your app ID. Pick the whole message and copy it. Clip Factory finds the app ID in it." },
        { see: "that message went away", do: "Your app's ID is on **API applications**, on your new app." },
        { see: "a link that looks wrong", do: "Enable Banking doesn't check them for your own use. Go on." },
      ],
    },
    {
      id: "bank-appid",
      role: "numbered",
      icon: "paste",
      title: "Give Clip Factory the app ID",
      manual: false,
      auto: true,
      action: "save_app_id",
      say: ["Paste the message from step 4 here. Then tap Save."],
      paste: { label: "App ID" },
      upload: {
        fold: "Have a .pem file instead?",
        better: `Better: make a new app with ${GENERATE_OUTSIDE} (steps 3 and 4).`,
        label: "Add the .pem file",
        cantPick: "Can't pick the file?",
        pasteLabel: "What's inside the .pem file",
      },
      ifYouSee: [{ see: "“Enable Banking doesn't know this key”", do: "Do steps 3 and 4 again to make a new app. Then paste its app ID here." }],
    },
    {
      id: "bank-link",
      role: "numbered",
      icon: "link",
      title: "Link your bank accounts",
      manual: false,
      auto: true,
      doneLabel: "I linked them",
      open: OPEN_APPS,
      say: [
        "It opens **API applications**. On your new app, tap **Activate by linking accounts**.",
        "Pick {country} in **Country**. Pick your bank in **ASPSP**. Pick **personal** in **Usage type**. Tap **Link**.",
        "Use BankID at your bank. Link every account your app money lands in.",
        "Use PayPal too? Tap **Link accounts** and add it the same way. PayPal asks for its own password there.",
      ],
      ifYouSee: [
        { see: "**Request activation** or **Request unrestriction**", do: "Don't tap it. That one is for companies, and it costs money." },
        { see: "**Share**", do: "Don't tap it. Your app is only for you." },
        { see: "**Unable to link accounts** or **Unable to start accounts linking**", do: "Tap **Activate by linking accounts** again. Pick **personal**." },
        { see: "your account only shows as business", do: "Skip it. Enable Banking's free use is for private accounts only." },
        { see: "Payoneer", do: "Payoneer can't be linked for private use. Clip Factory can't see it." },
        { see: "no Avanza or Nordnet", do: "Enable Banking doesn't have them. Pick another account." },
      ],
    },
    {
      id: "bank-connect",
      role: "numbered",
      icon: "card",
      title: "Connect your bank",
      manual: false,
      auto: true,
      action: "connect_bank",
      say: [
        "Tap Connect your bank. Pick a bank you linked in step 6.",
        "Use BankID again. Yes, again: this time it lets Clip Factory read it.",
        "Then go back to Clip Factory.",
        "Clip Factory never sees your bank login.",
      ],
      ifYouSee: [
        { see: "Enable Banking's own page first", do: "Read it and go on. It's Enable Banking's page, not your bank's." },
        { see: "Enable Banking asks for your personal number", do: "That's for BankID. Clip Factory never sees it." },
        { see: "a QR code on a computer", do: "Open the BankID app on your phone. Scan the code." },
        { see: "“Enable Banking didn't share an account”", do: "Link that account in step 6 first. Then tap Connect your bank again." },
      ],
    },
  ],
};

/** Enable Banking's own labels, word for word as its Control Panel showed them on 22 Nov 2026 (the only bold words). */
export const ENABLE_BANKING_LABELS = [
  "Sign up →",
  "Get started",
  "Authenticator app",
  "API applications",
  "Add a new application",
  "Production",
  "Sandbox",
  "Generate outside the browser and import public certificate",
  "Generate in the browser (using SubtleCrypto) and export private key",
  "Public certificate in PEM format",
  "Application name",
  "Allowed redirect URLs (one per line)",
  "Application description",
  "Privacy URL of the application",
  "Terms URL of the application",
  "Email for data protection matters",
  "Register",
  "New application … has been added.",
  "Activate by linking accounts",
  "Country",
  "ASPSP",
  "Usage type",
  "personal",
  "Link",
  "Link accounts",
  "Request activation",
  "Request unrestriction",
  "Share",
  "Unable to link accounts",
  "Unable to start accounts linking",
] as const;

/** The seven numbered steps (the ring counts exactly these), in order. */
export const numberedBankSteps = (): BankStep[] => BANK_GUIDE.steps.filter((s) => s.role === "numbered");

/** A step's number (1 to 7), or null for the optional email. */
export function bankStepNumber(id: BankStepId): number | null {
  const i = numberedBankSteps().findIndex((s) => s.id === id);
  return i < 0 ? null : i + 1;
}

export const bankStep = (id: BankStepId): BankStep => BANK_GUIDE.steps.find((s) => s.id === id)!;

/** The step's main action's words, as the server's `next.label` has them (§40.5.9). */
export function mainLabel(step: BankStep, appIdSaved: boolean): string | null {
  if (step.action === "make_bank_key") return "Make my bank key";
  if (step.action === "save_app_id") return appIdSaved ? "Check again" : "Save";
  if (step.action === "connect_bank") return "Connect your bank";
  return step.open && !step.mail ? step.open.label : null;
}

// ---------- The app ID ----------

/** Enable Banking's app ID: the first 8-4-4-4-12 hex match anywhere in what he pasted (step 5). */
export const APP_ID = /[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}/;
export function findAppId(text: string): string | null {
  return APP_ID.exec(text)?.[0].toLowerCase() ?? null;
}
export const NO_APP_ID = "Clip Factory can't find an app ID in that. Copy the whole **New application … has been added.** message again.";
/** The .pem file's own name holds the app ID ("{uuid}.pem", or "{uuid} (1).pem" for a second download). */
export const PEM_NAME = /^([0-9a-fA-F-]{36})(?: \(\d+\))?\.pem$/;
export const PEM_SAVED = "Saved. Clip Factory keeps it locked away. Now delete the .pem file from Downloads.";
export const PEM_MAX_BYTES = 8 * 1024;

// ---------- The email (optional step) ----------

/** The step's Open: a mailto: address built from `values.ask`, each part percent-encoded. */
export function mailtoOf(ask: BankView["values"]["ask"]): string {
  const to = encodeURIComponent(ask.to).replace(/%40/gi, "@");
  return `mailto:${to}?subject=${encodeURIComponent(ask.subject)}&body=${encodeURIComponent(ask.body)}`;
}

/** What a Copy chip copies. */
export function copyValue(from: BankCopyFrom, view: Pick<BankView, "values" | "key">): string | null {
  switch (from) {
    case "askTo":
      return view.values.ask.to;
    case "askBody":
      return view.values.ask.body;
    case "publicKeyPem":
      return view.key.publicKeyPem ?? null;
    case "certificatePem":
      return view.key.certificatePem ?? null;
    default:
      return view.values[from];
  }
}

/** The chip's short form: the first line and "…". */
export function firstLine(value: string): string {
  const line = value.split(/\r?\n/).find((l) => l.trim()) ?? value;
  return value.trim() === line.trim() ? line : `${line.trim()} …`;
}

// ---------- Country ----------

/** "Sweden" (the English name of his Money country), else "your country". */
export function countryName(code: string | null | undefined): string {
  if (!code) return "your country";
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase());
    return name && name !== code.toUpperCase() && !/^unknown/i.test(name) ? name : "your country";
  } catch {
    return "your country";
  }
}

// ---------- The bank picker ----------

/** The banks most used in Sweden come first, in this order; then A to Z. */
export const SWEDEN_FIRST = ["Swedbank", "Handelsbanken", "SEB", "Nordea", "Danske Bank", "Länsförsäkringar Bank", "ICA Banken", "SBAB Bank", "Skandiabanken", "Revolut", "PayPal", "Wise"] as const;

export function sortBanks<T extends { name: string }>(banks: readonly T[]): T[] {
  const rank = (n: string) => {
    const i = SWEDEN_FIRST.findIndex((s) => s.toLowerCase() === n.toLowerCase());
    return i < 0 ? SWEDEN_FIRST.length : i;
  };
  return [...banks].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "sv"));
}

/** Typing only filters: every word typed must be in the bank's name (accents and case ignored). */
export function filterBanks<T extends { name: string }>(banks: readonly T[], query: string): T[] {
  const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const words = fold(query).split(/\s+/).filter(Boolean);
  return words.length ? banks.filter((b) => words.every((w) => fold(b.name).includes(w))) : [...banks];
}

export const PICKER_LEAD = "Pick a bank you linked on Enable Banking.";
export const PICKER_NEW = "New bank? Link it on Enable Banking first: tap **Link accounts**, then come back.";
export const PICKER_AGAIN = "Already here: tap to reconnect";
export const NO_COUNTRY_HREF = "/settings/posting/money?back=/settings/posting/getpaid/bank#money-country";

// ---------- Sentences (exact; §40.5.4, §40.5.5) ----------

/** The check's sentences (§40.5.4). The server's `check.text` is what shows; these are the contract's words. */
export const CHECK_TEXT: Record<BankAppCode, string> = {
  ok: "Enable Banking knows Clip Factory, and your app is active.",
  not_active: "Saved. Next: link your bank accounts (step 6).",
  redirect_missing: "Paste the return address in **Allowed redirect URLs (one per line)**. On your app tap ⋮, then **Edit**, then **Save**.",
  sandbox: "That's a Sandbox app. Do steps 3 and 4 again, and tap **Production** first. Then paste the new app ID here.",
  key_wrong: "Enable Banking doesn't know this key. Do steps 3 and 4 again to make a new app. Then paste its app ID here.",
  not_found: "Enable Banking doesn't know that app ID. Copy it again.",
  down: "Enable Banking didn't answer. Try again in a few minutes.",
};

/** The connect results' sentences (§40.5.5), with {bank} and {button}. */
export const RESULT_TEXT: Record<BankResult, string> = {
  bank_connected: "Clip Factory can see money coming into {bank} now. It looks once a day.",
  bank_denied: "You stopped at the bank. Tap {button} to try again.",
  bank_no_accounts: "Enable Banking didn't share an account. Link it on Enable Banking first (step 6). Then tap {button} again.",
  bank_business_only: "That bank only shared a business account. Clip Factory reads private accounts only. Pick your private account at your bank, then tap {button} again.",
  bank_expired: "That took too long. Tap {button} again.",
  bank_key_wrong: "Enable Banking didn't know your bank key. Tap Check again in step 5.",
  bank_error: "Something went wrong. Tap {button} again in a few minutes.",
};
export const BANK_RESULTS = Object.keys(RESULT_TEXT) as BankResult[];
export const isBankResult = (v: unknown): v is BankResult => typeof v === "string" && (BANK_RESULTS as string[]).includes(v);

/** A result's sentence filled in; with no `lastConnect` (an unreadable state): "your bank" and "Connect your bank". */
export function resultSentence(result: BankResult, bank = "your bank", reconnect = false): string {
  const button = reconnect && bank !== "your bank" ? `Reconnect ${bank}` : "Connect your bank";
  return RESULT_TEXT[result].replaceAll("{bank}", bank).replaceAll("{button}", button);
}

/** /bank-done when this browser isn't signed in (§40.5.2): no button, no link. */
export const DONE_OK = "Done! Go back to Clip Factory. You can close this tab.";
export const DONE_NOT = "Your bank didn't connect. Go back to Clip Factory to see what to do.";
export const CHECKING_FIRST = "Checking your bank… This can take a few minutes.";

// ---------- The page's fixed words ----------

export const EACH_TIME_LOOK = "Clip Factory looks at your bank once a day by itself. When a payment may be from an app, it asks you here.";
export const EACH_TIME_BEFORE = "Your bank asks for BankID again every 3 to 6 months. Clip Factory tells you 7 days before.";
export const eachTimeEvery = (days: number) => `Every ${days} days your bank asks for BankID again. Clip Factory tells you 7 days before.`;

/** What Clip Factory keeps (fixed words, no buttons). */
export const BANK_KEEPS = [
  "Only money from apps: the day, the amount and which app.",
  "Payments it asks you about stay until you answer, at most 180 days.",
  "Never your account number, your name or any other payment.",
  "Your bank and PayPal logins stay with them. Clip Factory never sees them.",
  "Enable Banking forgets your bank's answer within a minute.",
  "Forget my bank removes every payment and bank link Clip Factory kept.",
] as const;

/** The places in their order, for the Where is it from? sheet ("Content Rewards (Whop)" only while it is on). */
export const SHEET_PLACES: { place: BankPlace; label: string }[] = [
  { place: "youtube", label: "YouTube" },
  { place: "tiktok", label: "TikTok" },
  { place: "instagram", label: "Instagram" },
  { place: "facebook", label: "Facebook" },
  { place: "meta", label: "Instagram and Facebook together" },
  { place: "x", label: "X" },
  { place: "contentrewards", label: "Content Rewards (Whop)" },
];
export const NOT_SURE = "Not sure";

/** "YouTube", "Instagram and Facebook" (the toast's and the button's words). */
export function bankPlaceName(place: BankPlace): string {
  if (place === "meta") return "Instagram and Facebook";
  if (place === "contentrewards") return "Content Rewards";
  return SHEET_PLACES.find((p) => p.place === place)!.label;
}

// ---------- Statuses ----------

/** Each status's icon: never colour alone. */
export const BANK_STATUS_ICON: Record<BankStatus, IconName> = {
  not_started: "info",
  setting_up: "alert",
  checking: "retry",
  can_see: "checkCircle",
  ending_soon: "clock",
  cant_read: "alert",
  look_in_bank: "user",
  ended: "xCircle",
  stopped_at_bank: "lock",
  stopped: "stop",
};

/** Words never on a Your bank screen (§40.5.2; "API" and "ASPSP" only inside Enable Banking's bold labels). */
export const BANK_NEVER = /\b(Live|Connected|Not connected|disconnected|consent|session|PSD2|AISP|tokens?|certificate|RSA|JWT|IBAN)\b/i;

// ---------- Errors the bank routes carry (§40.5.10) ----------

/** A bank route's refusal: the server's own code (`no_country`, `country_not_linked`, `rate_limited`, …) and `retryAt`. */
export interface BankError extends ApiError {
  bankCode?: string;
  retryAt?: string;
}

/** Turns a bank route's error answer into an ApiError that keeps the bank's own code and `retryAt`. */
export function bankError(status: number, body: unknown): BankError {
  const err = errorFromResponse(status, body) as BankError;
  const envelope = (body as { error?: { code?: unknown; retryAt?: unknown } } | null)?.error;
  if (typeof envelope?.code === "string" && /^[a-z_]{1,40}$/.test(envelope.code)) err.bankCode = envelope.code;
  if (typeof envelope?.retryAt === "string" && !Number.isNaN(Date.parse(envelope.retryAt))) err.retryAt = envelope.retryAt;
  return err;
}

/** The same, made by the pretend API. */
export function bankRefusal(status: number, code: string, message: string, retryAt?: string): BankError {
  return bankError(status, { error: { code, message, ...(retryAt ? { retryAt } : {}) } });
}

/** "Try again at 14:15." from a 429's `retryAt`, in this device's time. */
export function tryAgainAt(retryAt: string | undefined): string {
  if (!retryAt) return "";
  const d = new Date(retryAt);
  if (Number.isNaN(d.getTime())) return "";
  return `Try again at ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.`;
}

export const isBankError = (e: unknown): e is BankError => e instanceof ApiError;
