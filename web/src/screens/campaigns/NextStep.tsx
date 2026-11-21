// A campaign card's one next step (docs/CONTRACTS.md §38.4): the chip, one sentence, and the screen's only vermilion
// button (pinned at the bottom right on phones while the card is on screen). Quiet green asks change only Clip
// Factory, each with an 8 s Undo. The rules box sits here when the owner has to copy the rules himself.
import { useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Campaign, SaidAnswer, StopCode } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, LinkButton } from "../../components/ui.tsx";
import { CR_SETUP_PATH, MEMBERSHIP_TEXT, SOFT_STOPS, crSetupFor, forDevice, refused, reloadCr, signedIn, useCr, vermilionOf } from "../../lib/contentRewards.ts";
import { withBack } from "../../lib/backLink.ts";
import { isTouchDevice } from "../../lib/crConnect.ts";
import { Rich } from "../settings/setup/bits.tsx";
import { GreenButton, OpenButton } from "./bits.tsx";

export const RULES_MAX = 8000;

const SAID_SAVED: Record<SaidAnswer, string> = {
  applied: "Saved: you applied.",
  not_eligible: "Saved: the brand said no.",
  joined_by_hand: "Saved: you're in.",
};

/** The rules box (≤ 8,000 characters): "Copy everything under Brief and Content requirements. Paste it here." */
export function RulesBox({ value, onChange, label = "The campaign's rules" }: { value: string; onChange: (v: string) => void; label?: string }) {
  const id = useId();
  return (
    <div className="field cr-rules-box">
      <label className="field__label" htmlFor={`${id}-rules`}>
        {label}
      </label>
      <textarea
        id={`${id}-rules`}
        className="input textarea"
        rows={5}
        maxLength={RULES_MAX}
        placeholder="Paste everything under Brief and Content requirements here."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="counter">
        {value.length} / {RULES_MAX.toLocaleString("en-US")}
      </span>
    </div>
  );
}

/** "Check it yourself" and "paste the rules" as two short numbered lines (one action each, §38.1). */
export const CHECK_YOURSELF_LEAD = "Content Rewards hasn't let Clip Factory look yet.";
export const CHECK_YOURSELF_LINES = [
  "Tap Open campaign. Does it say **Submit clip**? Then you're in.",
  "Copy everything under **Brief** and **Content requirements**. Paste it in the box. Tap I'm in. Read these rules.",
] as const;
export const RULES_PASTE_LINES = [
  "Tap Open campaign.",
  "Copy everything under **Brief** and **Content requirements**. Paste it in the box. Tap Read these rules.",
] as const;
/** A manual campaign while Content Rewards hasn't let Clip Factory send (a connect can't help yet). */
export const MANUAL_REFUSED = "Content Rewards hasn't said yes to Clip Factory yet, so you send each clip yourself. I'll remind you after each post.";

export function NextStepPanel({
  campaign,
  onCampaign,
  onPickLogo,
  pinSlot = null,
  quiet = false,
  justIn = false,
}: {
  campaign: Campaign;
  onCampaign: (c: Campaign) => void;
  /** "Add the logo" opens the logo's file picker. */
  onPickLogo: () => void;
  /** Phones: the end of the card, where the main button is pinned at the bottom right (§38.1). */
  pinSlot?: HTMLElement | null;
  /** A clip waits to be sent now: its Copy and open is the screen's vermilion, so this step's button is glass. */
  quiet?: boolean;
  /** "You're in!" was just celebrated on this visit: the step says so first. */
  justIn?: boolean;
}) {
  const toast = useToast();
  const cr = useCr();
  const conn = cr.state === "ok" ? cr.data.connection : null;
  // Every link to a setup page leads back to this card (§39.1): the API's own href already does; an older one gets it.
  const served = campaign.nextStep;
  const withWayBack: typeof served = served.button?.href?.startsWith(CR_SETUP_PATH)
    ? { ...served, button: { ...served.button, href: withBack(served.button.href, `/campaigns/${campaign.campaignId}`) } }
    : served;
  const step = forDevice(withWayBack, isTouchDevice());
  const [box, setBox] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // "It says Submit clip" while the rules can't be read: the box opens at once (saying you're in and giving the
  // rules is one step).
  const [inByHand, setInByHand] = useState(false);
  const rulesHidden = campaign.rulesState === "waiting_for_join" || (campaign.rulesState === "ready" && campaign.plainRules.length === 0);
  const showBox = step.kind === "check_yourself" || step.kind === "rules_paste" || inByHand;

  async function patch(body: { said?: SaidAnswer | null; anyway?: StopCode[] }, what: string, undo?: () => void) {
    setBusy(what);
    try {
      const next = await api().crPatchCampaign(campaign.campaignId, body);
      onCampaign(next);
      void reloadCr();
      if (body.said) toast.undo(SAID_SAVED[body.said], { onUndo: () => undo?.(), onCommit: () => undefined });
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const undoSaid = () => void patch({ said: null }, "undo");

  async function readRules(text: string, sayIn: boolean) {
    if (!text.trim()) {
      toast.info("Paste the rules in the box first.");
      return false;
    }
    setBusy("read");
    try {
      if (sayIn) await api().crPatchCampaign(campaign.campaignId, { said: "joined_by_hand" });
      const next = await api().crReadCampaign(campaign.campaignId, text.slice(0, RULES_MAX));
      onCampaign(next);
      setBox("");
      setInByHand(false);
      void reloadCr();
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  function ask(said: SaidAnswer) {
    if (said === "joined_by_hand" && rulesHidden && step.kind !== "check_yourself") {
      setInByHand(true);
      return;
    }
    void patch({ said }, said, undoSaid);
  }

  // The one vermilion control (never two): the step's button, or the rules box's once it has text.
  const main = vermilionOf(step, showBox ? box : "");
  const typed = showBox && box.trim().length > 0;
  const v = quiet ? "glass" : "primary";
  const clear = quiet ? undefined : "";
  let mainEl: ReactNode = null;
  if (inByHand) {
    mainEl = (
      <Button variant={v} size="lg" icon="check" act="tick" loading={busy === "read"} data-help-clear={clear} onClick={() => readRules(box, true)}>
        I&apos;m in. Read these rules
      </Button>
    );
  } else if (typed) {
    mainEl = (
      <Button variant={v} size="lg" icon="check" act="tick" loading={busy === "read"} data-help-clear={clear} onClick={() => readRules(box, step.kind === "check_yourself")}>
        {main}
      </Button>
    );
  } else if (step.button) {
    const b = step.button;
    if (b.action === "logo_picker")
      mainEl = (
        <Button variant={v} size="lg" icon="image" data-help-clear={clear} onClick={onPickLogo}>
          {b.label}
        </Button>
      );
    else if (b.action === "said_applied")
      mainEl = (
        <Button variant={v} size="lg" icon="check" act="tick" loading={busy === "applied"} data-help-clear={clear} onClick={() => patch({ said: "applied" }, "applied", undoSaid)}>
          {b.label}
        </Button>
      );
    else if (b.action === "anyway") {
      // The API keeps exactly the list it gets (PATCH replaces `anyway`), so every soft stop he ever accepted goes
      // with the new one: else each tap would un-accept the one before.
      const now = campaign.stops.filter((s) => !s.hard && SOFT_STOPS.includes(s.code) && s.code !== "not_connected").map((s) => s.code);
      const codes = [...new Set([...campaign.anyway.filter((c) => SOFT_STOPS.includes(c) && c !== "not_connected"), ...now])];
      mainEl = (
        <Button variant={v} size="lg" icon="scissors" loading={busy === "anyway"} data-help-clear={clear} onClick={() => patch({ anyway: codes }, "anyway")}>
          {b.label}
        </Button>
      );
    } else if (b.href && b.external) mainEl = <OpenButton label={b.label} href={b.href} primary={!quiet} size="lg" />;
    else if (b.href)
      mainEl = (
        <LinkButton href={b.href} variant={v} size="lg" icon={b.href.startsWith("/?campaign=") ? "scissors" : "link"} data-help-clear={clear} data-help={b.href.startsWith("/?campaign=") ? "cr-make-clips" : undefined}>
          {b.label}
        </LinkButton>
      );
  }
  // While he has typed the rules, Open campaign (the first thing those lines say) still has a button, above the box.
  const openAboveBox = typed && !inByHand && (step.kind === "check_yourself" || step.kind === "rules_paste") && step.button?.href;
  const lines = step.kind === "check_yourself" ? CHECK_YOURSELF_LINES : step.kind === "rules_paste" && campaign.rulesState !== "failed" ? RULES_PASTE_LINES : null;
  // A manual campaign without a connection: the line names a button that is here (or says connecting can't help yet).
  const manualNote =
    step.kind === "make_clips" && campaign.membership === "manual" && !signedIn(conn) ? (refused(conn) ? MANUAL_REFUSED : step.sub ?? null) : null;
  const sub = manualNote ? null : step.sub;
  const mainWrap = mainEl ? <div className={pinSlot ? "cr-next__main is-pinned" : "cr-next__main"}>{mainEl}</div> : null;

  const isIn = campaign.membership === "in" || campaign.membership === "manual";
  const reading = campaign.rulesState === "reading";
  const asks = step.asks ?? [];
  const connectFold = step.kind === "connect";

  return (
    <section className={`cr-next${isIn ? " is-in" : ""}`} data-help="cr-next-step" data-kind={step.kind} aria-labelledby="cr-next-title">
      <h2 className="cr-section__title" id="cr-next-title">
        Next step
      </h2>
      {justIn && !/^You're in!/.test(step.text) ? (
        <p className="cr-next__text cr-next__in">
          <Icon name="checkCircle" size={20} />
          <strong>You&apos;re in!</strong>
        </p>
      ) : null}
      {lines && step.kind === "check_yourself" ? (
        <p className="cr-next__text">
          <Icon name="info" size={20} />
          <span>{CHECK_YOURSELF_LEAD}</span>
        </p>
      ) : null}
      {lines ? (
        <ol className="cr-next__lines">
          {lines.map((l, i) => (
            <li key={l}>
              <span className="cr-next__n" aria-hidden="true">
                {i + 1}
              </span>
              <span>
                <Rich text={l} />
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="cr-next__text">
          {reading ? <span className="spinner" aria-hidden="true" /> : <Icon name={isIn ? "checkCircle" : step.kind === "wait" ? "clock" : "info"} size={20} />}
          <span>
            <Rich text={step.text} />
          </span>
        </p>
      )}
      {sub ? (
        <p className="cr-next__sub">
          <Rich text={sub} />
        </p>
      ) : null}
      {manualNote ? (
        <div className="cr-next__glass">
          <p className="cr-next__sub">
            <Rich text={manualNote} />
          </p>
          {manualNote !== MANUAL_REFUSED ? (
            <LinkButton href={crSetupFor(campaign.campaignId)} variant="glass" icon="link">
              Connect Content Rewards
            </LinkButton>
          ) : null}
        </div>
      ) : null}
      {openAboveBox && step.button?.href ? (
        <div className="cr-next__glass">
          <OpenButton label={step.button.label} href={step.button.href} />
        </div>
      ) : null}
      {showBox ? <RulesBox value={box} onChange={setBox} /> : null}
      {mainWrap && pinSlot ? createPortal(mainWrap, pinSlot) : mainWrap}
      {!connectFold && step.glass?.length ? (
        <div className="cr-next__glass">
          {step.glass.map((g) => (g.external ? <OpenButton key={g.label} label={g.label} href={g.href} /> : <LinkButton key={g.label} href={g.href} variant="glass">{g.label}</LinkButton>))}
        </div>
      ) : null}
      {connectFold ? (
        <details className="cr-fold">
          <summary className="cr-fold__q">
            <Icon name="info" size={18} />
            <span>Can&apos;t connect now?</span>
            <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
          </summary>
          <div className="cr-fold__body">
            <p>
              <Rich text={MEMBERSHIP_TEXT.cantConnect} />
            </p>
            <div className="cr-next__asks">
              <OpenButton label="Open campaign" href={campaign.url} />
              {inByHand ? (
                <Button variant="ghost" size="sm" onClick={() => patch({ said: "joined_by_hand" }, "joined_by_hand", undoSaid).then((ok) => (setInByHand(false), ok))}>
                  There are no rules to copy
                </Button>
              ) : (
                <GreenButton onClick={() => ask("joined_by_hand")} loading={busy === "joined_by_hand"}>
                  It says Submit clip
                </GreenButton>
              )}
            </div>
          </div>
        </details>
      ) : asks.length || inByHand ? (
        <div className="cr-next__asks">
          {inByHand ? (
            <Button variant="ghost" size="sm" onClick={() => patch({ said: "joined_by_hand" }, "joined_by_hand", undoSaid).then((ok) => (setInByHand(false), ok))}>
              There are no rules to copy
            </Button>
          ) : (
            asks.map((a) => (
              <span key={a.said} className="cr-ask">
                {a.text ? (
                  <span className="cr-ask__text">
                    <Rich text={a.text} />
                  </span>
                ) : null}
                <GreenButton size="sm" onClick={() => ask(a.said)} loading={busy === a.said}>
                  {a.label}
                </GreenButton>
              </span>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}
