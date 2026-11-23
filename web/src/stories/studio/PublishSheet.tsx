// Post it (docs/CONTRACTS.md §45.14, §45.16.6, §17.8): the publish sheet of an approved Lamo Stories video. It lists
// ONLY this workspace's connected social accounts, each with its name; nothing is chosen until the owner taps it (there
// is no default account). "Use my settings" applies the owner's preset in one tap (everyone can see it, comments, duets
// and stitches on, never made for kids); More details opens every option. TikTok follows its rules: who can see it is
// picked from a dropdown with no default (TikTok's own choices for this account), and Comments, Duet and Stitch are
// shown and start off. An account that is not connected (or needs connecting again) only offers Connect in Social
// accounts. Each chosen place shows the exact account the video goes to (name, handle and id) with Check now
// (a live check with the platform, §45.16.7); Upload checks every chosen account that was not checked in the sheet and
// stops, saying what changed, when one is no longer connected or is now a different account. When the API answers 409
// naming an account (it changed, or Lamo Stories cannot tell this TikTok from Clip Factory's own; `error.account`,
// §45.34), the sheet asks "Post to {name}?" with the account shown and, on Yes, sends the same request again with
// `confirmAccount` for that place. After Upload, the sheet shows each publishing job's status, its sentence and Try
// again, and "Posted!" gets Lamo Stories' star burst and success cheer, as Approve does (§45.36 E11). Account ids sit
// behind "Technical details" (§45.36 E14); an account problem offers "Open Social accounts" (§45.36 E9); the other
// app is always "Clip Factory" (§45.36 E13).
import { useEffect, useId, useMemo, useState } from "react";
import { Dropdown } from "../../components/Dropdown.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { A } from "../../components/ui.tsx";
import type { TikTokCreator as ClipsTikTokCreator } from "../../api/types.ts";
import {
  BRANDED_PRIVATE_LINE,
  brandedBlocked,
  choicesReady,
  myTikTokChoices,
  NO_TIKTOK_CHOICES,
  onlyPrivateAllowed,
  orderedPrivacy,
  PICK_WHOSE,
  PRIVACY_LABEL,
  privacyChoices,
  tiktokLabel,
  tiktokOptions,
  tooLongForTikTok,
  type TikTokChoices,
} from "../../lib/tiktokChoices.ts";
import { storiesApi } from "../api/client.ts";
import { STORIES_PLATFORMS, type ErrorAccount, type Platform, type PublishOptions, type PublishingJob, type PublishTarget, type SocialAccount, type StoriesConfig, type Story, type TikTokCreator } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { Busy, celebrate, Notice, Pick, StSheet, Switch, TechDetails } from "./kit.tsx";
import { PostRow, SocialAccountsLink, waitingLine } from "./PostsPanel.tsx";
import { accountOf, accountProblem, accountShown, ago, PLATFORM_LABEL, say, thisAccount } from "./words.ts";

type YouTubeOptions = { privacy: "public" | "unlisted" | "private"; category: string; notifySubscribers: boolean };

/** The owner's own post settings for Lamo Stories (his standing preferences; Clip Factory's preset never applies). */
export const MY_TIKTOK = { privacy: "PUBLIC_TO_EVERYONE", comments: true, duet: true, stitch: true };

export const YOUTUBE_CATEGORIES: { id: StoriesConfig["youtubeCategory"]; label: string }[] = [
  { id: "1", label: "Film & Animation" },
  { id: "2", label: "Autos & Vehicles" },
  { id: "23", label: "Comedy" },
  { id: "24", label: "Entertainment" },
  { id: "27", label: "Education" },
];

const WHO: { value: YouTubeOptions["privacy"]; label: string }[] = [
  { value: "public", label: "Everyone" },
  { value: "unlisted", label: "Link only" },
  { value: "private", label: "Only me" },
];

/** What a not-connected account says instead of a choice. */
export function accountState(a: SocialAccount): string {
  switch (a.connectionStatus) {
    case "needs_reconnect":
      return "Needs connecting again.";
    case "choose_account":
      return "Pick which account to use first.";
    case "same_as_clips":
      return "This is Clip Factory's own account. Connect a different account made for Clips Funded in Social accounts.";
    default:
      return "Not connected yet.";
  }
}

/** What a check found about one chosen account: still the one shown, or why the upload must wait. */
export function checkProblem(before: SocialAccount, after: SocialAccount): string | null {
  const place = PLATFORM_LABEL[after.platform];
  if (after.connectionStatus !== "connected") {
    const state =
      after.connectionStatus === "needs_reconnect"
        ? "needs connecting again"
        : after.connectionStatus === "choose_account"
          ? "needs you to pick the account first"
          : after.connectionStatus === "same_as_clips"
            ? "is Clip Factory's own account right now"
            : "is not connected any more";
    return `Clips Funded's ${place} ${state}. Fix it in Social accounts, or leave ${place} out.`;
  }
  if (before.externalAccountId && after.externalAccountId !== before.externalAccountId) {
    // By its place first, so it reads right when the account is itself called Lamo Stories (§45.36 E13).
    const who = [after.accountName, after.handle].filter(Boolean).join(", ");
    return `Clips Funded's ${place} is now a different account: ${thisAccount(after.platform, who)}. Look at it below, then tap Upload again.`;
  }
  return null;
}

/**
 * Which chosen place a publishing 409 that names an account is about (§45.34): the place whose account is that one,
 * else the place the sentence names, else the only place chosen; null when it cannot be told.
 */
export function placeOf(message: string, account: ErrorAccount, chosen: Platform[], accounts: Map<Platform, SocialAccount>): Platform | null {
  const same = chosen.find((p) => accounts.get(p)?.externalAccountId === account.externalAccountId);
  if (same) return same;
  const named = chosen.filter((p) => new RegExp(`(^|[^A-Za-z])${PLATFORM_LABEL[p]}([^A-Za-z]|$)`).test(message));
  if (named.length === 1) return named[0]!;
  return chosen.length === 1 ? chosen[0]! : null;
}

/**
 * The account a post would go to, shown before the owner says yes (name and handle, §45.34; the id behind "Technical
 * details", §45.36 E14). Named by its place first, so it reads right when the account is itself "Lamo Stories".
 */
export function AccountCard({ platform, account }: { platform: Platform; account: ErrorAccount }) {
  return (
    <div className="st-s-dest st-s-dest--ask" aria-label={`The ${PLATFORM_LABEL[platform]} account`}>
      <DestWho platform={platform} account={account} />
      <AccountId id={account.externalAccountId} />
    </div>
  );
}

/**
 * "Goes to this TikTok account: Lamo Stories (@lamo.stories)": by its place first, so it reads right when the account
 * is itself called Lamo Stories (§45.36 E13); one with no name or handle is "the connected TikTok account", its id
 * only behind Technical details (§45.36 E14).
 */
function DestWho({ platform, account }: { platform: Platform; account: Pick<ErrorAccount, "accountName" | "handle"> }) {
  const shown = accountShown(account);
  return (
    <p className="st-s-dest__who">
      {shown ? (
        <>
          Goes to this {PLATFORM_LABEL[platform]} account: <strong>{shown}</strong>
        </>
      ) : (
        `Goes to the connected ${PLATFORM_LABEL[platform]} account.`
      )}
    </p>
  );
}

/** An account's own id, folded away (§45.36 E14): the name and handle say which one it is. */
export function AccountId({ id }: { id: string | null | undefined }) {
  if (!id) return null;
  return (
    <TechDetails className="st-s-dest__tech">
      <p className="st-s-dest__id">Account id {id}</p>
    </TechDetails>
  );
}

/** "Post to this TikTok account (Lamo Stories)?": the question before posting to an account the API named (§45.36 E13). */
export function postToTitle(platform: Platform, account: ErrorAccount): string {
  return `Post to ${thisAccount(platform, account.accountName || account.handle)}?`;
}

/** The yes of that question: the server's sentence says "Tap Yes …". */
export const POST_YES = "Yes, post to this account";

/**
 * The yes button for the server's own sentence: "Yes, post to this account" for "Tap Yes …", and the button the
 * sentence names when an API still says "Tap Post to {name} …", so the words on screen always match a button.
 */
export function postYes(message: string | null | undefined): string {
  const named = /\bTap (Post to .+?) if\b/.exec(message ?? "");
  return named ? named[1]! : POST_YES;
}

/** The Clip Factory-shaped creator the shared TikTok rules read (the same fields, §17.4). */
const asClips = (c: TikTokCreator): ClipsTikTokCreator => ({ ...c, avatarUrl: c.avatarUrl ?? undefined });

/** The flat options each target carries (§45.6 PublishOptions; the server allow-lists them). */
export function optionsFor(p: Platform, yt: YouTubeOptions, shareToFeed: boolean, tt: TikTokChoices, creator: TikTokCreator | null): PublishOptions | undefined {
  if (p === "youtube") return { privacy: yt.privacy, category: yt.category, notifySubscribers: yt.notifySubscribers };
  if (p === "tiktok" && creator) return tiktokOptions(tt, asClips(creator));
  if (p === "instagram") return { shareToFeed };
  return undefined;
}

export function PublishSheet({
  ws,
  story,
  config,
  jobs,
  onSent,
  onRetry,
  onClose,
}: {
  ws: string;
  story: Story;
  config: Partial<StoriesConfig>;
  /** The story's publishing jobs as the page polls them (the sheet shows the ones it sent). */
  jobs: PublishingJob[];
  onSent: (jobs: PublishingJob[]) => void;
  onRetry: (job: PublishingJob) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Platform[]>([]);
  const [more, setMore] = useState(false);
  const [yt, setYt] = useState<YouTubeOptions>({ privacy: config.youtubePrivacy ?? "public", category: config.youtubeCategory ?? "27", notifySubscribers: true });
  const [shareToFeed, setShareToFeed] = useState(true);
  const [tt, setTt] = useState<TikTokChoices>(NO_TIKTOK_CHOICES);
  const [creator, setCreator] = useState<TikTokCreator | null>(null);
  const [creatorProblem, setCreatorProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const [mine, setMine] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sentIds, setSentIds] = useState<string[] | null>(null);
  /** The accounts checked live in this sheet (when), and the one being checked now. */
  const [checked, setChecked] = useState<Partial<Record<Platform, number>>>({});
  const [checking, setChecking] = useState<Platform[]>([]);
  const [checkNote, setCheckNote] = useState<Partial<Record<Platform, string>>>({});
  /** The accounts the owner said yes to after a 409 named them (sent as confirmAccount), and the one being asked. */
  const [confirms, setConfirms] = useState<Partial<Record<Platform, string>>>({});
  const [ask, setAsk] = useState<{ platform: Platform; account: ErrorAccount; message: string } | null>(null);

  useEffect(() => {
    let live = true;
    storiesApi()
      .social(ws)
      .then((r) => live && setAccounts(r.accounts))
      .catch((e) => live && setLoadProblem(say(e)));
    return () => {
      live = false;
    };
  }, [ws]);

  const byPlatform = useMemo(() => new Map((accounts ?? []).map((a) => [a.platform, a])), [accounts]);
  const connected = STORIES_PLATFORMS.map((p) => byPlatform.get(p)).filter((a): a is SocialAccount => !!a && a.connectionStatus === "connected");
  const others = STORIES_PLATFORMS.map((p) => byPlatform.get(p)).filter((a): a is SocialAccount => !!a && a.connectionStatus !== "connected");
  const tiktokOn = chosen.includes("tiktok");

  // TikTok's rules: this account's current choices are read every time the TikTok part opens.
  useEffect(() => {
    if (!tiktokOn) return;
    let live = true;
    setCreatorProblem(null);
    storiesApi()
      .tiktokCreatorInfo(ws)
      .then((c) => {
        if (!live) return;
        setCreator(c);
        // "Use my settings" was tapped before TikTok's choices arrived: they are the owner's tap too.
        if (mine) setTt((now) => myTikTokChoices(MY_TIKTOK, asClips(c), now));
      })
      .catch((e) => live && setCreatorProblem(say(e)));
    return () => {
      live = false;
    };
    // `mine` is read once when the choices arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiktokOn, ws, asked]);

  function toggle(p: Platform) {
    setProblem(null);
    setChosen((c) => (c.includes(p) ? c.filter((x) => x !== p) : [...c, p]));
  }

  /** Asks the platform which account Lamo Stories' connection is now; returns the problem, or null when it is the same. */
  async function check(p: Platform): Promise<string | null> {
    const before = byPlatform.get(p);
    if (!before) return `${PLATFORM_LABEL[p]} is not connected.`;
    setChecking((c) => [...c, p]);
    try {
      const after = await storiesApi().checkSocial(ws, p);
      setAccounts((list) => (list ? list.map((a) => (a.platform === p ? after : a)) : list));
      const why = checkProblem(before, after);
      // Another TikTok account now: TikTok's choices belong to the account posted to, so they are asked again and
      // the picks made for the old one are cleared ("Waiting for TikTok's choices." until they arrive).
      if (p === "tiktok" && before.externalAccountId && after.externalAccountId !== before.externalAccountId) {
        setCreator(null);
        setTt(NO_TIKTOK_CHOICES);
        setAsked((n) => n + 1);
      }
      setChecked((m) => ({ ...m, [p]: Date.now() }));
      setCheckNote((m) => ({ ...m, [p]: why ?? "Checked just now: this is the account the video goes to." }));
      if (why && after.connectionStatus !== "connected") setChosen((c) => c.filter((x) => x !== p));
      return why;
    } catch (e) {
      const why = say(e, `${PLATFORM_LABEL[p]} did not answer. Try Check now again in a minute.`);
      setCheckNote((m) => ({ ...m, [p]: why }));
      return why;
    } finally {
      setChecking((c) => c.filter((x) => x !== p));
    }
  }

  function useMine() {
    setMine(true);
    setYt({ privacy: "public", category: config.youtubeCategory ?? "27", notifySubscribers: true });
    setShareToFeed(true);
    if (creator) setTt((now) => myTikTokChoices(MY_TIKTOK, asClips(creator), now));
  }

  const length = story.actualDurationSec ?? story.durationSec;
  const ttTooLong = !!creator && tooLongForTikTok(length, creator.maxDurationSec);
  const ttReady = !tiktokOn || (!!creator && !ttTooLong && choicesReady(tt));
  const why = !chosen.length
    ? "Tap the places to post to."
    : tiktokOn && !creator
      ? "Waiting for TikTok's choices."
      : tiktokOn && ttTooLong
        ? "This video is longer than TikTok allows for this account. Tap TikTok to leave it out."
        : tiktokOn && !tt.privacy
          ? "Pick who can see it on TikTok."
          : tiktokOn && !ttReady
            ? `${PICK_WHOSE} Pick Your brand or Branded content.`
            : null;

  async function post(yes: Partial<Record<Platform, string>> = confirms) {
    if (why || sending) return;
    setSending(true);
    setProblem(null);
    try {
      // Verify before publishing: every chosen account not checked in this sheet is checked now.
      const waiting = chosen.filter((p) => !checked[p]);
      const found = (await Promise.all(waiting.map((p) => check(p)))).filter((x): x is string => !!x);
      if (found.length) {
        setProblem(found.join(" "));
        return;
      }
      const targets: PublishTarget[] = chosen.map((p) => {
        const account = byPlatform.get(p)!;
        const options = optionsFor(p, yt, shareToFeed, tt, creator);
        const t: PublishTarget = options ? { platform: p, socialAccountId: account.socialAccountId, options } : { platform: p, socialAccountId: account.socialAccountId };
        if (yes[p]) t.confirmAccount = yes[p];
        return t;
      });
      const made = await storiesApi().publish(ws, story.storyId, targets);
      setSentIds(made.map((j) => j.publishingJobId));
      onSent(made);
    } catch (e) {
      // The API names the account a place would send to (§45.34): the owner says yes first; nothing was posted.
      const named = accountOf(e);
      const place = named ? placeOf(say(e), named, chosen, byPlatform) : null;
      if (named && place && yes[place] !== named.externalAccountId) setAsk({ platform: place, account: named, message: say(e) });
      else setProblem(say(e));
    } finally {
      setSending(false);
    }
  }

  function sayYes() {
    if (!ask) return;
    const next = { ...confirms, [ask.platform]: ask.account.externalAccountId };
    setConfirms(next);
    setAsk(null);
    void post(next);
  }

  if (sentIds) {
    const sent = sentIds.map((jid) => jobs.find((j) => j.publishingJobId === jid)).filter((j): j is PublishingJob => !!j);
    return <SentSheet sent={sent} onClose={onClose} onRetry={onRetry} />;
  }

  const ttPrivacy = creator ? privacyChoices(creator.privacyOptions, tt.commercial && tt.branded) : [];
  const brandBlock = brandedBlocked(tt.privacy);
  const ttTag = tiktokLabel(tt);

  return (
    <StSheet
      title="Post it"
      onClose={onClose}
      wide
      actions={
        <>
          <button type="button" className="st-btn" onClick={onClose}>
            Not now
          </button>
          <button type="button" className="st-btn st-btn--main st-s-big st-s-upload" aria-disabled={!!why || sending || checking.length > 0 || undefined} title={why ?? undefined} onClick={() => checking.length === 0 && void post()}>
            {sending ? "Checking and sending…" : chosen.length > 1 ? `Upload to ${chosen.length} places` : "Upload"}
          </button>
        </>
      }
    >
      {loadProblem ? (
        <Notice tone="bad">{loadProblem}</Notice>
      ) : !accounts ? (
        <Busy>Getting your Clips Funded accounts…</Busy>
      ) : (
        <>
          <p className="st-s-field__hint">Only Clips Funded&apos;s own accounts are here. Tap each place to post “{story.title}” to.</p>
          {connected.length ? (
            <ul className="st-s-places" aria-label="Where to post">
              {connected.map((a) => {
                const on = chosen.includes(a.platform);
                const busy = checking.includes(a.platform);
                const when = checked[a.platform] ? "just now" : a.lastCheckedAt ? ago(a.lastCheckedAt) : null;
                return (
                  <li key={a.platform} className="st-s-places__item">
                    <button type="button" className={`st-s-place${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => toggle(a.platform)}>
                      <span className="st-s-place__mark">
                        <PlatformMark platform={a.platform} size={26} />
                      </span>
                      <span className="st-s-place__text">
                        <span className="st-s-place__platform">{PLATFORM_LABEL[a.platform]}</span>
                        <span className="st-s-place__name">{a.accountName ?? "Connected account"}</span>
                        {a.handle ? <span className="st-s-place__handle">{a.handle}</span> : null}
                      </span>
                      <span className="st-s-place__tick" aria-hidden="true">
                        {on ? "✓" : "+"}
                      </span>
                    </button>
                    {on ? (
                      <div className="st-s-dest" aria-label={`Where it goes on ${PLATFORM_LABEL[a.platform]}`}>
                        <DestWho platform={a.platform} account={a} />
                        <AccountId id={a.externalAccountId} />
                        <p className={`st-s-dest__note${checkNote[a.platform] && checkNote[a.platform] !== "Checked just now: this is the account the video goes to." ? " is-bad" : ""}`} role="status">
                          {checkNote[a.platform] ?? (when ? `Last checked ${when}.` : "Not checked yet.")}
                        </p>
                        <button type="button" className="st-btn st-s-small" aria-disabled={busy || sending || undefined} onClick={() => !busy && !sending && void check(a.platform)}>
                          {busy ? "Checking…" : "Check now"}
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Notice tone="info" action={<SocialAccountsLink className="st-btn" />}>
              No Clips Funded account is connected yet. Connect one in Social accounts first.
            </Notice>
          )}
          {others.length ? (
            <ul className="st-s-places st-s-places--off" aria-label="Not ready to post">
              {others.map((a) => (
                <li key={a.platform} className="st-s-place st-s-place--off">
                  <span className="st-s-place__mark">
                    <PlatformMark platform={a.platform} size={22} />
                  </span>
                  <span className="st-s-place__text">
                    <span className="st-s-place__platform">{PLATFORM_LABEL[a.platform]}</span>
                    <span className="st-s-place__name">{accountState(a)}</span>
                  </span>
                  <A href={storiesHref({ name: "connections", platform: null, result: null, ws: null })} className="st-btn st-s-small">
                    Connect in Social accounts
                  </A>
                </li>
              ))}
            </ul>
          ) : null}

          {connected.length ? (
            <div className="st-s-presets">
              <button type="button" className={`st-btn${mine ? "" : " st-btn--main"}`} onClick={useMine}>
                {mine ? "✓ Using my settings" : "Use my settings"}
              </button>
              <button type="button" className="st-btn" aria-expanded={more} aria-controls={`${id}-more`} onClick={() => setMore((m) => !m)}>
                {more ? "Fewer details" : "More details"}
              </button>
            </div>
          ) : null}
          {mine ? <p className="st-s-field__hint">My settings: everyone can see it, comments, duets and stitches on, not made for kids.</p> : null}

          {tiktokOn ? (
            <fieldset className="st-s-group st-s-tiktok">
              <legend className="st-s-group__title">TikTok</legend>
              {creatorProblem ? (
                <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => setAsked((n) => n + 1)}>Ask TikTok again</button>}>
                  {creatorProblem}
                </Notice>
              ) : !creator ? (
                <Busy>Asking TikTok…</Busy>
              ) : (
                <>
                  <p className="st-s-field__hint">
                    Posting as <strong>{creator.nickname}</strong> (@{creator.username})
                  </p>
                  <div className="st-s-field">
                    <span className="st-s-field__label" id={`${id}-tt-who`}>
                      Who can see it
                    </span>
                    <Dropdown
                      labelledBy={`${id}-tt-who`}
                      value={tt.privacy}
                      placeholder="Pick who can see it"
                      options={orderedPrivacy(creator.privacyOptions).map((o) => {
                        const off = !ttPrivacy.includes(o);
                        return { value: o, label: PRIVACY_LABEL[o] ?? o, disabled: off, line: off ? BRANDED_PRIVATE_LINE : undefined };
                      })}
                      onChange={(privacy) => setTt((c) => ({ ...c, privacy }))}
                    />
                    {onlyPrivateAllowed(creator.privacyOptions) ? <span className="st-s-field__hint">TikTok keeps posts private until it approves the app.</span> : null}
                  </div>
                  <Switch label="Comments" checked={tt.comments && !creator.commentDisabled} disabled={creator.commentDisabled} line={creator.commentDisabled ? "Turned off in your TikTok settings." : undefined} onChange={(comments) => setTt((c) => ({ ...c, comments }))} />
                  <Switch label="Duet" checked={tt.duet && !creator.duetDisabled} disabled={creator.duetDisabled} line={creator.duetDisabled ? "Turned off in your TikTok settings." : undefined} onChange={(duet) => setTt((c) => ({ ...c, duet }))} />
                  <Switch label="Stitch" checked={tt.stitch && !creator.stitchDisabled} disabled={creator.stitchDisabled} line={creator.stitchDisabled ? "Turned off in your TikTok settings." : undefined} onChange={(stitch) => setTt((c) => ({ ...c, stitch }))} />
                  <Switch label="Commercial content" line="Turn on if this video promotes a brand, a product or yourself." checked={tt.commercial} onChange={(commercial) => setTt((c) => ({ ...c, commercial }))} />
                  {tt.commercial ? (
                    <div className="st-s-chips" role="group" aria-label="Commercial content">
                      <button type="button" className={`st-s-chipbtn${tt.yourBrand ? " is-on" : ""}`} aria-pressed={tt.yourBrand} onClick={() => setTt((c) => ({ ...c, yourBrand: !c.yourBrand }))}>
                        Your brand
                      </button>
                      <button
                        type="button"
                        className={`st-s-chipbtn${tt.branded ? " is-on" : ""}`}
                        aria-pressed={tt.branded}
                        aria-disabled={(!!brandBlock && !tt.branded) || undefined}
                        title={brandBlock ?? undefined}
                        onClick={() => !(brandBlock && !tt.branded) && setTt((c) => ({ ...c, branded: !c.branded }))}
                      >
                        Branded content
                      </button>
                      <span className="st-s-field__hint">{ttTag ? `Your video will be labeled as '${ttTag}'.` : "Pick Your brand, Branded content, or both."}</span>
                      {brandBlock ? <span className="st-s-field__hint">{brandBlock}</span> : null}
                    </div>
                  ) : null}
                  <p className="st-s-field__hint">
                    By posting, you agree to TikTok&apos;s{" "}
                    {tt.commercial && tt.branded ? (
                      <>
                        <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener noreferrer">
                          Branded Content Policy
                        </a>{" "}
                        and{" "}
                      </>
                    ) : null}
                    <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener noreferrer">
                      Music Usage Confirmation
                    </a>
                    .
                  </p>
                  {ttTooLong ? <Notice tone="bad">This video is longer than TikTok allows for this account. Tap TikTok above to leave it out.</Notice> : null}
                </>
              )}
            </fieldset>
          ) : null}

          {more ? (
            <div className="st-s-more" id={`${id}-more`}>
              {chosen.includes("youtube") || !chosen.length ? (
                <fieldset className="st-s-group">
                  <legend className="st-s-group__title">YouTube</legend>
                  <Pick label="Who can see it" value={yt.privacy} options={WHO} onChange={(privacy) => setYt((y) => ({ ...y, privacy }))} />
                  <div className="st-s-field">
                    <span className="st-s-field__label" id={`${id}-yt-cat`}>
                      Category
                    </span>
                    <Dropdown labelledBy={`${id}-yt-cat`} value={yt.category} placeholder="Pick a category" options={YOUTUBE_CATEGORIES.map((c) => ({ value: c.id, label: c.label }))} onChange={(category) => setYt((y) => ({ ...y, category }))} />
                  </div>
                  <Switch label="Tell my subscribers" checked={yt.notifySubscribers} onChange={(notifySubscribers) => setYt((y) => ({ ...y, notifySubscribers }))} />
                  <p className="st-s-field__hint">Made for kids: No. Clips Funded never marks a video as made for kids.</p>
                </fieldset>
              ) : null}
              {chosen.includes("instagram") || !chosen.length ? (
                <fieldset className="st-s-group">
                  <legend className="st-s-group__title">Instagram</legend>
                  <Switch label="Also show it in the feed" checked={shareToFeed} onChange={setShareToFeed} />
                </fieldset>
              ) : null}
              {chosen.includes("facebook") || chosen.includes("x") ? <p className="st-s-field__hint">Facebook and X have nothing else to pick.</p> : null}
            </div>
          ) : null}

          {why && chosen.length ? <p className="st-s-field__hint st-s-why">{why}</p> : null}
          {problem ? (
            <Notice tone="bad" action={accountProblem(problem) ? <SocialAccountsLink className="st-btn" /> : undefined}>
              {problem}
            </Notice>
          ) : null}
          {ask ? (
            <StSheet
              title={postToTitle(ask.platform, ask.account)}
              onClose={() => setAsk(null)}
              actions={
                <>
                  <button type="button" className="st-btn" onClick={() => setAsk(null)}>
                    Not now
                  </button>
                  <button type="button" className="st-btn st-btn--main" aria-disabled={sending || undefined} onClick={() => !sending && sayYes()}>
                    {sending ? "Sending…" : postYes(ask.message)}
                  </button>
                </>
              }
            >
              <p>{ask.message}</p>
              <AccountCard platform={ask.platform} account={ask.account} />
            </StSheet>
          ) : null}
        </>
      )}
    </StSheet>
  );
}

/** The posts already celebrated: one star burst and one cheer per post, by whichever screen sees it go up first (§45.36 E11). */
const cheeredPosts = new Set<string>();

/** True the first time a post is claimed for its celebration; false after that. */
export function claimPostCheer(publishingJobId: string): boolean {
  if (cheeredPosts.has(publishingJobId)) return false;
  cheeredPosts.add(publishingJobId);
  return true;
}

/**
 * After Upload: each place as it goes; "Posted!" once every one is up. Each place that goes up gets the star burst and
 * the cheer, as Approve does (§45.36 E11), also when another place stops.
 */
function SentSheet({ sent, onClose, onRetry }: { sent: PublishingJob[]; onClose: () => void; onRetry: (job: PublishingJob) => void }) {
  const done = sent.length > 0 && sent.every((j) => j.publishingStatus === "posted");
  const states = sent.map((j) => `${j.publishingJobId}:${j.publishingStatus}`).join(",");
  useEffect(() => {
    const up = sent.filter((j) => j.publishingStatus === "posted" && claimPostCheer(j.publishingJobId));
    if (!up.length) return;
    // The same as Approve: Lamo Stories' own star burst from the sheet's title, and the success cheer.
    celebrate(document.querySelector(".st-s-posted-sheet .st-s-sheet__title"), 150);
    // Only when a place's state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states]);
  return (
    <StSheet
      title={done ? "Posted!" : "Sending your video"}
      onClose={onClose}
      wide
      className="st-s-posted-sheet"
      actions={
        <button type="button" className="st-btn st-btn--main" onClick={onClose}>
          {done ? "Done" : "Close (it keeps going)"}
        </button>
      }
    >
      <p className="st-s-field__hint">
        {done
          ? "Your video is up. The numbers come in over the next 7 days."
          : sent.some((j) => waitingLine(j))
            ? "Each place shows here as it goes. A place that waits goes out by itself at its time. You can close this."
            : "Each place shows here as it goes. You can close this: it keeps going."}
      </p>
      <ul className="st-s-posts">
        {sent.map((j) => (
          <PostRow key={j.publishingJobId} job={j} onRetry={onRetry} />
        ))}
      </ul>
    </StSheet>
  );
}
