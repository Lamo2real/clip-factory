// Clips Funded › Social accounts › one platform (docs/CONTRACTS.md §45.13, §45.16.7, §45.34): the page each row of
// Social accounts opens (/stories/connections/<p>), and where the OAuth callback lands (social_callback.landing). It
// holds everything the platform's card holds (Connections.tsx PlatformCard, unchanged): the account, what needs the
// owner, its one main button and the More fold with the developer app, its keys and limits, Check now and Disconnect.
// A skipped platform says so at the top with Un-skip (connecting drops the skip by itself, the server's rule). After a
// sign-in the result is said once, a connect with the account it connected ("Connected as {name} ({handle})"), and the
// card asks "Is this your Clips Funded {place}?"; then the address is this page's own, so a reload never repeats it.
import { useEffect, useRef, useState } from "react";
import { A } from "../../components/ui.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { navigate } from "../../lib/router.ts";
import { storiesApi } from "../api/client.ts";
import type { Platform, SocialAccount } from "../api/types.ts";
import { storiesDeniedSound, storiesSound } from "../prefs.ts";
import { socialHref, useSkip } from "../skips.ts";
import { celebrate, PLATFORM_NAME, refreshDashboard, refreshOnboarding, StButton, StError, StIcon, StLoading } from "../ui.tsx";
import { connectedAsSentence, DisconnectedNote, isPlatform, PlatformCard, resultSentence, SetupBack, useSocial } from "./Connections.tsx";
import type { StoriesScreenProps } from "./types.ts";

/** A platform's own page under Social accounts. */
export function ConnectionScreen({ ws, page }: StoriesScreenProps) {
  if (page.name !== "connection" || !isPlatform(page.platform)) return null;
  return <PlatformPage key={page.platform} ws={ws} platform={page.platform} result={page.result} />;
}

function PlatformPage({ ws, platform, result }: { ws: string; platform: Platform; result: string | null }) {
  const toast = useToast();
  const social = useSocial(ws);
  const { reload, setData } = social;
  const skips = useSkip(ws, social.reload);
  const [gone, setGone] = useState<{ platform: Platform; choice: SocialAccount["app"]["choice"] } | null>(null);
  // The platform just connected: its card asks whether this is the intended account (§45.34).
  const [asking, setAsking] = useState<Platform | null>(null);
  const shown = useRef<string | null>(null);
  const name = PLATFORM_NAME[platform];

  // The callback's result, once, then the address goes back to the platform's own page (a reload never repeats it). A
  // connect is said with the account it connected ("Connected as {name} ({handle})"), read fresh from the server.
  useEffect(() => {
    // Back on the plain page: the next landing (a second Connect from this page) is shown again.
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
    navigate(socialHref(platform), { replace: true });
  }, [result, platform, toast, reload, setData, ws]);

  const a = social.data?.accounts.find((x) => x.platform === platform);
  const busy = skips.busy !== null;
  const here = useRef<HTMLElement>(null);
  // Un-skip takes its note (and the button with it) away: the keyboard's place moves to the card's name, never lost.
  // Set before the save, since the page may show the platform back before the save's promise settles.
  const focusCard = useRef(false);
  const skippedNow = !!a?.skipped;
  useEffect(() => {
    if (skippedNow || !focusCard.current) return;
    focusCard.current = false;
    const now = document.activeElement;
    if (now && now !== document.body && now.isConnected) return;
    const heading = here.current?.querySelector<HTMLElement>(".st-conn__name");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [skippedNow]);
  const unskip = async () => {
    focusCard.current = true;
    if (!(await skips.unskip(platform))) focusCard.current = false;
  };
  return (
    <section className="st-page st-connections st-social-one" data-platform={platform} ref={here}>
      <nav aria-label="Breadcrumb" className="st-crumbs st-plate">
        <A href="/stories/connections" className="st-textlink st-crumbs__link">
          Social accounts
        </A>
        <span className="st-crumbs__sep" aria-hidden="true">
          {" › "}
        </span>
        <span className="st-crumbs__here" aria-current="page">
          {name}
        </span>
      </nav>
      <SetupBack ws={ws} />
      {a?.skipped ? (
        // Not a live region: it is there when the page opens, and its Un-skip button must not sit inside one.
        <p className="st-note st-note--sky st-social-one__skipped">
          <StIcon name="bulb" size={18} />
          <span className="st-social-one__skipped-text">
            You skipped {name}. You won't post there until you set it up.
          </span>
          <StButton
            aria-label={`Un-skip ${name}`}
            aria-disabled={busy || undefined}
            onClick={() => {
              // Kid-proof: never disabled; a tap while it saves only says no.
              if (busy) return storiesDeniedSound();
              void unskip();
            }}
          >
            Un-skip
          </StButton>
        </p>
      ) : null}
      {gone ? <DisconnectedNote choice={gone.choice} onClose={() => setGone(null)} /> : null}
      {/* The card's name is the page's h1; until the card shows, the page still has one. */}
      {!a ? <h1 className="sr-only">{name}</h1> : null}
      {social.error && !social.data ? (
        <StError message={social.error} onRetry={() => void social.reload()} />
      ) : !social.data ? (
        <StLoading label="Checking the accounts…" />
      ) : !a ? (
        <StError message="We could not find that account. Open Social accounts." />
      ) : (
        <ul className="st-conns st-conns--one">
          <PlatformCard
            headingLevel={1}
            ws={ws}
            a={a}
            all={social.data.accounts}
            clips={social.data.clips.find((c) => c.platform === platform)}
            onChanged={social.reload}
            onDisconnected={(p, choice) => setGone({ platform: p, choice })}
            askIntended={asking === platform}
            onAnswered={() => setAsking(null)}
          />
        </ul>
      )}
    </section>
  );
}
