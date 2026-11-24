// Lamo Stories › Social accounts (docs/CONTRACTS.md §45.13, §45.16.7, §45.30, §45.33): Lamo Stories' own social
// accounts, separate from Clip Factory's. The page is organized like Clip Factory's Set up posting (the owner, 24 Nov):
// a header card, a progress card and one row per platform (SocialRows.tsx), each opening the platform's own page
// (/stories/connections/<p>, SocialPlatform.tsx) with its card below. One card per platform (YouTube, TikTok,
// Instagram, Facebook, X), kid-proof (the owner,
// 23 Nov: "less text … even an 8 year old should be able to use the app"): on the card only the platform's logo mark
// and name, one status chip, the account (picture, name and handle), the safety line while an account is still to
// connect or fix, what needs the owner (the account's warning, the list to pick from, the sign-in tip, who can see the
// posts and what can cost money) and ONE main button (Set up the app / Connect / Connect again / Pick another).
// While the developer app still needs setting up, "Set up the app" is the card's one main button and opens the app's
// choice on the card itself (in a setup step, where the card is the step, it is open by itself); Connect comes once
// the app is ready. Everything else sits in one closed "More" fold per card: the authorization status and when it was
// last checked, the account's id, Check now and Disconnect, the developer app once it is ready (its keys and redirect
// URIs), Clip Factory's own destination for that platform and what the platform allows for a second account (minus
// the lines the card already says).
//
// The owner's hard rule (§45.37 G8): Clips Funded never posts to Clip Factory's own accounts, so there is no
// "Use it for both" any more. Every card whose next step is an account (to connect, pick, connect again or replace,
// and while it asks "Is this your Clips Funded …?") says up front to use a new account made for Clips Funded; an account
// that is Clip Factory's own (any stable identity matches) is refused at connect and before every upload, also when
// Clip Factory connects it later, and the card says why.
//
// Before the first Connect each card asks which developer app Lamo Stories uses (§45.30): a separate app of its own
// (its keys pasted here, with Check it and Lamo Stories' own redirect URI to copy) or, for YouTube, TikTok and X only,
// Clip Factory's app on purpose ("Share Clip Factory's app": Clip Factory's posts always go first, §45.37 G6; still
// with a different account). Facebook and Instagram always use Lamo Stories' own Meta app, whose keys are entered
// once for both. Nothing is ever chosen silently, and the keys never come back from the server (masked hints only).
// Disconnect never revokes anything at the platform (§45.13.6): the page says where to remove the app by hand, in
// words that follow the app chosen (§45.34). Both Meta cards show both redirect URIs (Instagram's and Facebook's),
// also once the keys are saved. After a connect the page says "Connected as {name} ({handle})" and the card asks "Is
// this your Lamo Stories {place}?" (Yes, or Pick another). An account's reason is a code (SocialReason), said in words.
import "../styles/social.css";
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { friendlyMessage } from "../../api/errors.ts";
import type { KeyName } from "../../api/types.ts";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { config } from "../../lib/config.ts";
import { relative, shortDate } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { KEY_LABEL, keyNames, keyProblem, normaliseKey } from "../../lib/keyFormats.ts";
import { navigate } from "../../lib/router.ts";
import { storiesAwayLater, storiesGoLater } from "../pane.tsx";
import { storiesApi } from "../api/client.ts";
import { SHARED_APP_PLATFORMS, type ClipsDestination, type KeyCheck, type Platform, type SocialAccount } from "../api/types.ts";
import { ArcDial } from "../glass/index.ts";
import {
  celebrate,
  centerOf,
  PLATFORM_NAME,
  refreshDashboard,
  refreshOnboarding,
  StButton,
  StError,
  StIcon,
  StLinkButton,
  StLoading,
  StPick,
  StTech,
  plainFirst,
  useOnboarding,
  type StTone,
} from "../ui.tsx";
import type { StoriesScreenProps } from "./types.ts";
import { appReady as isAppReady, SocialHead, SocialProgress, SocialRowList } from "./SocialRows.tsx";
import { socialHref, useSkip } from "../skips.ts";

export { appReady } from "./SocialRows.tsx";

/** What one connection is on each platform: a channel, a Page or an account. */
export const PLACE: Record<Platform, string> = { youtube: "channel", tiktok: "account", instagram: "account", facebook: "Page", x: "account" };

/** Said before Connect (and before Connect again): §45.13.2, per developer app. */
export function beforeConnect(p: Platform, choice: SocialAccount["app"]["choice"]): string {
  switch (p) {
    case "youtube":
      return "Google will ask which channel. Pick your Clips Funded channel.";
    // The first sentence of the API's own line (social.py _TIKTOK, _X): its "why" stays in the More fold's limits.
    case "tiktok":
      return "Sign in to your Clips Funded account on tiktok.com in this browser first.";
    case "x":
      return "First sign in to your Clips Funded account on x.com in this browser.";
    default:
      // Facebook and Instagram always go through Lamo Stories' own Meta app (§45.30), whatever `choice` says.
      void choice;
      return "Facebook will ask which Pages this app may use. Tick only your Clips Funded Page.";
  }
}

/** Said up front on every card and Connect step whose next step is an account (§45.37 G8, the owner's hard rule): a new account, never Clip Factory's. */
export const NEW_ACCOUNT_LINE = "Use a new account made for Clips Funded, not Clip Factory's.";
/** The shared developer app's promise (§45.37 G6): Clip Factory's posts are never squeezed out. */
export const SHARED_APP_LINE = "Clip Factory's posts always go first. Clips Funded uses what's left.";
/** Sharing the app never means sharing the account (§45.37 G8 (c)). */
export const SHARED_APP_ACCOUNT_LINE = "Even with Clip Factory's app, sign in with a different account made for Clips Funded.";
/** The account just signed in with is Clip Factory's own (§45.37 G8 (c)). */
export const SAME_AS_CLIPS_LINE = "This is Clip Factory's own account. Clips Funded needs its own separate account: sign in with a different one.";
/** Clip Factory connected this very account later (the API's reason clips_now): it is blocked from posting (§45.37 G8 (a)). */
export const CLIPS_LATER_LINE = "This is Clip Factory's account now. Connect a different account made for Clips Funded.";
/** Who can see the posts, on the card while the platform's limits say so (their whole line is in More). */
export const ONLY_ME_NOTE = "Posts stay Only me for now.";
/** What can cost money, on the card while it applies (§45.37 G6: X with Clip Factory's app; the whole line is in More). */
export const X_OVER_NOTE = "This can go over your monthly X limit.";

/** The short notes the platform's limits call for on the card itself: who can see the posts, and what can cost money. */
export function limitNotes(limits: readonly string[]): string[] {
  const out: string[] = [];
  if (limits.some((l) => /only me|seen by you only|must be private/i.test(l))) out.push(ONLY_ME_NOTE);
  if (limits.some((l) => /over your X limit/i.test(l))) out.push(X_OVER_NOTE);
  return out;
}

/**
 * Why an account that is Clip Factory's own is stopped (§45.37 G8): the API's own warning when it sends one (it always
 * does for same_as_clips), else the line for its code (clips_now: Clip Factory connected it later). Said once.
 */
export function sameAsClipsLine(a: Pick<SocialAccount, "reason"> & { warning?: string | null }): string {
  return a.warning?.trim() || (a.reason === "clips_now" ? CLIPS_LATER_LINE : SAME_AS_CLIPS_LINE);
}

/** After a Disconnect with Clip Factory's app (shared on purpose): removing that app would touch Clip Factory too. */
export const AFTER_DISCONNECT =
  "To remove Clip Factory from this account completely, remove the app in the account's own settings. Only do that if Clip Factory does not use the same account.";
/** After a Disconnect with Lamo Stories' own developer app (always for Facebook and Instagram, §45.34). */
export const AFTER_DISCONNECT_OWN =
  "To remove Clips Funded completely, remove your Clips Funded app in the account's own settings. Clip Factory is not affected.";

/** The after-disconnect line for the app the account used (§45.34). */
export function afterDisconnect(choice: SocialAccount["app"]["choice"]): string {
  return choice === "own" ? AFTER_DISCONNECT_OWN : AFTER_DISCONNECT;
}

/**
 * "this Facebook Page (Lamo Stories)": the place named by its platform, with its own name after it, so a sentence
 * reads right even when the account itself is called "Lamo Stories" (§45.36 E13).
 */
export function thisPlace(a: Pick<SocialAccount, "platform" | "accountName" | "handle">): string {
  const name = a.accountName ?? a.handle;
  return `this ${PLATFORM_NAME[a.platform]} ${PLACE[a.platform]}${name ? ` (${name})` : ""}`;
}

/** "Connected as Lamo Stories (@lamo.stories)": the account's name, and its handle when it says more. */
export function connectedAsSentence(a: Pick<SocialAccount, "accountName" | "handle">): string {
  const name = a.accountName ?? a.handle ?? "your account";
  return a.handle && a.handle !== name ? `Connected as ${name} (${a.handle})` : `Connected as ${name}`;
}

const STATUS: Record<SocialAccount["connectionStatus"], { label: string; tone: StTone; auth: string }> = {
  connected: { label: "Connected", tone: "mint", auth: "Allowed: Clips Funded may post here." },
  choose_account: { label: "Pick one", tone: "sun", auth: "Allowed, but pick where Clips Funded posts first." },
  needs_reconnect: { label: "Connect again", tone: "coral", auth: "Stopped: the sign-in needs renewing. Tap Connect again." },
  same_as_clips: { label: "Clip Factory's own", tone: "coral", auth: "Stopped: Clips Funded never posts to Clip Factory's own account." },
  not_connected: { label: "Not connected", tone: "sky", auth: "Not allowed yet: nothing is connected." },
};

/** The cards that need the owner (a warm tint): on Social accounts they are hero glass, their rim may bend. */
const NEEDS_OWNER: ReadonlySet<SocialAccount["connectionStatus"]> = new Set(["choose_account", "needs_reconnect", "same_as_clips"]);
/** Their tint's colour, kept under a liquid rim too (glass.css .st-lens--tinted reads the card's own --st-tone-rgb). */
const LENS_TONE: Partial<Record<SocialAccount["connectionStatus"], CSSProperties>> = {
  choose_account: { "--st-tone-rgb": "var(--st-amber-rgb)" } as CSSProperties,
  needs_reconnect: { "--st-tone-rgb": "var(--st-coral-rgb)" } as CSSProperties,
  same_as_clips: { "--st-tone-rgb": "var(--st-coral-rgb)" } as CSSProperties,
};

/** The callback's result code (§17.5's codes plus same_as_clips and clips_meta_check) in plain words. */
export function resultSentence(code: string, p: Platform): { text: string; good: boolean } {
  const name = PLATFORM_NAME[p];
  switch (code) {
    case "connected":
      return { text: `${name} is connected to Clips Funded!`, good: true };
    case "choose":
      return { text: `Now pick the ${name} ${PLACE[p]} Clips Funded posts to.`, good: true };
    case "same_as_clips":
      return { text: SAME_AS_CLIPS_LINE, good: false };
    case "clips_meta_check":
      return { text: `${name} is connected. But Clip Factory may have lost ${name}: connect it again in Clip Factory, keeping its Page ticked.`, good: false };
    case "denied":
      return { text: `You pressed cancel. Tap Connect ${name} to try again.`, good: false };
    case "expired":
      return { text: "That took too long. Tap Connect again.", good: false };
    case "keys_wrong":
      return { text: `${name} did not accept the app keys. Check them under More, then connect again.`, good: false };
    case "redirect_wrong":
      return { text: `The return address does not match. Copy the address under More into your ${name} app's settings, then connect again.`, good: false };
    case "missing_permissions":
      return { text: "A permission box was not ticked. Connect again and tick every box.", good: false };
    case "no_channel":
      return { text: "This Google account has no YouTube channel. Make the Clips Funded channel first, then connect again.", good: false };
    case "no_accounts":
    case "wrong_account_type":
      return { text: "Instagram did not show a professional account. Make one, link it to a Facebook Page, then connect again.", good: false };
    case "no_pages":
      return { text: "Facebook did not show a Page you run. Make the Clips Funded Page first, then connect again.", good: false };
    case "platform_down":
      return { text: `${name} did not answer. Try again in a few minutes.`, good: false };
    default:
      return { text: `Something went wrong. Tap Connect ${name} again.`, good: false };
  }
}

/**
 * The account's `reason` (§45.6): a code, as Clip Factory's own accounts carry one (§17), never a sentence. Each code
 * in plain words; anything new or unknown gets the plain "needs connecting again".
 */
export function reasonSentence(code: string | null, p: Platform): string {
  const name = PLATFORM_NAME[p];
  switch (code) {
    case "keys_changed":
      return `The ${name} app keys changed. Connect again.`;
    case "token_dead":
      return `Clips Funded's ${name} sign-in stopped working. Connect again.`;
    case "expires_soon":
      return `Clips Funded's ${name} sign-in ends soon.`;
    case "signed_out_90_days":
      return `${name} signs Clips Funded out after 90 days. Connect again.`;
    case "missing_permissions":
      return "A permission box was not ticked. Connect again and tick every box.";
    case "expired":
      return `That took too long. Tap Connect ${name} again.`;
    case "clips_unknown":
      return `Clips Funded cannot tell this ${name} account apart from Clip Factory's own. Check which account is signed in.`;
    case "clips_now":
      return CLIPS_LATER_LINE;
    default:
      return `Clips Funded's ${name} needs connecting again.`;
  }
}

export function isPlatform(p: string | null): p is Platform {
  return p === "youtube" || p === "tiktok" || p === "instagram" || p === "facebook" || p === "x";
}

/** Where Connect sends the owner: the platform's own page (https), or, in the pretend app, straight back here. */
export function safeAuthorizeUrl(url: string): "away" | "here" | null {
  if (/^https:\/\/[^\s]+$/.test(url)) return "away";
  if (url.startsWith("/stories/connections?") && !url.startsWith("//")) return "here";
  return null;
}

/** Lamo Stories' own callback, the redirect URI its own developer apps register (§45.13.3, §45.30). */
export function storiesRedirectUri(p: Platform, apiUrl = config().apiUrl): string {
  return `${apiUrl.replace(/\/+$/, "")}/v1/stories-oauth/${p}/callback`;
}

const META: Platform[] = ["instagram", "facebook"];
const isMeta = (p: Platform) => META.includes(p);

/**
 * What a separate developer app means on each platform, in plain words (the differences from Clip Factory's guide).
 * Where its keys go (here, never into Clip Factory's guide) is said once, by KEYS_HERE_ONLY beside the guide's link.
 */
const META_NOTES = [
  "Make one new Meta app for Clips Funded. It serves Instagram and Facebook: its keys are entered once.",
  "Copy both addresses below into your Meta app's settings, and make a sign-in setup there. Its number goes in the last box.",
  "At first only you can connect. Meta checks the app before anyone else can.",
];
const OWN_APP_NOTES: Record<Platform, string[]> = {
  youtube: [
    "Make a new Google Cloud project, named for example Clips Funded.",
    "Copy the address below into your app's settings (not Clip Factory's).",
    "Its uploads per day are its own.",
  ],
  tiktok: [
    "Make a new app on TikTok for Developers, named for example Clips Funded.",
    "Copy the address below into your app's settings (not Clip Factory's).",
    "TikTok checks every new app before posts can be public. That can take days to weeks.",
  ],
  instagram: META_NOTES,
  facebook: META_NOTES,
  x: [
    "Make a new app in the X Developer Portal, named for example Clips Funded.",
    "Copy the address below into your app's settings (not Clip Factory's).",
    "It needs its own X credits.",
  ],
};

/** The same steps in the developer sites' own words, one tap away (§45.36 E14). */
const META_TECH = [
  "The addresses are the app's redirect URIs: add both in Facebook Login › Settings › Valid OAuth Redirect URIs.",
  "The sign-in setup is a Login configuration (Facebook Login for Business › Configurations). Its ID goes in the Configuration ID box.",
  "While the app is in Development mode only you can connect. Going Live needs Meta's App Review.",
];
export const OWN_APP_TECH: Record<Platform, string[]> = {
  youtube: ["The address is the app's redirect URI: add it under Authorized redirect URIs of its OAuth client (APIs & Services › Credentials)."],
  tiktok: ["The address is the app's redirect URI: add it in Login Kit › Redirect URI.", "Until TikTok approves the app it runs in Sandbox: only its test accounts can connect."],
  instagram: META_TECH,
  facebook: META_TECH,
  x: ["The address is the app's redirect URI: add it as the Callback URI / Redirect URL in the app's User authentication settings."],
};

/** Said before the link to Clip Factory's guide, whose keys step changes Clip Factory's own app (§45.1, §45.30). */
export const KEYS_HERE_ONLY = "Only read the steps there. Paste the keys here, never in Clip Factory's guide: that would change Clip Factory's own app.";

/** The account on the card: its picture, name and handle (its id is in the More fold, §45.36 E14). */
function Identity({ a }: { a: SocialAccount }) {
  if (!a.externalAccountId && !a.accountName) return null;
  return (
    <div className="st-who">
      {a.avatarUrl ? (
        <img className="st-who__avatar" src={a.avatarUrl} alt="" width={44} height={44} />
      ) : (
        <span className="st-who__avatar st-who__avatar--none" aria-hidden="true">
          <StIcon name="user" size={22} />
        </span>
      )}
      <div className="st-who__text">
        <span className="st-who__name">{a.accountName ?? "No name"}</span>
        {a.handle && a.handle !== a.accountName ? <span className="st-who__handle">{a.handle}</span> : null}
      </div>
    </div>
  );
}

/** A line, in its sentences ("x.com" and "funded.clips" stay whole: a sentence ends at a stop and a space). */
function sentences(line: string): string[] {
  return line
    .replace(/([.!?])\s+/g, "$1\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The platform's limits minus every sentence the card already says (the API repeats the card's own lines there: the
 * new-account line, the sign-in tip, the shared app's two lines), so nothing on a card is said twice. A line left
 * with nothing is dropped.
 */
export function unsaid(limits: readonly string[], said: readonly string[]): string[] {
  const known = new Set(said.flatMap(sentences));
  return limits.map((l) => sentences(l).filter((s) => !known.has(s)).join(" ")).filter(Boolean);
}

/** The More fold's body: a stack with the card's own gap (as .st-conn and .st-app__go). */
const MORE_BODY: CSSProperties = { display: "grid", gap: "var(--st-space-3)", minWidth: 0, paddingBottom: "var(--st-space-3)" };

/** A box of text with a Copy button (the redirect URI). */
function CopyLine({ label, value, copyLabel }: { label: string; value: string; copyLabel?: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <div className="st-copy">
      <span className="st-copy__label">{label}</span>
      <code className="st-copy__value">{value}</code>
      <StButton
        className="st-copy__btn"
        aria-label={copyLabel ?? `Copy the ${label.toLowerCase()}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            toast.success("Copied!");
            setTimeout(() => setCopied(false), 1800);
          } catch {
            toast.error("Your browser did not let us copy. Press and hold the address to copy it.");
          }
        }}
      >
        <StIcon name={copied ? "check" : "copy"} size={18} />
        {copied ? "Copied" : "Copy"}
      </StButton>
    </div>
  );
}

/**
 * The redirect URIs to add in the developer app: the platform's own, or, on a Meta card, both Instagram's and
 * Facebook's (one Meta app serves both, and Meta only returns to an address it was given, §45.34).
 */
function RedirectLines({ p }: { p: Platform }) {
  if (!isMeta(p)) return <CopyLine label="The address to copy" copyLabel="Copy the redirect URI" value={storiesRedirectUri(p)} />;
  return (
    <div className="st-redirects" role="group" aria-label="Both redirect URIs for the Meta app">
      <CopyLine label="Instagram's address" copyLabel="Copy Instagram's redirect URI" value={storiesRedirectUri("instagram")} />
      <CopyLine label="Facebook's address" copyLabel="Copy Facebook's redirect URI" value={storiesRedirectUri("facebook")} />
    </div>
  );
}

function CheckLine({ check }: { check: KeyCheck | undefined }) {
  if (!check) return null;
  return (
    <p className={`st-note ${check.ok ? "st-note--mint" : "st-note--coral"}`} role="status">
      <StIcon name={check.ok ? "check" : "alert"} size={18} />
      {check.message}
      {check.ok && check.account === "dead" ? " But Clips Funded's sign-in to the account stopped working: tap Connect again." : ""}
      <span className="st-note__when"> Checked {relative(check.at)}.</span>
    </p>
  );
}

/** The own app's keys form (§17.4's boxes and formats; the Meta one also takes the Login configuration ID). */
function KeysForm({ p, saving, onSave, onCancel }: { p: Platform; saving: boolean; onSave: (keys: Partial<Record<KeyName, string>>) => void; onCancel?: () => void }) {
  const names = keyNames(p);
  const [values, setValues] = useState<Partial<Record<KeyName, string>>>({});
  const [tried, setTried] = useState(false);
  const problems = Object.fromEntries(names.map((n) => [n, keyProblem(p, n, values[n] ?? "")])) as Record<KeyName, string | null>;
  const empty = names.filter((n) => !normaliseKey(n, values[n] ?? ""));
  const ok = empty.length === 0 && names.every((n) => !problems[n]);
  const appName = isMeta(p) ? "Meta" : PLATFORM_NAME[p];
  return (
    <form
      className="st-keys"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!ok) return;
        onSave(Object.fromEntries(names.map((n) => [n, normaliseKey(n, values[n] ?? "")])));
      }}
    >
      <p className="st-keys__ask">Paste the keys of your Clips Funded {appName} app:</p>
      {names.map((n) => {
        const id = `st-key-${p}-${n}`;
        const problem = problems[n] ?? (tried && empty.includes(n) ? `Paste the ${KEY_LABEL[p][n]} here.` : null);
        return (
          <div key={n} className="st-field">
            <label htmlFor={id} className="st-field__label">
              {KEY_LABEL[p][n]}
            </label>
            <input
              id={id}
              className="st-input"
              type={n === "clientSecret" ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              value={values[n] ?? ""}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${id}-p` : undefined}
              onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))}
            />
            {problem ? (
              <span className="st-field__problem" id={`${id}-p`}>
                {problem}
              </span>
            ) : null}
          </div>
        );
      })}
      <div className="st-keys__buttons">
        {onCancel ? (
          <StButton quiet onClick={onCancel}>
            Not now
          </StButton>
        ) : null}
        <StButton main type="submit" disabled={saving} aria-disabled={!ok || undefined}>
          <StIcon name="key" size={18} />
          {saving ? "Saving…" : "Save the keys"}
        </StButton>
      </div>
      <p className="st-keys__safe">The keys are kept safe. They never show here again.</p>
    </form>
  );
}

type Busy = string | null;

/** The developer-app part of a card (§45.30): the choice, the keys, Check it, Change app. */
function AppPart({
  ws,
  a,
  meta,
  busy,
  run,
}: {
  ws: string;
  a: SocialAccount;
  /** the other Meta card, so one Meta app's keys are entered once for both */
  meta: SocialAccount | undefined;
  busy: Busy;
  run: (what: string, fn: () => Promise<unknown>, done?: { text: string; cheer?: HTMLElement | null }) => Promise<boolean>;
}) {
  const p = a.platform;
  const name = PLATFORM_NAME[p];
  const shared = SHARED_APP_PLATFORMS.includes(p);
  const [picking, setPicking] = useState<"own" | "clips" | null>(null);
  const [changing, setChanging] = useState(false);
  const [sure, setSure] = useState<"remove" | null>(null);
  const choice = a.app.choice;
  const connected = a.connectionStatus !== "not_connected";
  const showChoice = changing || choice === null || (choice === "own" && !a.app.saved);
  const want = picking ?? (choice === "own" || isMeta(p) ? "own" : choice === "clips" ? "clips" : null);

  // One own Meta app serves Instagram and Facebook (§45.30, entered once): the server saves, changes and deletes its
  // keys for both at once (and disconnects each one whose app changed), so the page sends them once and then shows
  // what the server holds for both cards.
  const saveKeys = (keys: Partial<Record<KeyName, string>>) =>
    void run(
      "keys",
      async () => {
        if (isMeta(p))
          await storiesApi().setSocialApp(ws, p as "instagram" | "facebook", { choice: "own", clientId: keys.clientId ?? "", clientSecret: keys.clientSecret ?? "", configId: keys.configId ?? "" });
        else await storiesApi().setSocialApp(ws, p as "youtube" | "tiktok" | "x", { choice: "own", clientId: keys.clientId ?? "", clientSecret: keys.clientSecret ?? "" });
        setPicking(null);
        setChanging(false);
      },
      { text: isMeta(p) ? "The Meta app keys are saved for Instagram and Facebook." : `The ${name} app keys are saved.` },
    );
  // What a change of keys disconnects: on a Meta card, both Meta accounts.
  const otherConnected = !!meta && meta.connectionStatus !== "not_connected";
  const disconnects = isMeta(p)
    ? connected && otherConnected
      ? "Clips Funded's Instagram and Facebook"
      : connected
        ? `Clips Funded's ${name}`
        : otherConnected
          ? `Clips Funded's ${PLATFORM_NAME[meta!.platform]}`
          : null
    : connected
      ? `Clips Funded's ${name}`
      : null;

  return (
    <div className="st-app" data-app={choice ?? "none"}>
      <h3 className="st-app__title">
        <StIcon name="key" size={18} />
        {!showChoice ? `The ${isMeta(p) ? "Meta" : name} app` : shared ? `Pick the ${name} app` : "Set up the Meta app"}
      </h3>
      {!showChoice ? (
        <>
          <p className="st-app__now">
            {choice === "clips" ? (
              <>
                Shares <strong>Clip Factory's {name} app</strong>, on purpose. {SHARED_APP_LINE} {SHARED_APP_ACCOUNT_LINE}
              </>
            ) : (
              <>
                Uses <strong>its own {isMeta(p) ? "Meta" : name} app</strong>. Its keys are saved.
              </>
            )}
          </p>
          {choice === "own" && a.app.hints?.clientId ? (
            <StTech className="st-app__tech">
              <span>
                {KEY_LABEL[p].clientId} <code>{a.app.hints.clientId}</code>
                {a.app.hints.configId ? (
                  <>
                    {" "}
                    · {KEY_LABEL[p].configId ?? "Configuration ID"} <code>{a.app.hints.configId}</code>
                  </>
                ) : null}
              </span>
            </StTech>
          ) : null}
          {choice === "own" ? <CheckLine check={a.app.check} /> : null}
          {choice === "own" ? (
            <div className="st-app__uris">
              <p className="st-app__uris-note">
                {isMeta(p) ? "Copy these two addresses into your Meta app's settings." : `Copy this address into your ${name} app's settings.`}
              </p>
              <RedirectLines p={p} />
              <StTech>
                <ul>
                  {OWN_APP_TECH[p].slice(0, 1).map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </StTech>
            </div>
          ) : null}
          {sure === "remove" ? (
            <div className="st-sure" role="group" aria-label="Are you sure?">
              <p className="st-sure__ask">
                <strong>Are you sure?</strong> {isMeta(p) ? "This removes the Meta app keys for Instagram and Facebook. " : ""}
                {disconnects ? `It disconnects ${disconnects} first. ` : ""}Clip Factory is not touched.
              </p>
              <div className="st-sure__buttons">
                <StButton onClick={() => setSure(null)}>No, keep them</StButton>
                <StButton
                  main
                  className="st-btn--coral"
                  disabled={busy !== null}
                  onClick={() =>
                    void run("remove", () => storiesApi().deleteSocialApp(ws, p), {
                      text: isMeta(p) ? "The Meta app keys are removed from Clips Funded, for Instagram and Facebook." : `The ${name} app keys are removed from Clips Funded.`,
                    }).then((ok) => ok && setSure(null))
                  }
                >
                  Yes, remove the keys
                </StButton>
              </div>
            </div>
          ) : (
            <div className="st-app__actions">
              {choice === "own" ? (
                <StButton
                  disabled={busy !== null}
                  onClick={(e) => {
                    const el = e.currentTarget;
                    void run("check-app", async () => {
                      const check = await storiesApi().checkSocialApp(ws, p);
                      if (check.ok) celebrate(centerOf(el));
                    });
                  }}
                >
                  <StIcon name="check" size={18} />
                  {busy === "check-app" ? "Checking…" : "Check it"}
                </StButton>
              ) : null}
              {shared || choice === "own" ? (
                <StButton quiet disabled={busy !== null} onClick={() => setChanging(true)}>
                  {isMeta(p) ? "New keys" : "Change app"}
                </StButton>
              ) : null}
              {choice === "own" ? (
                <StButton quiet disabled={busy !== null} onClick={() => setSure("remove")}>
                  Remove keys
                </StButton>
              ) : null}
            </div>
          )}
        </>
      ) : (
        <>
          {shared ? (
            <>
              <p className="st-app__ask">Which {name} app should Clips Funded use?</p>
              <StPick<"own" | "clips">
                label={`Which ${name} app Clips Funded uses`}
                stack
                value={(want ?? "none") as "own" | "clips"}
                options={[
                  { value: "own", label: "A separate app for Clips Funded", line: "You make a new app and paste its keys here." },
                  { value: "clips", label: "Share Clip Factory's app", line: `${SHARED_APP_LINE} ${SHARED_APP_ACCOUNT_LINE}` },
                ]}
                onChange={(v) => setPicking(v)}
              />
            </>
          ) : (
            <p className="st-app__ask">
              {name} always uses Clips Funded's own Meta app, so Clip Factory's Meta connection is never touched.
            </p>
          )}
          {want === "clips" ? (
            <div className="st-app__go">
              {connected && choice !== "clips" ? <p className="st-app__warn">Switching apps disconnects Clips Funded's {name} first. Clip Factory is not touched.</p> : null}
              <div className="st-app__actions">
                {changing ? (
                  <StButton quiet onClick={() => (setChanging(false), setPicking(null))}>
                    Not now
                  </StButton>
                ) : null}
                <StButton
                  main
                  disabled={busy !== null}
                  onClick={(e) => {
                    const el = e.currentTarget;
                    void run(
                      "clips-app",
                      async () => {
                        await storiesApi().setSocialApp(ws, p as "youtube" | "tiktok" | "x", { choice: "clips" });
                        setPicking(null);
                        setChanging(false);
                      },
                      { text: `Clips Funded shares Clip Factory's ${name} app. Now tap Connect ${name} and sign in with the Clips Funded account.`, cheer: el },
                    );
                  }}
                >
                  <StIcon name="check" size={18} />
                  Share Clip Factory's app
                </StButton>
              </div>
            </div>
          ) : want === "own" ? (
            <div className="st-app__go">
              <ul className="st-app__notes">
                {OWN_APP_NOTES[p].map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <RedirectLines p={p} />
              <StTech>
                <ul>
                  {OWN_APP_TECH[p].map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </StTech>
              <div className="st-app__guide">
                <p>The other steps are in Clip Factory's guide. It opens in Clip Factory: come back with the switch.</p>
                <p className="st-note st-note--coral st-app__keys-here" role="note">
                  <StIcon name="alert" size={18} />
                  {KEYS_HERE_ONLY}
                </p>
                <StLinkButton href={`/settings/posting/setup/${p}`} className="st-app__guide-link">
                  <StIcon name="external" size={18} />
                  Read Clip Factory's {isMeta(p) ? "Meta" : name} guide
                </StLinkButton>
              </div>
              {disconnects && (choice !== "own" || changing) ? (
                <p className="st-app__warn">
                  {isMeta(p) ? "The keys are saved for Instagram and Facebook. " : ""}
                  {choice === "own" ? "Keys of a different app disconnect " : "Switching apps disconnects "}
                  {disconnects} first. Clip Factory is not touched.
                </p>
              ) : null}
              <KeysForm p={p} saving={busy === "keys"} onSave={saveKeys} onCancel={changing ? () => (setChanging(false), setPicking(null)) : undefined} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

type Ask = { kind: "disconnect" } | null;

/** After a connect: "Is this your Lamo Stories {place}?" with Yes and Pick another (§45.34). */
function IntendedAsk({ a, busy, onYes, onAnother }: { a: SocialAccount; busy: boolean; onYes: (el: HTMLElement) => void; onAnother: () => void }) {
  const place = PLACE[a.platform];
  return (
    <div className="st-intended" role="group" aria-label={`Is this your Clips Funded ${place}?`}>
      <p className="st-intended__said" role="status">
        <StIcon name="check" size={18} />
        {connectedAsSentence(a)}.
      </p>
      <p className="st-intended__ask">
        <strong>Is this your Clips Funded {place}?</strong>
      </p>
      <div className="st-sure__buttons">
        <StButton main disabled={busy} onClick={(e) => onYes(e.currentTarget)}>
          <StIcon name="check" size={18} />
          Yes, that's it
        </StButton>
        <StButton disabled={busy} onClick={onAnother}>
          <StIcon name="retry" size={18} />
          Pick another {place}
        </StButton>
      </div>
    </div>
  );
}

/** One platform's card. Also used by the setup's connect steps (§45.29). */
export function PlatformCard({
  ws,
  a,
  all,
  clips,
  onChanged,
  onDisconnected,
  askIntended = false,
  onAnswered,
  inStep = false,
  headingLevel = 2,
}: {
  ws: string;
  a: SocialAccount;
  all: SocialAccount[];
  clips: ClipsDestination | undefined;
  onChanged: () => Promise<void>;
  /** with the developer app the account used, so the after-disconnect line fits it (§45.34) */
  onDisconnected: (p: Platform, choice: SocialAccount["app"]["choice"]) => void;
  /** just connected: ask whether this is the intended account */
  askIntended?: boolean;
  onAnswered?: () => void;
  /** inside a setup step: flat on the step's own glass panel, not a glass card of its own */
  inStep?: boolean;
  /** 1 on the platform's own page, where the card's name is the page's heading */
  headingLevel?: 1 | 2;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<Busy>(null);
  const [ask, setAsk] = useState<Ask>(null);
  // Connected by picking from the list: the same "Is this your Lamo Stories {place}?" as after a sign-in (§45.34).
  const [picked, setPicked] = useState(false);
  const p = a.platform;
  const name = PLATFORM_NAME[p];
  const status = STATUS[a.connectionStatus];
  const otherMeta = isMeta(p) ? all.find((x) => x.platform === (p === "instagram" ? "facebook" : "instagram")) : undefined;

  const run = async (what: string, fn: () => Promise<unknown>, done?: { text: string; cheer?: HTMLElement | null }): Promise<boolean> => {
    setBusy(what);
    try {
      await fn();
      await onChanged();
      void refreshDashboard(ws).catch(() => undefined);
      void refreshOnboarding(ws).catch(() => undefined);
      if (done) {
        if (done.cheer !== undefined) celebrate(centerOf(done.cheer));
        toast.success(done.text);
      }
      setAsk(null);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      // The server's word wins: show what is really stored now.
      void onChanged().catch(() => undefined);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    setBusy("connect");
    try {
      const { authorizeUrl, expiresAt } = await storiesApi().connectSocial(ws, p);
      const where = safeAuthorizeUrl(authorizeUrl);
      if (!where) throw new Error("bad authorize url");
      // The sign-in page comes after a wait: while Clip Factory is on screen it waits, and opens the moment Lamo
      // Stories is back (§45.35 D17), so the owner is never taken out of Clip Factory.
      if (where === "away") storiesAwayLater(authorizeUrl, expiresAt);
      else storiesGoLater(authorizeUrl);
    } catch (e) {
      toast.error(e instanceof Error && e.message === "bad authorize url" ? `${name} sent a link we do not trust. Try again in a minute.` : friendlyMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // Connect waits for the developer app: chosen, and (for its own app) its keys saved (§45.30: never a fallback).
  const appReady = isAppReady(a);
  // Until then the card's one main button is "Set up the app": it opens the app's choice on the card itself (never in
  // a fold). In a setup step the card is the step, so there it is open by itself, also when the app stops being ready
  // after the card is on screen (fresh data); closed by hand, it stays so.
  const [setupOpen, setSetupOpen] = useState(inStep && !appReady);
  const setupId = useId();
  // The More fold: closed, so five cards stay short.
  const [open, setOpen] = useState(false);
  const [wasReady, setWasReady] = useState(appReady);
  if (wasReady !== appReady) {
    setWasReady(appReady);
    if (!appReady && inStep) setSetupOpen(true);
  }
  const connected = a.connectionStatus === "connected";
  // Just connected: the card asks "Is this your Clips Funded {place}?".
  const asking = (askIntended || picked) && connected && !ask;
  // A connected YouTube changes channel by connecting again (Google asks which one, §45.13.5): its button says so,
  // as its limits line does ("To change it, tap Pick another channel.").
  const connectLabel =
    a.connectionStatus === "not_connected"
      ? `Connect ${name}`
      : a.connectionStatus === "same_as_clips" || a.connectionStatus === "choose_account" || (p === "youtube" && connected)
        ? `Pick another ${PLACE[p]}`
        : "Connect again";
  // The one main button: only where connecting is what the card needs now (a list to pick from is its own main part).
  const connectIsMain = appReady && (a.connectionStatus === "not_connected" || a.connectionStatus === "needs_reconnect" || a.connectionStatus === "same_as_clips");
  const reasonText = a.connectionStatus === "needs_reconnect" ? reasonSentence(a.reason, p) : null;
  // Any other code is said in words too (the two with their own lines below excepted); the server's warning, when
  // there is one, already says it.
  const otherReason =
    a.reason && a.connectionStatus !== "needs_reconnect" && a.connectionStatus !== "same_as_clips" && a.reason !== "expires_soon" && a.reason !== "expired" && !a.warning ? reasonSentence(a.reason, p) : null;
  // The sign-in tip (§45.13.2): on the card while connecting is the next step, in the fold once connected.
  const tip = appReady && a.connectionStatus !== "choose_account" ? beforeConnect(p, a.app.choice) : null;
  const tipLine = tip ? (
    <p className="st-conn__before">
      <StIcon name="bulb" size={18} />
      {tip}
    </p>
  ) : null;
  // The shared app's two lines are on the card (its choice, or what it uses now) unless it has keys of its own.
  const sharedSaid = SHARED_APP_PLATFORMS.includes(p) && !(a.app.choice === "own" && a.app.saved);
  const limits = unsaid(a.limits, [NEW_ACCOUNT_LINE, ...(tip ? [tip] : []), ...(sharedSaid ? [SHARED_APP_LINE, SHARED_APP_ACCOUNT_LINE] : [])]);
  const canCheck = a.connectionStatus !== "not_connected" && a.connectionStatus !== "choose_account";
  const canDisconnect = a.connectionStatus !== "not_connected";

  return (
    <li className={`st-conn st-conn--${a.connectionStatus} ${inStep ? "st-conn--in-step" : NEEDS_OWNER.has(a.connectionStatus) ? "st-glass st-glass--hero st-lens st-lens--tinted" : "st-glass"}`} style={inStep ? undefined : LENS_TONE[a.connectionStatus]} data-platform={p}>
      <header className="st-conn__head">
        <span className={`st-conn__mark st-conn__mark--${p}`}>
          <PlatformMark platform={p} size={24} title={`${name} logo`} />
        </span>
        {headingLevel === 1 ? <h1 className="st-conn__name st-display">{name}</h1> : <h2 className="st-conn__name st-display">{name}</h2>}
        <span className={`st-chip st-chip--${status.tone}`}>{status.label}</span>
      </header>
      {/* Up front while an account is still to connect, pick or fix, and while the card asks whether it is the right
          one (§45.37 G8): a new account, never Clip Factory's. A connected account that is fine does not say it again. */}
      {!connected || asking ? (
        <p className="st-note st-note--sky st-conn__new" role="note">
          <StIcon name="user" size={18} />
          {NEW_ACCOUNT_LINE}
        </p>
      ) : null}

      <Identity a={a} />
      {a.connectionStatus === "same_as_clips" ? (
        <p className="st-note st-note--coral" role="status">
          <StIcon name="alert" size={18} />
          {sameAsClipsLine(a)}
        </p>
      ) : null}
      {reasonText ? (
        <p className="st-note st-note--coral">
          <StIcon name="alert" size={18} />
          {reasonText}
        </p>
      ) : null}
      {a.connectionStatus === "connected" && a.reason === "expires_soon" ? (
        <p className="st-note st-note--sun">
          <StIcon name="alert" size={18} />
          {reasonSentence("expires_soon", p)}
          {a.reconnectBy ? ` Connect again before ${shortDate(a.reconnectBy)}.` : " Connect again soon."}
        </p>
      ) : null}
      {a.connectionStatus === "not_connected" && a.reason === "expired" ? (
        <p className="st-note st-note--sun">
          <StIcon name="alert" size={18} />
          {reasonSentence("expired", p)}
        </p>
      ) : null}
      {/* The server's warning is text only; when it says what the reason already said, it is said once (for Clip
          Factory's own account it is the line above). */}
      {a.warning &&
      a.connectionStatus !== "same_as_clips" &&
      a.warning.trim() !== reasonText &&
      !(connected && a.warning.trim() === reasonSentence("keys_changed", p)) ? (
        <>
          <p className="st-note st-note--coral" role="note">
            <StIcon name="alert" size={18} />
            {a.warning}
          </p>
          {/* A fix in Clip Factory (its Meta connection): the way there, right under the note (glass, never the main). */}
          {/\bin Clip Factory\b/.test(a.warning) ? (
            <div className="st-conn__actions">
              <StLinkButton href={`/settings/posting/setup/${p}`}>
                <StIcon name="external" size={18} />
                Open Clip Factory
              </StLinkButton>
            </div>
          ) : null}
        </>
      ) : null}
      {otherReason ? (
        <p className="st-note st-note--sun" role="note">
          <StIcon name="alert" size={18} />
          {otherReason}
        </p>
      ) : null}
      {a.missing.length ? (
        <p className="st-note st-note--sun">
          <StIcon name="alert" size={18} />
          Not allowed yet: {a.missing.join(", ")}. Connect again and tick every box.
        </p>
      ) : null}
      {/* Who can see the posts, and what can cost money: short, on the card; the whole lines are in More. */}
      {limitNotes(a.limits).map((n) => (
        <p key={n} className="st-note st-note--sun st-conn__limit" role="note">
          <StIcon name="alert" size={18} />
          {n}
        </p>
      ))}

      {a.connectionStatus === "choose_account" && a.choices?.length ? (
        <div className="st-choose">
          <p className="st-choose__ask">
            Pick the {name} {PLACE[p]} Clips Funded posts to:
          </p>
          <ul className="st-choose__list">
            {a.choices.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`st-choice${c.usedByClips ? " st-choice--clips" : ""}`}
                  disabled={busy !== null}
                  // Clip Factory's own is never picked (§45.37 G8): the tap says why and sends nothing.
                  aria-disabled={c.usedByClips || undefined}
                  onClick={() => {
                    if (c.usedByClips) {
                      toast.error(SAME_AS_CLIPS_LINE);
                      return;
                    }
                    // One toast per pick (§45.35 D21): Lamo Stories' own is asked "Is this your Lamo Stories {place}?"
                    // next, whose Yes cheers and says it once.
                    void run("choose", () => storiesApi().chooseSocial(ws, p, c.id)).then((ok) => {
                      if (ok) setPicked(true);
                    });
                  }}
                >
                  {c.avatarUrl ? <img src={c.avatarUrl} alt="" width={36} height={36} /> : <StIcon name="user" size={22} />}
                  <span className="st-choice__name">{c.name}</span>
                  {c.usedByClips ? <span className="st-chip st-chip--coral">Clip Factory's own</span> : <span className="st-choice__go">Use this</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!connected ? tipLine : null}

      {asking ? (
        <IntendedAsk
          a={a}
          busy={busy !== null}
          onYes={(el) => {
            celebrate(centerOf(el));
            toast.success(`Great! Clips Funded posts to ${thisPlace(a)}.`);
            setPicked(false);
            onAnswered?.();
          }}
          onAnother={() => {
            setPicked(false);
            onAnswered?.();
            void connect();
          }}
        />
      ) : !appReady ? (
        // The app comes first (§45.30): its button is the card's one main action, and the choice opens right under it.
        <>
          <div className="st-conn__actions">
            <StButton main={!setupOpen} aria-expanded={setupOpen} aria-controls={setupId} onClick={() => setSetupOpen((o) => !o)}>
              <StIcon name="key" size={18} />
              Set up the app
              <span className="sr-only"> for {name}</span>
            </StButton>
          </div>
          {setupOpen ? (
            <div className="st-conn__setup" id={setupId} style={MORE_BODY}>
              <AppPart ws={ws} a={a} meta={otherMeta} busy={busy} run={run} />
            </div>
          ) : null}
        </>
      ) : (
        <div className="st-conn__actions">
          <StButton main={connectIsMain} disabled={busy !== null} onClick={() => void connect()}>
            <StIcon name={a.connectionStatus === "not_connected" ? "plug" : "retry"} size={18} />
            {busy === "connect" ? "Opening…" : connectLabel}
          </StButton>
        </div>
      )}

      {/* Everything only sometimes needed, out of the way but one tap away (the owner, 23 Nov: less text). */}
      <details
        className="st-tech-fold st-conn__more"
        open={open}
        onToggle={(e) => {
          const now = e.currentTarget.open;
          setOpen(now);
          // A Disconnect still to answer never waits hidden in a closed fold.
          if (!now) setAsk(null);
        }}
      >
        <summary className="st-tech-fold__sum">
          <StIcon name="chevron" size={16} className="st-tech-fold__mark" />
          More
          <span className="sr-only"> for {name}</span>
        </summary>
        <div className="st-conn__more-body" style={MORE_BODY}>
          {a.connectionStatus !== "not_connected" ? (
            <dl className="st-auth">
              <div>
                <dt>Posting</dt>
                <dd>{status.auth}</dd>
              </div>
              <div>
                <dt>Last checked</dt>
                <dd>{a.lastCheckedAt ? relative(a.lastCheckedAt) : "Not checked yet"}</dd>
              </div>
              {a.connectedAt ? (
                <div>
                  <dt>Connected</dt>
                  <dd>{relative(a.connectedAt)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {/* The platform's own id for it (§45.36 E14). */}
          {a.externalAccountId ? (
            <p className="st-who__id">
              {name}'s ID: <code>{a.externalAccountId}</code>
            </p>
          ) : null}
          {connected ? tipLine : null}

          {ask ? (
            <div className="st-sure" role="group" aria-label="Are you sure?">
              <p className="st-sure__ask">
                <strong>Are you sure?</strong> Clips Funded stops posting to {thisPlace(a)}. Clip Factory is not touched.
              </p>
              <div className="st-sure__buttons">
                <StButton onClick={() => setAsk(null)}>No, keep it as it is</StButton>
                <StButton
                  main
                  className="st-btn--coral"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      "disconnect",
                      async () => {
                        await storiesApi().disconnectSocial(ws, p);
                        onDisconnected(p, a.app.choice);
                      },
                      { text: `${name} is disconnected from Clips Funded.` },
                    )
                  }
                >
                  Yes, disconnect
                </StButton>
              </div>
            </div>
          ) : canCheck || canDisconnect ? (
            <div className="st-conn__actions">
              {/* Not while a Page or account is still to be picked: there is nothing to check yet (the API's 409, §45.35 D21). */}
              {canCheck ? (
                <StButton
                  disabled={busy !== null}
                  onClick={(e) => {
                    const el = e.currentTarget;
                    void run("check", async () => {
                      const after = await storiesApi().checkSocial(ws, p);
                      if (after.connectionStatus === "connected") {
                        celebrate(centerOf(el));
                        toast.success(`${name} answered. All good.`);
                      } else if (after.connectionStatus === "needs_reconnect") toast.error(reasonSentence(after.reason, p));
                      else toast.info(`${name} answered. Check the card for what is next.`);
                    });
                  }}
                >
                  <StIcon name="retry" size={18} />
                  {busy === "check" ? "Checking…" : "Check now"}
                </StButton>
              ) : null}
              {canDisconnect ? (
                <StButton quiet disabled={busy !== null} onClick={() => setAsk({ kind: "disconnect" })}>
                  Disconnect
                </StButton>
              ) : null}
            </div>
          ) : null}

          {appReady ? <AppPart ws={ws} a={a} meta={otherMeta} busy={busy} run={run} /> : null}

          {/* Beside what the platform allows: the two apps' accounts differ (§45.13). */}
          <p className="st-conn__clips">
            <span className="st-conn__clips-label">Clip Factory posts to:</span> {clips?.connected ? (clips.name ?? `its own ${PLACE[p]}`) : `no ${name} yet`}
          </p>
          {limits.length ? <Limits name={name} limits={limits} /> : null}
        </div>
      </details>
    </li>
  );
}

/** What the platform allows for a second account: the plain lines, and its developer words one tap away (§45.36 E14). */
function Limits({ name, limits }: { name: string; limits: string[] }) {
  const { plain, tech } = plainFirst(limits);
  return (
    <div className="st-limits">
      <h3 className="st-limits__title">What {name} allows for a second account</h3>
      {plain.length ? (
        <ul className="st-limits__list">
          {plain.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="st-limits__plain">{name} checks a new app before everyone can use it.</p>
      )}
      {tech.length ? (
        <StTech>
          <ul>
            {tech.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </StTech>
      ) : null}
    </div>
  );
}

/** The setup's place on these pages: while it is not finished, a way back to it (the owner may come back from OAuth). */
export function SetupBack({ ws }: { ws: string }) {
  const { data } = useOnboarding(ws);
  if (!data || data.finishedAt) return null;
  return (
    <aside className="st-setupback st-glass st-glass--hero st-lens" aria-label="Setting up Clips Funded">
      <ArcDial className="st-setupback__dial" value={data.done} max={data.total} label={`${data.done} of ${data.total} done`} valueText={`${data.done} of ${data.total} done`}>
        <span className="st-setupback__num st-num">{data.done}</span>
        <span className="st-setupback__of">of {data.total}</span>
      </ArcDial>
      {/* The dial beside it says how far: the words do not say it again. */}
      <p className="st-setupback__text">
        <strong>Setting up Clips Funded</strong>
      </p>
      <StLinkButton href="/stories/setup" className="st-setupback__go">
        Back to setup
        <StIcon name="chevron" size={18} />
      </StLinkButton>
    </aside>
  );
}

// ---------- The cards in columns by their own height (§45.36 E18: the list page has rows now; the pure helpers stay) ----------

/** The narrowest a card's column gets, and the space between cards (both as in stories.css). */
const CARD_MIN = 340;
const CARD_GAP = 16;
/** How many columns of at least CARD_MIN fit in `width` (as `repeat(auto-fill, minmax(340px, 1fr))` gives). */
export function columnsFor(width: number): number {
  return Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN + CARD_GAP)));
}

/** Each card's column (0-based), in page order: each goes into the shortest column so far, so no column is left short. */
export function shortestColumns(heights: number[], columns: number): number[] {
  const bottoms = Array.from({ length: Math.max(1, columns) }, () => 0);
  return heights.map((h) => {
    const k = bottoms.indexOf(Math.min(...bottoms));
    bottoms[k] = bottoms[k]! + h + CARD_GAP;
    return k;
  });
}

/** Where each column ends (the cards in it and a gap under each) for the cards dealt as `at`. */
export function columnBottoms(heights: number[], at: number[], columns: number): number[] {
  const bottoms = Array.from({ length: Math.max(1, columns) }, () => 0);
  heights.forEach((h, i) => {
    bottoms[at[i]!] = bottoms[at[i]!]! + h + CARD_GAP;
  });
  return bottoms;
}

/** The empty area under the shortest column: how far the tallest column runs on past it. */
export function emptyUnder(heights: number[], at: number[], columns: number): number {
  const b = columnBottoms(heights, at, columns);
  return Math.max(...b) - Math.min(...b);
}

/** More ways to deal the cards than this and the shortest-column deal is used as it is (a page has five cards). */
const MOST_DEALS = 20_000;

/**
 * The cards in `columns` columns so the columns end as close together as they can (the least empty area under the
 * shortest one; then the shortest page): every way of dealing them is tried (the five cards in three columns are 243
 * ways), each card staying in page order within its column. A tall card is never left beside two short columns' empty
 * halves, whatever the fonts make of the cards' heights.
 */
export function balancedColumns(heights: number[], columns: number): number[] {
  const k = Math.max(1, columns);
  const greedy = shortestColumns(heights, k);
  if (k === 1 || heights.length < 2 || k ** heights.length > MOST_DEALS) return greedy;
  let best = greedy;
  let bestEmpty = emptyUnder(heights, greedy, k);
  let bestTall = Math.max(...columnBottoms(heights, greedy, k));
  const at = heights.map(() => 0);
  const walk = (i: number) => {
    if (i === heights.length) {
      // Every column holds a card (an empty column would be a hole of its own).
      if (new Set(at).size < Math.min(k, heights.length)) return;
      const b = columnBottoms(heights, at, k);
      const empty = Math.max(...b) - Math.min(...b);
      const tall = Math.max(...b);
      if (empty < bestEmpty - 0.5 || (Math.abs(empty - bestEmpty) <= 0.5 && tall < bestTall - 0.5)) {
        best = [...at];
        bestEmpty = empty;
        bestTall = tall;
      }
      return;
    }
    for (let c = 0; c < k; c++) {
      at[i] = c;
      walk(i + 1);
    }
  };
  walk(0);
  return best;
}

/**
 * How many columns, and which card in each: of the column counts that fit (two up to `most`), the one whose best deal
 * leaves the least empty area, measured with each card's own height at that count's width (`heightsAt`); on a tie, more
 * columns. Five cards cannot fill three columns evenly, so where two columns of wider (shorter) cards leave less empty
 * area, two it is.
 */
export function pickColumns(heightsAt: (columns: number) => number[], most: number): { columns: number; at: number[] } {
  let best: { columns: number; at: number[]; empty: number } | null = null;
  for (let k = 2; k <= Math.max(2, most); k++) {
    const h = heightsAt(k);
    const at = balancedColumns(h, k);
    const empty = emptyUnder(h, at, k);
    if (!best || empty < best.empty - 0.5 || (Math.abs(empty - best.empty) <= 0.5 && k > best.columns)) best = { columns: k, at, empty };
  }
  return { columns: best!.columns, at: best!.at };
}

/** The five cards and what they need, shared by this page and the setup's connect steps. */
export function useSocial(ws: string) {
  return useLoad(() => storiesApi().social(ws), ws, "st-social");
}

/**
 * Social accounts (`/stories/connections`): the header card, the way back to the setup, how many places are ready, and
 * one row per platform, each opening its own page (SocialPlatform.tsx), with its Skip (asked first) or Un-skip.
 */
export function ConnectionsScreen({ ws, page }: StoriesScreenProps) {
  const social = useSocial(ws);
  const skips = useSkip(ws, social.reload);
  // A Social accounts page that still names a platform (only one built by hand: the router opens the platform's own
  // page for the OAuth landing) goes to that page, with what it has to say.
  let goTo: string | null = null;
  if (page.name === "connections" && isPlatform(page.platform)) {
    const q = new URLSearchParams();
    if (page.result) q.set("result", page.result);
    if (page.ws) q.set("ws", page.ws);
    const qs = q.toString();
    goTo = `${socialHref(page.platform)}${qs ? `?${qs}` : ""}`;
  }
  useEffect(() => {
    if (goTo) navigate(goTo, { replace: true });
  }, [goTo]);

  return (
    <section className="st-page st-connections st-social">
      <SocialHead />
      <SetupBack ws={ws} />
      {social.error && !social.data ? (
        <StError message={social.error} onRetry={() => void social.reload()} />
      ) : !social.data ? (
        <StLoading label="Checking the accounts…" />
      ) : (
        <>
          <SocialProgress accounts={social.data.accounts} />
          <SocialRowList accounts={social.data.accounts} busy={skips.busy !== null} onSkip={skips.skip} onUnskip={skips.unskip} />
        </>
      )}
    </section>
  );
}

/** The note shown after a Disconnect (this page and the setup's connect steps), for the app the account used. */
export function DisconnectedNote({ choice, onClose }: { choice: SocialAccount["app"]["choice"]; onClose: () => void }): ReactNode {
  return (
    <p className="st-note st-note--sky st-note--wide" role="status">
      <StIcon name="bulb" size={18} />
      {afterDisconnect(choice)}
      <button type="button" className="st-note__close" aria-label="Hide this note" onClick={onClose}>
        <StIcon name="close" size={18} />
      </button>
    </p>
  );
}
