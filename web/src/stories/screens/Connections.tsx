// Lamo Stories › Social accounts (docs/CONTRACTS.md §45.13, §45.16.7, §45.30, §45.33): Lamo Stories' own social
// accounts, separate from Clip Factory's. Five cards (YouTube, TikTok, Instagram, Facebook, X), each with the
// platform's logo mark, its status, the account's name AND id, the authorization status and when it was last checked
// (Check now), Connect / Reconnect / Pick another / Disconnect, what the platform allows for a second account, the
// sign-in and Pages notes before Connect, the account's warning, and Clip Factory's own destination for that platform
// so the owner sees they differ.
//
// The owner's hard rule (§45.37 G8): Clip Stories never posts to Clip Factory's own accounts, so there is no
// "Use it for both" any more. Every card says up front to use a new account made for Clip Stories; an account
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
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { storiesSound } from "../prefs.ts";
import { storiesApi } from "../api/client.ts";
import { SHARED_APP_PLATFORMS, type ClipsDestination, type KeyCheck, type Platform, type SocialAccount } from "../api/types.ts";
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
  StPageHead,
  StPick,
  StRing,
  StTech,
  plainFirst,
  useOnboarding,
  type StTone,
} from "../ui.tsx";
import type { StoriesScreenProps } from "./types.ts";

/** What one connection is on each platform: a channel, a Page or an account. */
export const PLACE: Record<Platform, string> = { youtube: "channel", tiktok: "account", instagram: "account", facebook: "Page", x: "account" };

/** Said before Connect (and before Reconnect, which connects again): §45.13.2, per developer app. */
export function beforeConnect(p: Platform, choice: SocialAccount["app"]["choice"]): string {
  switch (p) {
    case "youtube":
      return "Google will ask which channel. Pick your Clip Stories channel.";
    case "tiktok":
      return "Sign in to your Clip Stories account on tiktok.com in this browser first. TikTok connects the account that is signed in.";
    case "x":
      return "First sign in to your Clip Stories account on x.com in this browser. X connects the account that is signed in.";
    default:
      // Facebook and Instagram always go through Lamo Stories' own Meta app (§45.30), whatever `choice` says.
      void choice;
      return "Facebook will ask which Pages this app may use. Tick only your Clip Stories Page.";
  }
}

/** Said up front on every card and Connect step (§45.37 G8, the owner's hard rule): a new account, never Clip Factory's. */
export const NEW_ACCOUNT_LINE = "Use a new account made for Clip Stories, not Clip Factory's.";
/** The shared developer app's promise (§45.37 G6): Clip Factory's posts are never squeezed out. */
export const SHARED_APP_LINE = "Clip Factory's posts always go first. Clip Stories uses what's left.";
/** Sharing the app never means sharing the account (§45.37 G8 (c)). */
export const SHARED_APP_ACCOUNT_LINE = "Even with Clip Factory's app, sign in with a different account made for Clip Stories.";
/** The account just signed in with is Clip Factory's own (§45.37 G8 (c)). */
export const SAME_AS_CLIPS_LINE = "This is Clip Factory's own account. Clip Stories needs its own separate account: sign in with a different one.";
/** Clip Factory connected this very account later (the API's reason clips_now): it is blocked from posting (§45.37 G8 (a)). */
export const CLIPS_LATER_LINE = "This is Clip Factory's account now. Connect a different account made for Clip Stories.";

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
  "To remove Clip Stories completely, remove your Clip Stories app in the account's own settings. Clip Factory is not affected.";

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
  connected: { label: "Connected", tone: "mint", auth: "Allowed: Clip Stories may post here." },
  choose_account: { label: "Pick one", tone: "sun", auth: "Allowed, but pick where Clip Stories posts first." },
  needs_reconnect: { label: "Connect again", tone: "coral", auth: "Stopped: the sign-in needs renewing. Tap Reconnect." },
  same_as_clips: { label: "Clip Factory's own", tone: "coral", auth: "Stopped: Clip Stories never posts to Clip Factory's own account." },
  not_connected: { label: "Not connected", tone: "sky", auth: "Not allowed yet: nothing is connected." },
};

/** The callback's result code (§17.5's codes plus same_as_clips and clips_meta_check) in plain words. */
export function resultSentence(code: string, p: Platform): { text: string; good: boolean } {
  const name = PLATFORM_NAME[p];
  switch (code) {
    case "connected":
      return { text: `${name} is connected to Clip Stories!`, good: true };
    case "choose":
      return { text: `Now pick the ${name} ${PLACE[p]} Clip Stories posts to.`, good: true };
    case "same_as_clips":
      return { text: SAME_AS_CLIPS_LINE, good: false };
    case "clips_meta_check":
      return { text: `${name} is connected. But Clip Factory may have lost ${name}: connect it again in Clip Factory, keeping its Page ticked.`, good: false };
    case "denied":
      return { text: `You pressed cancel. Tap Connect ${name} to try again.`, good: false };
    case "expired":
      return { text: "That took too long. Tap Connect again.", good: false };
    case "keys_wrong":
      return { text: `${name} did not accept the app keys. Check them on this page, then connect again.`, good: false };
    case "redirect_wrong":
      return { text: `The return address does not match. Copy the address on this page into your ${name} app's settings, then connect again.`, good: false };
    case "missing_permissions":
      return { text: "A permission box was not ticked. Connect again and tick every box.", good: false };
    case "no_channel":
      return { text: "This Google account has no YouTube channel. Make the Clip Stories channel first, then connect again.", good: false };
    case "no_accounts":
    case "wrong_account_type":
      return { text: "Instagram did not show a professional account. Make one, link it to a Facebook Page, then connect again.", good: false };
    case "no_pages":
      return { text: "Facebook did not show a Page you run. Make the Clip Stories Page first, then connect again.", good: false };
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
      return `Clip Stories' ${name} sign-in stopped working. Connect again.`;
    case "expires_soon":
      return `Clip Stories' ${name} sign-in ends soon.`;
    case "signed_out_90_days":
      return `${name} signs Clip Stories out after 90 days. Connect again.`;
    case "missing_permissions":
      return "A permission box was not ticked. Connect again and tick every box.";
    case "expired":
      return `That took too long. Tap Connect ${name} again.`;
    case "clips_unknown":
      return `Clip Stories cannot tell this ${name} account apart from Clip Factory's own. Check which account is signed in.`;
    case "clips_now":
      return CLIPS_LATER_LINE;
    default:
      return `Clip Stories' ${name} needs connecting again.`;
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

/** Every own-app list ends with where its keys go: here, never into Clip Factory's guide (whose keys are its own). */
const PASTE_HERE = "Paste its keys in the boxes below, never in Clip Factory.";

/** What a separate developer app means on each platform, in plain words (the differences from Clip Factory's guide). */
const OWN_APP_NOTES: Record<Platform, string[]> = {
  youtube: [
    "Make a new project in Google Cloud and give its app its own name, for example Clip Stories.",
    "Copy the address below into your app's settings (not Clip Factory's).",
    "Its uploads per day are its own.",
    PASTE_HERE,
  ],
  tiktok: [
    "Make a new app on TikTok for Developers, named for example Clip Stories.",
    "Copy the address below into your app's settings (not Clip Factory's).",
    "TikTok checks every new app before posts can be public. That can take days to weeks.",
    PASTE_HERE,
  ],
  instagram: [
    "Make one new Meta app for Clip Stories. It serves Instagram and Facebook: its keys are entered once.",
    "Copy both addresses below into your Meta app's settings, and make a sign-in setup there. Its number goes in the last box.",
    "At first only you can connect. Meta checks the app before anyone else can.",
    PASTE_HERE,
  ],
  facebook: [
    "Make one new Meta app for Clip Stories. It serves Instagram and Facebook: its keys are entered once.",
    "Copy both addresses below into your Meta app's settings, and make a sign-in setup there. Its number goes in the last box.",
    "At first only you can connect. Meta checks the app before anyone else can.",
    PASTE_HERE,
  ],
  x: [
    "Make a new app in the X Developer Portal, named for example Clip Stories.",
    "Copy the address below into your app's settings (not Clip Factory's).",
    "It needs its own X credits.",
    PASTE_HERE,
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
export const KEYS_HERE_ONLY =
  "Only read the steps there. Paste the new app's keys here on this page, never in Clip Factory's guide: its keys step changes Clip Factory's own app.";

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
        {/* The platform's own id for it, one tap away (§45.36 E14). */}
        {a.externalAccountId ? (
          <StTech className="st-who__tech">
            <span className="st-who__id">
              {PLATFORM_NAME[a.platform]}'s ID for it: <code>{a.externalAccountId}</code>
            </span>
          </StTech>
        ) : null}
      </div>
    </div>
  );
}

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
      {check.ok && check.account === "dead" ? " But Clip Stories' sign-in to the account stopped working: tap Reconnect." : ""}
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
      <p className="st-keys__ask">Paste the keys of your Clip Stories {appName} app:</p>
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
      <p className="st-keys__safe">The keys go straight to Clip Stories' own safe store. They never show here again.</p>
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
      ? "Clip Stories' Instagram and Facebook"
      : connected
        ? `Clip Stories' ${name}`
        : otherConnected
          ? `Clip Stories' ${PLATFORM_NAME[meta!.platform]}`
          : null
    : connected
      ? `Clip Stories' ${name}`
      : null;

  return (
    <div className="st-app" data-app={choice ?? "none"}>
      <h3 className="st-app__title">
        <StIcon name="key" size={18} />
        {isMeta(p) ? "Developer app: Clip Stories' own Meta app" : `Developer app for ${name}`}
      </h3>
      {!showChoice ? (
        <>
          <p className="st-app__now">
            {choice === "clips" ? (
              <>
                Shares <strong>Clip Factory's {name} app</strong>, on purpose. {SHARED_APP_LINE} Clip Stories still gets its own
                sign-in and its own keys to the account, never Clip Factory's. {SHARED_APP_ACCOUNT_LINE}
              </>
            ) : (
              <>
                Uses <strong>its own {isMeta(p) ? "Meta" : name} app</strong>: fully separate from Clip Factory. Its keys are saved.
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
                {isMeta(p)
                  ? "Copy these two addresses into your Meta app's settings, so Instagram and Facebook can each come back here."
                  : `Copy this address into your ${name} app's settings.`}
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
                      text: isMeta(p) ? "The Meta app keys are removed from Clip Stories, for Instagram and Facebook." : `The ${name} app keys are removed from Clip Stories.`,
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
              <p className="st-app__ask">Which {name} app should Clip Stories use? You pick once; you can change it later.</p>
              <StPick<"own" | "clips">
                label={`Which ${name} app Clip Stories uses`}
                stack
                value={(want ?? "none") as "own" | "clips"}
                options={[
                  { value: "own", label: "A separate app for Clip Stories", line: "Fully separate. You make a second app and paste its keys here." },
                  { value: "clips", label: "Share Clip Factory's app", line: `${SHARED_APP_LINE} ${SHARED_APP_ACCOUNT_LINE}` },
                ]}
                onChange={(v) => setPicking(v)}
              />
            </>
          ) : (
            <p className="st-app__ask">
              {name} always uses Clip Stories' own Meta app, so Clip Factory's Meta connection is never touched.
            </p>
          )}
          {want === "clips" ? (
            <div className="st-app__go">
              {connected && choice !== "clips" ? <p className="st-app__warn">Switching apps disconnects Clip Stories' {name} first. Clip Factory is not touched.</p> : null}
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
                      { text: `Clip Stories shares Clip Factory's ${name} app. Now tap Connect ${name} and sign in with the Clip Stories account.`, cheer: el },
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
                <p>Every other step is the same as in Clip Factory's own guide. It opens in Clip Factory: come back here with the switcher.</p>
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
    <div className="st-intended" role="group" aria-label={`Is this your Clip Stories ${place}?`}>
      <p className="st-intended__said" role="status">
        <StIcon name="check" size={18} />
        {connectedAsSentence(a)}.
      </p>
      <p className="st-intended__ask">
        <strong>Is this your Clip Stories {place}?</strong> Clip Stories posts only here, never to Clip Factory's.
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
  const appReady = a.app.choice === "clips" || (a.app.choice === "own" && a.app.saved);
  const connected = a.connectionStatus === "connected";
  // A connected YouTube changes channel by connecting again (Google asks which one, §45.13.5): its button says so,
  // as its limits line does ("To change it, tap Pick another channel.").
  const connectLabel =
    a.connectionStatus === "not_connected"
      ? `Connect ${name}`
      : a.connectionStatus === "same_as_clips" || a.connectionStatus === "choose_account" || (p === "youtube" && connected)
        ? `Pick another ${PLACE[p]}`
        : "Reconnect";
  const reasonText = a.connectionStatus === "needs_reconnect" ? reasonSentence(a.reason, p) : null;
  // Any other code is said in words too (the two with their own lines below excepted); the server's warning, when
  // there is one, already says it.
  const otherReason =
    a.reason && a.connectionStatus !== "needs_reconnect" && a.connectionStatus !== "same_as_clips" && a.reason !== "expires_soon" && a.reason !== "expired" && !a.warning ? reasonSentence(a.reason, p) : null;

  return (
    <li className={`st-conn st-conn--${a.connectionStatus}`} data-platform={p}>
      <header className="st-conn__head">
        <span className={`st-conn__mark st-conn__mark--${p}`}>
          <PlatformMark platform={p} size={26} title={`${name} logo`} />
        </span>
        <h2 className="st-conn__name">{name}</h2>
        <span className={`st-chip st-chip--${status.tone}`}>{status.label}</span>
      </header>
      {/* Up front, before anything is connected (§45.37 G8): a new account, never Clip Factory's. */}
      <p className="st-note st-note--sky st-conn__new" role="note">
        <StIcon name="user" size={18} />
        {NEW_ACCOUNT_LINE}
      </p>

      <Identity a={a} />
      <dl className="st-auth">
        <div>
          <dt>Authorization</dt>
          <dd>{status.auth}</dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>{a.lastCheckedAt ? relative(a.lastCheckedAt) : a.connectionStatus === "not_connected" ? "Not connected yet" : "Not checked yet"}</dd>
        </div>
      </dl>
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
        <p className="st-note st-note--coral" role="note">
          <StIcon name="alert" size={18} />
          {a.warning}
        </p>
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

      {a.connectionStatus === "choose_account" && a.choices?.length ? (
        <div className="st-choose">
          <p className="st-choose__ask">
            Pick the {name} {PLACE[p]} Clip Stories posts to:
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

      <p className="st-conn__clips">
        <span className="st-conn__clips-label">Clip Factory posts to:</span> {clips?.connected ? (clips.name ?? `its own ${PLACE[p]}`) : `no ${name} yet`}
      </p>

      <AppPart ws={ws} a={a} meta={otherMeta} busy={busy} run={run} />

      {appReady && a.connectionStatus !== "choose_account" ? (
        <p className="st-conn__before">
          <StIcon name="bulb" size={18} />
          {beforeConnect(p, a.app.choice)}
        </p>
      ) : null}

      {(askIntended || picked) && connected && !ask ? (
        <IntendedAsk
          a={a}
          busy={busy !== null}
          onYes={(el) => {
            celebrate(centerOf(el));
            toast.success(`Great! Clip Stories posts to ${thisPlace(a)}.`);
            setPicked(false);
            onAnswered?.();
          }}
          onAnother={() => {
            setPicked(false);
            onAnswered?.();
            void connect();
          }}
        />
      ) : ask ? (
        <div className="st-sure" role="group" aria-label="Are you sure?">
          <p className="st-sure__ask">
            <strong>Are you sure?</strong> Clip Stories stops posting to {thisPlace(a)}. Clip Factory is not touched.
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
                  { text: `${name} is disconnected from Clip Stories.` },
                )
              }
            >
              Yes, disconnect
            </StButton>
          </div>
        </div>
      ) : (
        <div className="st-conn__actions">
          {/* Not while a Page or account is still to be picked: there is nothing to check yet (the API's 409, §45.35 D21). */}
          {a.connectionStatus !== "not_connected" && a.connectionStatus !== "choose_account" ? (
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
          {a.connectionStatus !== "not_connected" ? (
            <StButton quiet disabled={busy !== null} onClick={() => setAsk({ kind: "disconnect" })}>
              Disconnect
            </StButton>
          ) : null}
          <StButton
            main={appReady && (!connected || a.connectionStatus === "needs_reconnect")}
            disabled={busy !== null}
            aria-disabled={!appReady || undefined}
            title={appReady ? undefined : a.app.choice === null && SHARED_APP_PLATFORMS.includes(p) ? "Pick the app first" : "Save the keys first"}
            onClick={() => {
              if (!appReady) {
                // The deny sound comes from the global click handler (aria-disabled); the toast says what is first.
                toast.error(
                  a.app.choice === null && SHARED_APP_PLATFORMS.includes(p) ? `Pick which ${name} app Clip Stories uses first.` : `Paste your Clip Stories ${isMeta(p) ? "Meta" : name} app keys first.`,
                );
                return;
              }
              void connect();
            }}
          >
            <StIcon name={a.connectionStatus === "not_connected" ? "plug" : "retry"} size={18} />
            {busy === "connect" ? "Opening…" : connectLabel}
          </StButton>
        </div>
      )}

      {a.limits.length ? <Limits name={name} limits={a.limits} /> : null}
      {a.connectedAt && a.connectionStatus !== "not_connected" ? <p className="st-conn__since">Connected {relative(a.connectedAt)}.</p> : null}
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

/** The setup's place on this page: while it is not finished, a way back to it (the owner may come back from OAuth). */
function SetupBack({ ws }: { ws: string }) {
  const { data } = useOnboarding(ws);
  if (!data || data.finishedAt) return null;
  return (
    <aside className="st-setupback" aria-label="Setting up Clip Stories">
      <StRing done={data.done} total={data.total} size={52} />
      <p className="st-setupback__text">
        <strong>Setting up Clip Stories:</strong> {data.done} of {data.total} done.
      </p>
      <StLinkButton href="/stories/setup" className="st-setupback__go">
        Back to setup
        <StIcon name="chevron" size={18} />
      </StLinkButton>
    </aside>
  );
}

// ---------- The cards in columns by their own height (§45.36 E18) ----------

/** The narrowest a card's column gets, and the space between cards (both as in stories.css). */
const CARD_MIN = 340;
const CARD_GAP = 16;
/** The grid's row step (px): each card spans as many of these as its height and the gap below it. */
const ROW_STEP = 1;

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

/**
 * Lays the list's cards out in columns by their own height. Each card keeps its column while the page is open (a
 * card that grows, as Change app does, only pushes the cards under it in that column), and the columns are dealt
 * again only when the number of columns that fit changes or the cards do. The cards stay in page order, so Tab goes
 * as before.
 */
function useCardColumns(list: { current: HTMLUListElement | null }, keys: string, on: boolean): void {
  useLayoutEffect(() => {
    const ul = list.current;
    if (!on || !ul || typeof ResizeObserver === "undefined") return;
    let dealt: { most: number; columns: number; at: number[] } | null = null;
    let frame = 0;
    const cards = () => Array.from(ul.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
    /** Each card's own height were it as wide as one of `columns` columns (measured, then put back). */
    const heightsAt = (all: HTMLElement[], columns: number) => {
      const w = (ul.clientWidth - CARD_GAP * (columns - 1)) / columns;
      const was = all.map((c) => c.style.width);
      for (const c of all) c.style.width = `${w}px`;
      const heights = all.map((c) => c.getBoundingClientRect().height);
      all.forEach((c, i) => (c.style.width = was[i]!));
      return heights;
    };
    const layout = () => {
      // Not while Lamo Stories is hidden behind Clip Factory (nothing has a size): it stays as it was for the way back.
      if (!ul.clientWidth) return;
      const all = cards();
      const most = columnsFor(ul.clientWidth);
      if (most < 2 || all.length < 2) {
        delete ul.dataset.cols;
        for (const c of all) c.style.removeProperty("--st-col");
        dealt = null;
        return;
      }
      if (!dealt || dealt.most !== most || dealt.at.length !== all.length) dealt = { most, ...pickColumns((k) => heightsAt(all, k), most) };
      ul.dataset.cols = String(dealt.columns);
      ul.style.setProperty("--st-cols", String(dealt.columns));
      // Its own height at the width it has now (its rise-in animation only moves it, never sizes it).
      const heights = all.map((c) => c.getBoundingClientRect().height);
      all.forEach((c, i) => {
        c.style.setProperty("--st-col", String(dealt!.at[i]! + 1));
        c.style.setProperty("--st-span", String(Math.ceil((heights[i]! + CARD_GAP) / ROW_STEP)));
      });
    };
    const soon = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layout);
    };
    const ro = new ResizeObserver(soon);
    ro.observe(ul);
    for (const c of cards()) ro.observe(c);
    layout();
    // The page's own fonts arrive after the first paint and change the cards' heights: dealt again once.
    let fresh = true;
    const stopFresh = () => {
      fresh = false;
    };
    ul.addEventListener("pointerdown", stopFresh, true);
    ul.addEventListener("keydown", stopFresh, true);
    void document.fonts?.ready?.then(() => {
      if (!fresh) return;
      dealt = null;
      soon();
    });
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      ul.removeEventListener("pointerdown", stopFresh, true);
      ul.removeEventListener("keydown", stopFresh, true);
      delete ul.dataset.cols;
      for (const c of cards()) {
        c.style.removeProperty("--st-col");
        c.style.removeProperty("--st-span");
      }
    };
  }, [list, keys, on]);
}

/** The five cards and what they need, shared by this page and the setup's connect steps. */
export function useSocial(ws: string) {
  return useLoad(() => storiesApi().social(ws), ws, "st-social");
}

export function ConnectionsScreen({ ws, page }: StoriesScreenProps) {
  const toast = useToast();
  const social = useSocial(ws);
  const { reload, setData } = social;
  const [gone, setGone] = useState<{ platform: Platform; choice: SocialAccount["app"]["choice"] } | null>(null);
  // The platform just connected: its card asks whether this is the intended account (§45.34).
  const [asking, setAsking] = useState<Platform | null>(null);
  const shown = useRef<string | null>(null);
  const cardList = useRef<HTMLUListElement | null>(null);
  useCardColumns(cardList, social.data ? social.data.accounts.map((a) => a.platform).join(" ") : "", !!social.data);
  const result = page.name === "connections" ? page.result : null;
  const platform = page.name === "connections" ? page.platform : null;

  // The callback's result, once, then the address goes back to plain Social accounts (a reload never repeats it). A
  // connect is said with the account it connected ("Connected as {name} ({handle})"), read fresh from the server.
  useEffect(() => {
    // Back on plain Social accounts: the next landing (a second Connect from this page) is shown again.
    if (!result || !isPlatform(platform)) {
      shown.current = null;
      return;
    }
    const key = `${platform}|${result}`;
    if (shown.current === key) return;
    shown.current = key;
    const { text, good } = resultSentence(result, platform);
    const cheerUp = () => {
      celebrate(undefined, false);
      storiesSound("success", { onNextTap: true });
    };
    if (result === "connected" || result === "clips_meta_check") {
      // Both are a connect (clips_meta_check also warns about Lamo Clips' own Meta connection): the card asks.
      const said = () => (good ? toast.success(text) : toast.error(text));
      void storiesApi()
        .social(ws)
        .then((fresh) => {
          setData(() => fresh);
          const a = fresh.accounts.find((x) => x.platform === platform);
          if (a && a.connectionStatus === "connected" && (a.accountName || a.handle)) {
            if (good) toast.success(`${connectedAsSentence(a)}.`);
            else said();
            setAsking(platform);
          } else said();
          if (good) cheerUp();
        })
        .catch(() => {
          said();
          void reload();
        });
    } else {
      if (good) {
        toast.success(text);
        cheerUp();
      } else toast.error(text);
      void reload();
    }
    void refreshDashboard(ws).catch(() => undefined);
    void refreshOnboarding(ws).catch(() => undefined);
    navigate("/stories/connections", { replace: true });
  }, [result, platform, toast, reload, setData, ws]);

  return (
    <section className="st-page st-connections">
      <StPageHead
        title="Social accounts"
        lede="Clip Stories posts only to the accounts you connect here. They are separate from Clip Factory's accounts, which stay as they are."
      />
      <SetupBack ws={ws} />
      {gone ? <DisconnectedNote choice={gone.choice} onClose={() => setGone(null)} /> : null}
      {social.error && !social.data ? (
        <StError message={social.error} onRetry={() => void social.reload()} />
      ) : !social.data ? (
        <StLoading label="Checking the accounts…" />
      ) : (
        <ul className="st-conns" ref={cardList}>
          {social.data.accounts.map((a) => (
            <PlatformCard
              key={a.platform}
              ws={ws}
              a={a}
              all={social.data!.accounts}
              clips={social.data!.clips.find((c) => c.platform === a.platform)}
              onChanged={social.reload}
              onDisconnected={(p, choice) => setGone({ platform: p, choice })}
              askIntended={asking === a.platform}
              onAnswered={() => setAsking(null)}
            />
          ))}
        </ul>
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
