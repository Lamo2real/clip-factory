// A campaign card's one next step (docs/CONTRACTS.md §38.4): the chip, one sentence, and the screen's only vermilion
// button (pinned at the bottom right on phones while the card is on screen). Quiet green asks change only Clip
// Factory, each with an 8 s Undo. The rules box sits here when the owner has to copy the rules himself.
import { useId, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Campaign, SaidAnswer, StopCode } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, LinkButton } from "../../components/ui.tsx";
import { MEMBERSHIP_TEXT, SOFT_STOPS, forDevice, reloadCr, vermilionOf } from "../../lib/contentRewards.ts";
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

export function NextStepPanel({
  campaign,
  onCampaign,
  onPickLogo,
}: {
  campaign: Campaign;
  onCampaign: (c: Campaign) => void;
  /** "Add the logo" opens the logo's file picker. */
  onPickLogo: () => void;
}) {
  const toast = useToast();
  const step = forDevice(campaign.nextStep, isTouchDevice());
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
  let mainEl = null;
  if (inByHand) {
    mainEl = (
      <Button variant="primary" size="lg" icon="check" act="tick" loading={busy === "read"} data-help-clear="" onClick={() => readRules(box, true)}>
        I&apos;m in. Read these rules
      </Button>
    );
  } else if (typed) {
    mainEl = (
      <Button variant="primary" size="lg" icon="check" act="tick" loading={busy === "read"} data-help-clear="" onClick={() => readRules(box, step.kind === "check_yourself")}>
        {main}
      </Button>
    );
  } else if (step.button) {
    const b = step.button;
    if (b.action === "logo_picker")
      mainEl = (
        <Button variant="primary" size="lg" icon="image" data-help-clear="" onClick={onPickLogo}>
          {b.label}
        </Button>
      );
    else if (b.action === "said_applied")
      mainEl = (
        <Button variant="primary" size="lg" icon="check" act="tick" loading={busy === "applied"} data-help-clear="" onClick={() => patch({ said: "applied" }, "applied", undoSaid)}>
          {b.label}
        </Button>
      );
    else if (b.action === "anyway") {
      const codes = campaign.stops.filter((s) => !s.hard && SOFT_STOPS.includes(s.code) && s.code !== "not_connected" && !campaign.anyway.includes(s.code)).map((s) => s.code);
      mainEl = (
        <Button variant="primary" size="lg" icon="scissors" loading={busy === "anyway"} data-help-clear="" onClick={() => patch({ anyway: codes }, "anyway")}>
          {b.label}
        </Button>
      );
    } else if (b.href && b.external) mainEl = <OpenButton label={b.label} href={b.href} primary size="lg" />;
    else if (b.href)
      mainEl = (
        <LinkButton href={b.href} variant="primary" size="lg" icon={b.href.startsWith("/?campaign=") ? "scissors" : "link"} data-help-clear="" data-help={b.href.startsWith("/?campaign=") ? "cr-make-clips" : undefined}>
          {b.label}
        </LinkButton>
      );
  }

  const isIn = campaign.membership === "in" || campaign.membership === "manual";
  const reading = campaign.rulesState === "reading";
  const asks = step.asks ?? [];
  const connectFold = step.kind === "connect";

  return (
    <section className={`cr-next${isIn ? " is-in" : ""}`} data-help="cr-next-step" data-kind={step.kind} aria-labelledby="cr-next-title">
      <h2 className="cr-section__title" id="cr-next-title">
        Next step
      </h2>
      <p className="cr-next__text">
        {reading ? <span className="spinner" aria-hidden="true" /> : <Icon name={isIn ? "checkCircle" : step.kind === "wait" ? "clock" : "info"} size={20} />}
        <span>
          <Rich text={step.text} />
        </span>
      </p>
      {step.sub ? (
        <p className="cr-next__sub">
          <Rich text={step.sub} />
        </p>
      ) : null}
      {showBox ? <RulesBox value={box} onChange={setBox} /> : null}
      {mainEl ? <div className="cr-next__main">{mainEl}</div> : null}
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
              <GreenButton onClick={() => ask("joined_by_hand")} loading={busy === "joined_by_hand"}>
                It says Submit clip
              </GreenButton>
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
