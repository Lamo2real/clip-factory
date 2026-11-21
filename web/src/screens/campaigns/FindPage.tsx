// Find campaigns (/campaigns/find, docs/CONTRACTS.md §41.1): what the owner wants, set once; the campaigns on Content
// Rewards' public pages that match it, ranked by the server; "Open on Content Rewards" on every match, and once he
// joined there, "I joined: add it" (or, signed in, the add by itself when he comes back). The web never decides a
// match: every match, line and count is the server's. One vermilion button on the screen, or none while he waits.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { CampaignSummary, FinderMatch, FinderWant } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, ErrorPanel, LinkButton, PageHeader, Skeleton } from "../../components/ui.tsx";
import { CAMPAIGNS_PATH, campaignPath, makeClipsPath, reloadCr, shortDay, useCrOnReturn, useNow, usePinMain } from "../../lib/contentRewards.ts";
import {
  ASK_MESSAGE,
  FIRST_SHOWN,
  FINDER_SOON,
  NO_PLACE_LINE,
  WANT_DEFAULTS,
  clockTime,
  dayAndTime,
  freezeNew,
  lookedLine,
  mergeAdded,
  openedRecently,
  placeToSetUp,
  putFinder,
  readyPlaces,
  reloadFinder,
  setupPlaceHref,
  shownMatches,
  stateLine,
  useFinder,
  useWantSaver,
} from "../../lib/finder.ts";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { useLiveEvents, useLivePoll } from "../../lib/live.ts";
import { navigate } from "../../lib/router.ts";
import { CR_DISCOVER } from "../../setup/contentrewards.ts";
import { useSetup } from "../settings/setup/useSetup.ts";
import { accountLinks } from "./CampaignsPage.tsx";
import { Note, OpenButton } from "./bits.tsx";
import { FinderMatchCard } from "./FinderMatchCard.tsx";
import { FinderWant as WantCard } from "./FinderWant.tsx";
import { RULES_MAX } from "./NextStep.tsx";

export const FIND_LEDE = "Campaigns on Content Rewards that pay what you want. I look 4 times a day.";
export const LOAD_FAILED = "Couldn't load. Tap Try again.";
export const READING = "Reading the rules… (about 30 seconds)";

/** Content Rewards news off in Settings (§38.11): the Tell me switch says so (from the settings already loaded). */
function useNewsOff(): boolean {
  const session = useSession();
  return session.me?.settings.notify?.contentRewards === false;
}

/** One "You're in!" row of this visit (§41.1). The newest row's button is the screen's vermilion. */
function InRow({ c, main, pinned }: { c: CampaignSummary; main: boolean; pinned: boolean }) {
  const reading = c.nextStepKind === "stop" && /^Reading the rules/.test(c.nextStepText);
  const btn = reading ? (
    <Button variant="glass" size="lg" disabled icon="clock">
      {READING}
    </Button>
  ) : c.nextStepKind === "make_clips" ? (
    <LinkButton href={makeClipsPath(c.campaignId)} variant={main ? "primary" : "glass"} size={main ? "lg" : "md"} icon="scissors" data-help-clear={main ? "" : undefined}>
      Make clips for this campaign
    </LinkButton>
  ) : (
    <LinkButton href={campaignPath(c.campaignId)} variant={main ? "primary" : "glass"} size={main ? "lg" : "md"} icon="chevronRight" data-help-clear={main ? "" : undefined}>
      See what to do next
    </LinkButton>
  );
  return (
    <li className="finder-in glass" data-campaign={c.campaignId}>
      <p className="finder-in__text">
        <Icon name="checkCircle" size={22} />
        <span>
          <strong>You&apos;re in!</strong> <span className="user-text">{c.name.slice(0, 300)}</span> is in your campaigns.
        </span>
      </p>
      <div className={pinned && main && !reading ? "finder-in__main cr-pin" : "finder-in__main"}>{btn}</div>
    </li>
  );
}

export function FindPage() {
  const f = useFinder();
  const setup = useSetup();
  const toast = useToast();
  const pin = usePinMain();
  const newsOff = useNewsOff();
  const saver = useWantSaver((m) => toast.error(m));
  const now = useNow(true, 60_000);

  const data = f.state === "ok" ? f.data : f.state === "error" ? f.data : null;
  const fresh = data?.state === "new";
  const [draft, setDraft] = useState<Partial<FinderWant>>({});
  const [wantOpen, setWantOpen] = useState(false);
  // null: the first match is open (the page just loaded); "": he folded them all.
  const [openId, setOpenId] = useState<string | null>(null);
  const [opened, setOpened] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<CampaignSummary[]>([]);
  const [newSet, setNewSet] = useState<Set<string>>(() => new Set());
  const [more, setMore] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [limitedUntil, setLimitedUntil] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  // The "New" chips: every uuid new on this visit stays new until he leaves (§41.4).
  useEffect(() => {
    if (data?.matches) setNewSet((prev) => freezeNew(prev, data.matches));
  }, [data?.matches]);

  // "Updating your matches…" only while the look is for his own change.
  const { setSent } = saver;
  useEffect(() => {
    if (data && data.state !== "looking") setSent(false);
  }, [data, setSent]);

  // seenAll 2 s after the matches showed while the page is visible (and again after a live refresh).
  const newKey = (data?.matches ?? [])
    .filter((m) => m.isNew)
    .map((m) => m.campaignId)
    .join(",");
  useEffect(() => {
    if (!newKey) return;
    const t = setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      void api()
        .crPatchFinder({ seenAll: true })
        .then((next) => {
          putFinder(next);
          void reloadCr();
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearTimeout(t);
  }, [newKey]);

  // A look runs: read again now and then too, in case the live news is late.
  useLivePoll(() => reloadFinder(), data?.state === "looking", 4000);

  // The visit's "You're in!" rows follow their campaign's live news (GET …/campaigns/{id}, §38.8).
  const refreshRow = useCallback(async (campaignId: string) => {
    try {
      const c = await api().crCampaign(campaignId);
      setAdded((rows) =>
        rows.map((r) =>
          r.campaignId === campaignId ? { ...r, nextStepKind: c.nextStep.kind, nextStepText: c.nextStep.text, chip: c.nextStep.chip, membership: c.membership, name: c.name } : r,
        ),
      );
    } catch {
      /* the row keeps what it has */
    }
  }, []);
  const addedRef = useRef(added);
  addedRef.current = added;
  useLiveEvents(
    (e) => {
      if (e.type !== "contentrewards" || !e.id.startsWith("campaign:")) return;
      const id = e.id.slice("campaign:".length);
      if (addedRef.current.some((r) => r.campaignId === id)) void refreshRow(id);
    },
    () => {
      for (const r of addedRef.current) void refreshRow(r.campaignId);
    },
  );
  const anyReading = added.some((r) => r.nextStepKind === "stop" && /^Reading the rules/.test(r.nextStepText));
  useLivePoll(
    async () => {
      for (const r of addedRef.current) if (r.nextStepKind === "stop") await refreshRow(r.campaignId);
    },
    anyReading,
    3000,
  );

  // By itself, once signed in: back to this window while a match was opened in the last 2 hours (§41.1).
  const openedAt = useCallback((m: FinderMatch) => opened[m.campaignId] ?? m.opened, [opened]);
  const recentOpen = !!data?.signedIn && (data.matches.some((m) => openedRecently(openedAt(m), now)) || Object.values(opened).some((at) => openedRecently(at, now)));
  const lastJoined = useRef(0);
  const onReturn = useCallback(() => {
    if (Date.now() - lastJoined.current < 2000) return;
    lastJoined.current = Date.now();
    void api()
      .crFinderJoined()
      .then((list) => {
        if (!list.length) return;
        setAdded((rows) => mergeAdded(rows, list));
        void reloadCr();
        void reloadFinder();
      })
      .catch(() => undefined);
  }, []);
  useCrOnReturn(onReturn, recentOpen);

  const ready = useMemo(() => readyPlaces(setup.data, data?.tiktokWaits ?? true), [setup.data, data?.tiktokWaits]);
  const accountCopies = useMemo(() => accountLinks(setup.data?.platforms), [setup.data]);

  if (f.state === "missing" || f.state === "soon")
    return (
      <div className="page page--narrow finder-page" data-help="cr-finder">
        <PageHeader title="Find campaigns" />
        <Note>{FINDER_SOON}</Note>
        <div className="cr-below">
          <LinkButton href={CAMPAIGNS_PATH} variant="glass" icon="layers">
            Your campaigns
          </LinkButton>
        </div>
      </div>
    );
  if (!data)
    return (
      <div className="page page--narrow finder-page" data-help="cr-finder">
        <PageHeader title="Find campaigns" lede={FIND_LEDE} />
        {f.state === "error" ? (
          <ErrorPanel message={LOAD_FAILED} onRetry={() => void f.reload()} />
        ) : (
          <>
            <Skeleton className="setup-skel" />
            <Skeleton className="setup-skel" />
          </>
        )}
      </div>
    );

  const want: FinderWant = fresh ? { ...WANT_DEFAULTS, ...data.want, ...draft } : { ...data.want, ...saver.shown };
  const placesNow = setup.data ? ready : data.resolvedPlaces;
  const noPlace = (fresh && placesNow.length === 0) || (data.state === "ok" && data.resolvedPlaces.length === 0);
  const setUpFirst = placeToSetUp(setup.data);
  const off = data.state === "off";
  const looking = data.state === "looking";
  const updating = looking && saver.sent;
  const list = shownMatches(data, hidden, added);
  const visible = list.slice(0, more ? 20 : FIRST_SHOWN);
  const openMatch = openId === "" ? null : (visible.find((m) => m.campaignId === openId) ?? visible[0] ?? null);
  const sourceTrouble = data.state === "down" || data.state === "blocked" || data.state === "not_allowed" || data.state === "unreadable";

  // The one vermilion (§41.1's table): never two, none while a look runs.
  const main: "start" | "setup" | "again" | "row" | "match" | null = off
    ? "again"
    : fresh
      ? noPlace
        ? "setup"
        : "start"
      : looking
        ? null
        : added.length
          ? "row"
          : data.state === "ok" && noPlace
            ? "setup"
            : openMatch
              ? "match"
              : null;

  const showWant = !off && (fresh || wantOpen);
  const limited = limitedUntil && Date.parse(limitedUntil) > now ? limitedUntil : data.nextAllowedAt && Date.parse(data.nextAllowedAt) > now ? data.nextAllowedAt : null;
  const line = noPlace && !fresh ? NO_PLACE_LINE : stateLine(data, updating);

  function change(patch: Partial<FinderWant>) {
    if (fresh) setDraft((d) => ({ ...d, ...patch }));
    else saver.change(patch);
  }

  async function start() {
    setStarting(true);
    try {
      putFinder(await api().crPatchFinder({ want: { ...WANT_DEFAULTS, ...draft, on: true } }));
      setDraft({});
      void reloadCr();
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setStarting(false);
    }
  }

  async function setOn(on: boolean, undoable: boolean) {
    try {
      putFinder(await api().crPatchFinder({ want: { on } }));
      void reloadCr();
      if (undoable) toast.undo("You stopped finding campaigns.", { onUndo: () => void setOn(true, false), onCommit: () => undefined });
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    }
  }

  async function lookAgain() {
    setChecking(true);
    try {
      const out = await api().crFinderCheck();
      if (out.started) void reloadFinder();
      else setLimitedUntil(out.nextAllowedAt);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setChecking(false);
    }
  }

  function openOnCr(m: FinderMatch) {
    // Set at once (the steps show even when the network fails); the PATCH is never awaited before the open.
    setOpened((o) => ({ ...o, [m.campaignId]: new Date().toISOString() }));
    setOpenId(m.campaignId);
    const send = () => api().crFinderSaid(m.campaignId, "opened");
    send().catch(() => {
      setTimeout(() => void send().catch(() => undefined), 2000);
    });
  }

  async function add(m: FinderMatch, rules: string) {
    setAdding(m.campaignId);
    setAddError((all) => {
      const next = { ...all };
      delete next[m.campaignId];
      return next;
    });
    try {
      await api().crFinderAdd(m.campaignId);
      // Not signed in, an open campaign: the pasted rules go right after (§38.4's rules_paste pair).
      if (!data!.signedIn && m.access === "open" && rules.trim()) await api().crReadCampaign(m.campaignId, rules.slice(0, RULES_MAX));
      void reloadCr();
      void reloadFinder();
      navigate(campaignPath(m.campaignId));
      return true;
    } catch (e) {
      setAddError((all) => ({ ...all, [m.campaignId]: friendlyMessage(e) }));
      return false;
    } finally {
      setAdding(null);
    }
  }

  function notForMe(m: FinderMatch) {
    const at = visible.findIndex((x) => x.campaignId === m.campaignId);
    if (openMatch?.campaignId === m.campaignId) setOpenId(visible[at + 1]?.campaignId ?? visible[at - 1]?.campaignId ?? null);
    setHidden((h) => new Set([...h, m.campaignId]));
    const back = () =>
      setHidden((h) => {
        const next = new Set(h);
        next.delete(m.campaignId);
        return next;
      });
    api()
      .crFinderSaid(m.campaignId, "not_for_me")
      .then(putFinder)
      .catch((e: unknown) => {
        back();
        toast.error(friendlyMessage(e));
      });
    toast.undo("Hidden.", {
      onUndo: () => {
        back();
        void api()
          .crFinderSaid(m.campaignId, null)
          .then(putFinder)
          .catch(() => undefined);
      },
      onCommit: () => undefined,
    });
  }

  async function bringBack() {
    try {
      putFinder(await api().crPatchFinder({ unhideAll: true }));
      setHidden(new Set());
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    }
  }

  async function ask() {
    setAsking(true);
    try {
      const out = await api().crFinderAsk();
      putFinder({ ...data!, askedAt: out.askedAt });
      toast.success("Sent. Thank you!");
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setAsking(false);
    }
  }

  const header = (
    <PageHeader
      title="Find campaigns"
      lede={
        <>
          {FIND_LEDE}
          {data.lastLookAt ? (
            <span className="finder-looked">
              <span>Looked at {clockTime(data.lastLookAt)}</span>
              {limited ? (
                <span className="finder-looked__limit">You can look again at {clockTime(limited)}.</span>
              ) : !fresh && !off ? (
                <Button variant="glass" size="sm" icon="retry" act="retry" loading={checking} onClick={lookAgain}>
                  Look again now
                </Button>
              ) : null}
            </span>
          ) : null}
        </>
      }
    />
  );

  if (off)
    return (
      <div className="page page--narrow finder-page" data-help="cr-finder">
        {header}
        <section className="finder-state glass" aria-live="polite">
          <p className="finder-state__text">
            <Icon name="info" size={20} />
            <span>You stopped finding campaigns.</span>
          </p>
          <div className="finder-state__main">
            <Button variant="primary" size="lg" icon="search" data-help-clear="" onClick={() => setOn(true, false)}>
              Find campaigns again
            </Button>
          </div>
        </section>
        <div className="cr-below">
          <OpenButton label="Look on Content Rewards yourself" href={CR_DISCOVER} icon="search" />
        </div>
      </div>
    );

  return (
    <div className="page page--narrow finder-page" data-help="cr-finder" data-state={data.state}>
      {header}

      {added.length ? (
        <ul className="finder-ins" aria-label="You're in">
          {added.map((c, i) => (
            <InRow key={c.campaignId} c={c} main={main === "row" && i === 0} pinned={pin} />
          ))}
        </ul>
      ) : null}

      {line && !fresh ? (
        <section className={`finder-state glass${looking ? " is-looking" : ""}`} aria-live="polite">
          <p className="finder-state__text">
            {looking ? <span className="spinner" aria-hidden="true" /> : <Icon name={sourceTrouble ? "alert" : "info"} size={20} />}
            <span>{line}</span>
          </p>
          {data.state === "ok" && !noPlace && !list.length && data.looked.pending > 0 && want.tellMe ? (
            <p className="finder-state__sub">You don&apos;t need to do anything. I&apos;ll tell you when one matches.</p>
          ) : null}
          {data.state === "ok" && noPlace ? (
            <div className="finder-state__main">
              <LinkButton href={setupPlaceHref(setUpFirst)} variant={main === "setup" ? "primary" : "glass"} size="lg" icon="link" data-help-clear={main === "setup" ? "" : undefined}>
                Set up {PLATFORM_LABEL[setUpFirst]}
              </LinkButton>
            </div>
          ) : null}
          {data.state === "ok" && !noPlace && !list.length && !data.looked.pending && !wantOpen ? (
            <div className="finder-state__main">
              <Button variant="glass" icon="sliders" onClick={() => setWantOpen(true)}>
                Change what you want
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      <WantCard
        finder={data}
        want={want}
        ready={ready}
        open={showWant}
        fresh={fresh}
        noPlace={noPlace}
        setUpFirst={setUpFirst}
        main={main === "start" || (fresh && main === "setup")}
        pinned={pin}
        newsOff={newsOff}
        starting={starting}
        onChange={change}
        onOpen={() => setWantOpen(true)}
        onDone={() => setWantOpen(false)}
        onStart={start}
        onKeepOne={() => toast.info("Keep at least one place.")}
      />

      {!fresh && visible.length ? (
        <section className={`finder-matches${updating ? " is-dim" : ""}`} aria-labelledby="finder-matches-title" inert={looking || undefined}>
          <h2 className="cr-section__title" id="finder-matches-title">
            Campaigns that match
          </h2>
          {sourceTrouble && (data.asOf || data.lastLookAt) ? <p className="finder-asof">As of {dayAndTime(data.asOf ?? data.lastLookAt)}</p> : null}
          <ul className="finder-list">
            {visible.map((m) => (
              <FinderMatchCard
                key={m.campaignId}
                match={m}
                open={openMatch?.campaignId === m.campaignId}
                isNew={newSet.has(m.campaignId)}
                openedAt={openedAt(m)}
                signedIn={data.signedIn}
                main={main === "match" && openMatch?.campaignId === m.campaignId}
                pinned={pin}
                adding={adding === m.campaignId}
                error={addError[m.campaignId] ?? null}
                copies={accountCopies}
                now={now}
                onToggle={() => setOpenId(openMatch?.campaignId === m.campaignId ? "" : m.campaignId)}
                onOpen={() => openOnCr(m)}
                onAdd={(rules) => add(m, rules)}
                onNotForMe={() => notForMe(m)}
              />
            ))}
          </ul>
          {!more && list.length > FIRST_SHOWN ? (
            <div className="cr-below">
              <Button variant="glass" icon="chevronDown" onClick={() => setMore(true)}>
                Show more
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      {!fresh ? (
        <div className="finder-quiet">
          <p>You join each campaign yourself on Content Rewards.</p>
          <p>
            {data.signedIn
              ? "Open campaigns show their rules only after you join. I read them right after."
              : "Open campaigns show their rules only after you join. Then I'll ask you to copy them here once."}
          </p>
          {data.skipped.length || data.looked.campaigns ? (
            <details className="cr-fold finder-why-not">
              <summary className="cr-fold__q">
                <Icon name="question" size={18} />
                <span>Why not more?</span>
                <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
              </summary>
              <div className="cr-fold__body">
                <p>{lookedLine({ looked: data.looked, matches: list })}</p>
                <ul className="finder-skipped">
                  {data.skipped.map((s) => (
                    <li key={s.code}>
                      {s.text}
                      {s.code === "hidden" ? (
                        <Button variant="ghost" size="sm" icon="undo" onClick={bringBack}>
                          Bring them back
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      <div className="cr-below">
        <OpenButton label="Look on Content Rewards yourself" href={CR_DISCOVER} icon="search" />
      </div>

      {data.signedIn && !fresh ? (
        <section className="finder-ask" data-help="cr-finder-ask" aria-labelledby="finder-ask-title">
          <h2 className="cr-section__title" id="finder-ask-title">
            Clip Factory can&apos;t join for you
          </h2>
          <p>Content Rewards has no way yet for apps to join. You can ask them to add one.</p>
          {data.askedAt ? (
            <p className="finder-ask__done">
              <Icon name="checkCircle" size={18} />
              <span>You asked Content Rewards on {shortDay(data.askedAt)}.</span>
            </p>
          ) : (
            <Button variant="glass" icon="comment" loading={asking} onClick={ask}>
              Ask Content Rewards
            </Button>
          )}
          <details className="cr-fold">
            <summary className="cr-fold__q">
              <Icon name="info" size={18} />
              <span>Show more</span>
              <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
            </summary>
            <div className="cr-fold__body">
              <p className="finder-ask__what">What it says</p>
              <p>This is what Clip Factory sends to Content Rewards&apos; team.</p>
              <blockquote className="finder-ask__msg">{ASK_MESSAGE}</blockquote>
            </div>
          </details>
        </section>
      ) : null}

      {!fresh ? (
        <div className="finder-stop">
          <Button variant="ghost" size="sm" icon="stop" onClick={() => setOn(false, true)}>
            Stop finding campaigns
          </Button>
        </div>
      ) : null}
    </div>
  );
}
