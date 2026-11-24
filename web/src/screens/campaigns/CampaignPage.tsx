// One campaign's card (/campaigns/{uuid}, docs/CONTRACTS.md §38.4): the head, the one next step, the pay, the rules
// Clip Factory follows and the things the owner does, the logo, the videos to clip, his clips for it, and Remove.
// Brand text is shown as plain words, never HTML; amounts are Content Rewards' own, only formatted.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Campaign } from "../../api/types.ts";
import { CrPostLines } from "../../components/CrPostLine.tsx";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, Empty, ErrorPanel, LinkButton, Progress, Skeleton } from "../../components/ui.tsx";
import { burst } from "../../lib/confetti.ts";
import {
  CAMPAIGNS_PATH,
  COMING_SOON,
  TIKTOK_NOT_YET,
  budgetChip,
  campaignPath,
  campaignRemoved,
  countryLines,
  crAvailability,
  hideCampaign,
  makeClipsPath,
  payLine,
  placeList,
  reloadCr,
  sendGroups,
  useCrOnReturn,
  useNow,
  usePinMain,
  useSubmissions,
  usdShort,
} from "../../lib/contentRewards.ts";
import { PLATFORM_LABEL, relative } from "../../lib/format.ts";
import { useLiveEvents, useLivePoll } from "../../lib/live.ts";
import { navigate } from "../../lib/router.ts";
import { prefersReducedMotion } from "../../lib/prefs.ts";
import { cheerOnNextTap } from "../../lib/sound.ts";
import { sounds } from "../../lib/sounds.ts";
import { Rich } from "../settings/setup/bits.tsx";
import { BrandMark, BrandText, Fold, Note, OpenButton } from "./bits.tsx";
import { LogoBox, type LogoBoxHandle } from "./LogoBox.tsx";
import { NextStepPanel, RulesBox, useKeptRules } from "./NextStep.tsx";

/** Videos to clip's own way on, from a channel's video link to Home's campaign way. */
const MAKE_CLIPS_HERE = "Make clips for this campaign";

const WAITING = new Set(["not_joined", "apply_first", "waiting", "left", "unknown"]);

export function CampaignPage({ campaignId }: { campaignId: string }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [problem, setProblem] = useState<{ kind: "missing" | "soon" | "gone" | "error"; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const lastCheck = useRef(0);
  const toast = useToast();
  const logo = useRef<LogoBoxHandle>(null);
  const celebrated = useRef(false);
  const [justIn, setJustIn] = useState(false);
  // Phones: the screen's one vermilion is pinned at the bottom right while the card is on screen (§38.1).
  const pin = usePinMain();
  const [pinSlot, setPinSlot] = useState<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      setCampaign(await api().crCampaign(campaignId));
      setProblem(null);
    } catch (e) {
      const kind = crAvailability(e);
      setProblem(
        kind === "missing"
          ? { kind: "gone", text: friendlyMessage(e) }
          : kind === "soon"
            ? { kind: "soon", text: COMING_SOON }
            : { kind: "error", text: friendlyMessage(e) },
      );
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveEvents(
    (e) => {
      if (e.type === "contentrewards" && (e.id === `campaign:${campaignId}` || e.id === "connection" || e.id.startsWith("submission:"))) void load();
    },
    () => void load(),
  );

  /** Check now: membership and status now (at most every 30 s, §38.4). */
  const checkNow = useCallback(async () => {
    lastCheck.current = Date.now();
    setChecking(true);
    try {
      setCampaign(await api().crReadCampaign(campaignId));
      void reloadCr();
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setChecking(false);
    }
  }, [campaignId, toast]);

  // Coming back to the window while a campaign waits: a join on Content Rewards shows when he switches back.
  const onReturn = useCallback(() => {
    if (Date.now() - lastCheck.current > 30_000) void checkNow();
  }, [checkNow]);
  useCrOnReturn(onReturn, !!campaign && WAITING.has(campaign.membership));

  // "You're in!": confetti once (not with reduced motion), the success sound on his next tap, and the server is told.
  useEffect(() => {
    if (campaign?.celebrate !== "in" || celebrated.current) return;
    celebrated.current = true;
    setJustIn(true);
    if (!prefersReducedMotion()) burst(undefined, 140);
    const stop = cheerOnNextTap(sounds);
    toast.success("You're in!");
    void api()
      .crSeen(`in:${campaign.campaignId}`)
      .catch(() => undefined);
    return () => stop();
  }, [campaign, toast]);

  // "Read the rules" (§39.3) opens this card at `#rules`: once the card is drawn, the rules come into view.
  const toRules = useRef(typeof location !== "undefined" && location.hash === "#rules");
  useEffect(() => {
    if (!campaign || !toRules.current) return;
    toRules.current = false;
    const t = setTimeout(() => {
      const el = document.getElementById("rules");
      el?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      el?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    }, 60);
    return () => clearTimeout(t);
  }, [campaign]);

  const subs = useSubmissions({ campaignId }, !!campaign);
  // A clip that waits to be sent by hand now comes first: its Copy and open is the screen's vermilion (§38.6).
  const now = useNow(subs.subs.some((s) => s.state === "send_by_hand"));
  const sendNow = sendGroups(subs.subs, now)[0] ?? null;
  // While the rules are being read (about 30 seconds), look again now and then too, in case the live news is late.
  useLivePoll(load, campaign?.rulesState === "reading", 4000);

  function remove() {
    if (!campaign) return;
    const name = campaign.name;
    // Gone from Your campaigns at once (it can't be opened again while the Undo counts), back on Undo.
    hideCampaign(campaignId);
    navigate(CAMPAIGNS_PATH);
    toast.undo(`Removing ${name}…`, {
      onUndo: () => {
        hideCampaign(campaignId, false);
        navigate(campaignPath(campaignId));
      },
      onCommit: () => {
        // Its card opened again meanwhile (Back, a link): it is gone now, so Your campaigns takes its place.
        if (location.pathname === campaignPath(campaignId)) navigate(CAMPAIGNS_PATH, { replace: true });
        void api()
          .crRemoveCampaign(campaignId)
          .then(() => {
            campaignRemoved(campaignId);
            return reloadCr();
          })
          .catch((e) => {
            hideCampaign(campaignId, false);
            toast.error(`${friendlyMessage(e)} ${name} is still here.`);
          });
      },
    });
  }

  if (problem && !campaign)
    return (
      <div className="page page--narrow">
        <h1 className="sr-only">Campaign</h1>
        {problem.kind === "error" ? (
          <ErrorPanel message={problem.text} onRetry={() => void load()} />
        ) : (
          <Empty
            icon="info"
            title={problem.kind === "soon" ? "Coming soon" : "This campaign isn't here"}
            heading="h2"
            action={
              <LinkButton href={CAMPAIGNS_PATH} variant="primary" icon="layers" data-help-clear="">
                Your campaigns
              </LinkButton>
            }
          >
            {problem.kind === "soon" ? COMING_SOON : problem.text}
          </Empty>
        )}
      </div>
    );
  if (!campaign)
    return (
      <div className="page page--narrow">
        <h1 className="sr-only">Campaign</h1>
        <Skeleton className="setup-skel" />
        <Skeleton className="setup-skel" />
      </div>
    );

  const c = campaign;
  const isIn = c.membership === "in" || c.membership === "manual";
  const chip = c.nextStep.chip;
  const pickVideo = c.nextStep.kind === "pick_video";
  return (
    <div className="page page--narrow cr-campaign">
      <article className={`cr-card glass${pin ? " has-pin" : ""}`} data-help="cr-campaign-card" aria-labelledby="cr-name">
        <header className="cr-head">
          <BrandMark name={c.brand || c.name} url={c.brandPictureUrl} size={56} />
          <div className="cr-head__text">
            <h1 className="cr-head__name" id="cr-name">
              <BrandText text={c.name} />
            </h1>
            <p className="cr-head__brand user-text">{c.brand}</p>
            <span className={`pill pill--${isIn ? "success" : "neutral"} cr-chip`}>
              <span className="pill__text">{chip}</span>
            </span>
          </div>
          <div className="cr-head__check">
            <span className="cr-quiet">Checked {relative(c.checkedAt)}</span>
            <Button variant="glass" size="sm" icon="retry" act="retry" loading={checking} onClick={checkNow}>
              Check now
            </Button>
          </div>
        </header>

        {sendNow ? (
          <section className="cr-next cr-send-first" aria-labelledby="cr-send-title">
            <h2 className="cr-section__title" id="cr-send-title">
              Send your clip now ({sendNow.minutesLeft} min left)
            </h2>
            <CrPostLines subs={subs.subs.filter((x) => sendNow.postIds.includes(x.postId))} onChange={subs.put} primary />
          </section>
        ) : null}

        <NextStepPanel campaign={c} onCampaign={setCampaign} onPickLogo={() => logo.current?.pick()} pinSlot={pin && !sendNow ? pinSlot : null} quiet={!!sendNow} justIn={justIn} />

        <PaySection c={c} />
        <RulesSection c={c} onCampaign={setCampaign} />
        <LogoBox campaign={c} onCampaign={setCampaign} handle={logo} openCampaign={c.url} />
        <VideosSection c={c} pickVideo={pickVideo && !sendNow} />

        {subs.subs.length ? (
          <section className="cr-clips" data-help="cr-campaign-clips" aria-labelledby="cr-clips-title">
            <h2 className="cr-section__title" id="cr-clips-title">
              Your clips for this campaign
            </h2>
            <p className="cr-quiet">
              {c.clipCounts.approved} approved · {c.clipCounts.waiting} waiting · {c.clipCounts.notApproved} not approved
            </p>
            <ClipLines subs={sendNow ? subs.subs.filter((x) => !sendNow.postIds.includes(x.postId)) : subs.subs} onChange={subs.put} />
          </section>
        ) : null}

        <footer className="cr-foot">
          <Button variant="ghost" size="sm" icon="trash" onClick={remove}>
            Remove from Clip Factory
          </Button>
          <OpenButton label="Open campaign" href={c.url} size="sm" />
        </footer>
        {pin ? <div className="cr-pin" ref={setPinSlot} /> : null}
      </article>
      <div className="cr-below">
        <LinkButton href={CAMPAIGNS_PATH} variant="glass" icon="layers">
          All your campaigns
        </LinkButton>
      </div>
    </div>
  );
}

/** Newest first, 10, then Show more. */
function ClipLines({ subs, onChange }: { subs: Parameters<typeof CrPostLines>[0]["subs"]; onChange: Parameters<typeof CrPostLines>[0]["onChange"] }) {
  const [all, setAll] = useState(false);
  const shown = all ? subs : subs.slice(0, 10);
  return (
    <>
      <CrPostLines subs={shown} onChange={onChange} />
      {subs.length > 10 && !all ? (
        <Button variant="glass" size="sm" onClick={() => setAll(true)}>
          Show more
        </Button>
      ) : null}
    </>
  );
}

function PaySection({ c }: { c: Campaign }) {
  const countries = c.pay.flatMap((p) => countryLines(p));
  const chip = budgetChip(c.budget.usedPct);
  const paidHere = c.platformsPaid.filter((p) => p !== "tiktok");
  return (
    <section className="cr-pay" data-help="cr-pay" aria-labelledby="cr-pay-title">
      <h2 className="cr-section__title" id="cr-pay-title">
        Pay
      </h2>
      <ul className="cr-pay__rows">
        {c.pay.map((p) => (
          <li key={p.platform} className="cr-pay__row">
            <PlatformMark platform={p.platform} size={20} />
            <span>
              <span className="cr-pay__place">{PLATFORM_LABEL[p.platform]}</span> · {payLine(p, c.type)}
            </span>
          </li>
        ))}
      </ul>
      {countries.length ? <Fold fold={{ id: `pay-countries-${c.campaignId}`, question: "Pays more in some countries", say: countries }} /> : null}
      {c.budget.leftCents !== null && c.budget.totalCents !== null ? (
        <div className="cr-budget">
          <p>
            Money left: {usdShort(c.budget.leftCents)} of {usdShort(c.budget.totalCents)}
            {c.budget.asOf ? ` · as of ${new Date(c.budget.asOf).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase()}` : ""}
          </p>
          {c.budget.usedPct !== null ? <Progress value={1 - c.budget.usedPct / 100} label="Money left" tone="success" /> : null}
          {chip ? (
            <span className={`pill pill--${chip === "Almost gone" ? "warn" : chip === "Half used" ? "neutral" : "success"}`}>
              <span className="pill__text">{chip}</span>
            </span>
          ) : null}
        </div>
      ) : null}
      <p className="cr-quiet">{c.access === "open" ? "Open to everyone" : "The brand picks creators (you apply)"}</p>
      <p className="cr-quiet">Pays for: {placeList(paidHere.length ? c.platformsPaid : c.platformsPaid) || "not shown yet"}</p>
      {c.platformsPaid.includes("tiktok") ? <p className="cr-quiet">{TIKTOK_NOT_YET}</p> : null}
      <p className="cr-quiet small">Content Rewards&apos; own rates, not a guess of what you&apos;ll earn.</p>
    </section>
  );
}

function RulesSection({ c, onCampaign }: { c: Campaign; onCampaign: (c: Campaign) => void }) {
  const toast = useToast();
  // Pasted but not read yet: kept for the visit, so the box opens again with it after a reload or another page.
  const [text, setText] = useKeptRules(`rules:${c.campaignId}`);
  const [open, setOpen] = useState(() => text.length > 0);
  const [busy, setBusy] = useState(false);
  async function read() {
    if (!text.trim()) {
      toast.info("Paste the rules in the box first.");
      return false;
    }
    setBusy(true);
    try {
      onCampaign(await api().crReadCampaign(c.campaignId, text));
      setText("");
      setOpen(false);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="cr-rules" id="rules" aria-labelledby="cr-rules-title">
      <h2 className="cr-section__title" id="cr-rules-title" tabIndex={-1}>
        Rules I&apos;ll follow
      </h2>
      <div data-help="cr-rules">
        {c.rulesState === "reading" ? (
          <p className="gstep__note" role="status">
            <span className="spinner" aria-hidden="true" /> Reading the rules… (about 30 seconds)
          </p>
        ) : c.rulesState === "waiting_for_join" && !c.plainRules.length ? (
          <p className="cr-quiet">You&apos;ll see the rules once you join.</p>
        ) : c.rulesState === "failed" ? (
          <Note icon="alert" tone="bad">
            I couldn&apos;t read the rules. Tap Check now, or paste them below.
          </Note>
        ) : null}
        {c.plainRules.length ? (
          <ul className="cr-ticks">
            {c.plainRules.map((r) => (
              <li key={r}>
                <Icon name="checkCircle" size={18} />
                <span className="user-text">{r}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {c.thingsYouDo.length ? (
        <div className="cr-todo" data-help="cr-things-you-do">
          <h3 className="cr-sub">Things you do</h3>
          <ul className="cr-ticks is-hand">
            {c.thingsYouDo.map((r) => (
              <li key={r}>
                <Icon name="hand" size={18} />
                <span className="user-text">{r}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {c.uncertain.length ? (
        <div className="cr-unsure">
          <h3 className="cr-sub">I couldn&apos;t tell</h3>
          <p className="cr-quiet">Read these on the campaign page.</p>
          <ul className="cr-ticks is-unsure">
            {c.uncertain.map((r) => (
              <li key={r}>
                <Icon name="question" size={18} />
                <BrandText text={r} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {c.nextStep.kind !== "check_yourself" && c.nextStep.kind !== "rules_paste" ? (
        <details className="cr-fold" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary className="cr-fold__q">
            <Icon name="info" size={18} />
            <span>Rules missing?</span>
            <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
          </summary>
          <div className="cr-fold__body">
            <p>
              <Rich text="On the campaign page, copy everything under **Brief** and **Content requirements**. Paste it here." />
            </p>
            <RulesBox value={text} onChange={setText} />
            <Button variant="glass" icon="check" act="tick" loading={busy} onClick={read}>
              Read these rules
            </Button>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function VideosSection({ c, pickVideo }: { c: Campaign; pickVideo: boolean }) {
  if (!c.sourceVideos.length && !c.channels.length) return null;
  return (
    <section className="cr-videos" aria-labelledby="cr-videos-title">
      <h2 className="cr-section__title" id="cr-videos-title">
        Videos to clip
      </h2>
      {c.sourceVideos.length ? (
        <ul className="cr-video-rows">
          {c.sourceVideos.map((v, i) => (
            <li key={v.url} className="cr-video-row">
              <span className="cr-video-row__url user-text">{v.note ?? v.url}</span>
              {v.canMakeClips ? (
                <LinkButton
                  href={`${makeClipsPath(c.campaignId)}&link=${encodeURIComponent(v.url)}`}
                  variant={pickVideo && i === 0 ? "primary" : "glass"}
                  size="sm"
                  icon="scissors"
                  data-help-clear={pickVideo && i === 0 ? "" : undefined}
                >
                  Make clips from this
                </LinkButton>
              ) : v.kind === "google_drive" || v.kind === "dropbox" ? (
                <>
                  <OpenButton label="Open" href={v.url} size="sm" />
                  <span className="cr-quiet">Download it, then tap Use a video file on Home.</span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {c.channels.length ? (
        <>
          <div className="cr-chips">
            {c.channels.map((ch) => (
              <OpenButton key={ch.href} label={`Open ${ch.name}'s ${/twitch\.tv/.test(ch.href) ? "Twitch" : /kick\.com/.test(ch.href) ? "Kick" : "YouTube"}`} href={ch.href} size="sm" />
            ))}
          </div>
          <p className="cr-quiet">Pick a video there. Copy its link. Then tap {MAKE_CLIPS_HERE}.</p>
          {/* The paste box for that link is on Home's campaign way: this is the way there (§39.1). */}
          <div className="cr-chips" data-cr="videos-make">
            <LinkButton
              href={makeClipsPath(c.campaignId)}
              variant={pickVideo && !c.sourceVideos.some((v) => v.canMakeClips) ? "primary" : "glass"}
              size="sm"
              icon="scissors"
            >
              {MAKE_CLIPS_HERE}
            </LinkButton>
          </div>
        </>
      ) : null}
    </section>
  );
}
