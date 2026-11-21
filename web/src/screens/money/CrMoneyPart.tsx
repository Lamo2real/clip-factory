// Money › Content Rewards (/money#content-rewards, docs/CONTRACTS.md §38.7): Content Rewards' own numbers, tagged so,
// only formatted (never a rate × views, never added into the dashboard's totals), then the steps that move the money
// to Whop and on to the bank. One question first: "Do you see Finance in the Content Rewards menu?".
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { CrMoney } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A, Button, Segmented } from "../../components/ui.tsx";
import { burst } from "../../lib/confetti.ts";
import { CR_SETUP_PATH, MOVE_MIN_CENTS, amountText, patchCr, reloadCr, shortDay, usd, useCr, dayDate } from "../../lib/contentRewards.ts";
import { relative } from "../../lib/format.ts";
import { prefersReducedMotion } from "../../lib/prefs.ts";
import { cheerOnNextTap } from "../../lib/sound.ts";
import { sounds } from "../../lib/sounds.ts";
import { crPart } from "../../setup/contentrewards.ts";
import type { CrStep } from "../../setup/types.ts";
import { Rich } from "../settings/setup/bits.tsx";
import { CrStepCard } from "../campaigns/bits.tsx";

const MOVED_KEY = "cf-cr-on-its-way";

/**
 * What this device saw of the moves to Whop: what was on its way, the last amount moved, if one ever was, and the
 * API's last `movedAt` it already led with (so each move leads the bank step once on each device).
 */
export interface MovedMemo {
  onItsWay: number;
  lastMoveCents: number | null;
  moved: boolean;
  seenMovedAt: string | null;
}
export function readMoved(raw: string | null): MovedMemo {
  const none: MovedMemo = { onItsWay: 0, lastMoveCents: null, moved: false, seenMovedAt: null };
  if (!raw) return none;
  // Before this record: the plain number that was on its way.
  if (/^\d+$/.test(raw)) return { ...none, onItsWay: Number(raw), moved: Number(raw) > 0 };
  try {
    const m = JSON.parse(raw) as Partial<MovedMemo>;
    return {
      onItsWay: Number(m.onItsWay) || 0,
      lastMoveCents: typeof m.lastMoveCents === "number" ? m.lastMoveCents : null,
      moved: !!m.moved,
      seenMovedAt: typeof m.seenMovedAt === "string" ? m.seenMovedAt : null,
    };
  } catch {
    return none;
  }
}

/**
 * How long after a move to Whop a device that didn't see it still leads with the bank step: one day, so it means "just
 * finished" (§38.7). Later he may well have moved it to his bank already, which Clip Factory can't know.
 */
export const MOVED_FRESH_MS = 86_400_000;

/**
 * Did a move to Whop just finish, for this device? The API's `movedAt` when it sends one (any device: a move newer
 * than the last one this device led with, from the last day, with nothing on its way now); else, as before, only
 * what this device saw itself (On its way went back to 0 after being above 0).
 */
export function justMovedNow(before: MovedMemo, money: Pick<CrMoney, "onItsWayCents" | "movedAt">, now = Date.now()): boolean {
  const way = money.onItsWayCents;
  if (way === null) return false;
  const seenHere = before.onItsWay > 0 && way === 0;
  const at = money.movedAt ? Date.parse(money.movedAt) : NaN;
  if (!Number.isFinite(at)) return seenHere;
  const newer = money.movedAt !== before.seenMovedAt && (before.seenMovedAt === null || !(Date.parse(before.seenMovedAt) >= at));
  return way === 0 && (seenHere || (newer && now - at <= MOVED_FRESH_MS));
}

/** The money steps for the owner's answer about Finance (§38.7), in order. */
export function moneySteps(finance: boolean | undefined): CrStep[] {
  if (finance === undefined) return [];
  const want = finance ? "yes" : "no";
  return [...crPart("move").steps, ...crPart("bank").steps]
    .filter((s) => s.finance === want || s.finance === "both")
    .map((s) =>
      // With Finance, "the step above" is Set up payouts, not Link Whop.
      finance && s.id === "move-withdraw" && s.ifYouSee
        ? { ...s, ifYouSee: s.ifYouSee.map((h) => (/Connect payout account/.test(h.see) ? { ...h, do: "Do the step above: Set up payouts." } : h)) }
        : s,
    );
}

/**
 * The step whose Open is the part's one vermilion button, in the order a first-timer needs them: the once-steps
 * before the step that uses them. Money ready: link Whop (or Set up payouts) first, then Move money to Whop. Money
 * on its way: none (a calm line says so). Just arrived on Whop: Add your bank first, then Get it to your bank.
 * `done` holds the ticked steps (and move-whop once any move to Whop happened).
 */
export function moneyMainStep(steps: readonly CrStep[], money: CrMoney | null, done: readonly string[], justMoved: boolean): string | null {
  if (!steps.length) return null;
  const has = (id: string) => steps.some((s) => s.id === id);
  const finance = has("fin-setup");
  const setupFirst = finance ? "fin-setup" : "move-whop";
  if ((money?.readyToMoveCents ?? 0) >= MOVE_MIN_CENTS) return has(setupFirst) && !done.includes(setupFirst) ? setupFirst : "move-withdraw";
  if ((money?.onItsWayCents ?? 0) > 0) return null;
  if (justMoved) {
    if (finance) return "fin-bank";
    return has("bank-setup") && !done.includes("bank-setup") ? "bank-setup" : "bank-cashout";
  }
  return steps.find((s) => s.repeat === "once" && !done.includes(s.id))?.id ?? null;
}

/** The Amount copy chip: never 0.00, never the wrong number (the move step copies what is ready; the bank step what
 * was just moved, when this device saw it). */
export function amountChip(stepId: string, money: CrMoney | null, lastMoveCents: number | null): string | null {
  if (stepId === "move-withdraw") {
    const ready = money?.readyToMoveCents;
    return ready != null && ready >= MOVE_MIN_CENTS ? amountText(ready) : null;
  }
  if (stepId === "bank-cashout") return lastMoveCents != null && lastMoveCents > 0 ? amountText(lastMoveCents) : null;
  return null;
}

function Tile({ title, cents, hint, testid }: { title: string; cents: number | null; hint: string; testid: string }) {
  return (
    <div className="cr-tile glass" data-tile={testid}>
      <p className="cr-tile__title">{title}</p>
      <p className="cr-tile__num">{cents === null ? "Checking…" : usd(cents)}</p>
      <p className="cr-tile__hint">
        <Rich text={hint} />
      </p>
    </div>
  );
}

export function CrMoneyPart() {
  const cr = useCr();
  const toast = useToast();
  const [opened, setOpened] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [justMoved, setJustMoved] = useState(false);
  const [memo, setMemo] = useState<MovedMemo>(() => {
    try {
      return readMoved(localStorage.getItem(MOVED_KEY));
    } catch {
      return readMoved(null);
    }
  });
  const shown = useRef(new Set<string>());
  const autoTicked = useRef(false);

  const data = cr.state === "ok" ? cr.data : null;
  const money = data?.money ?? null;
  const conn = data?.connection ?? null;

  // A move to Whop just finished (on its way went back to 0 after being above 0): the bank steps lead. The amount
  // that moved is kept for the bank step's copy chip, and any move proves Whop is linked.
  useEffect(() => {
    if (!money || money.onItsWayCents === null) return;
    let before: MovedMemo = readMoved(null);
    try {
      before = readMoved(localStorage.getItem(MOVED_KEY));
    } catch {
      /* no storage: no "just moved" */
    }
    const way = money.onItsWayCents;
    const next: MovedMemo = {
      onItsWay: way,
      lastMoveCents: way > 0 ? way : before.lastMoveCents,
      // Any move proves Whop is linked, also one another device saw (the API's movedAt).
      moved: before.moved || way > 0 || !!money.movedAt,
      seenMovedAt: money.movedAt ?? before.seenMovedAt,
    };
    try {
      localStorage.setItem(MOVED_KEY, JSON.stringify(next));
    } catch {
      /* no storage */
    }
    setMemo(next);
    if (justMovedNow(before, money)) setJustMoved(true);
  }, [money]);

  // Any move to Whop proves Whop is linked: tick Link your Whop account by itself, once (§38.7, auto whop_linked).
  useEffect(() => {
    if (!memo.moved || autoTicked.current || !conn || conn.finance !== false || conn.stepsDone.includes("move-whop")) return;
    autoTicked.current = true;
    void api()
      .crPatchConnection({ step: "move-whop", done: true })
      .then((connection) => patchCr((d) => ({ ...d, connection })))
      .catch(() => undefined);
  }, [memo.moved, conn]);

  // Celebrations (§38.7, §38.11): confetti once each (not with reduced motion), the server told.
  useEffect(() => {
    for (const c of money?.celebrations ?? []) {
      if (shown.current.has(c.key)) continue;
      shown.current.add(c.key);
      if (!prefersReducedMotion()) burst(undefined, 140);
      cheerOnNextTap(sounds);
      toast.success(c.text);
      void api()
        .crSeen(c.key)
        .catch(() => undefined);
    }
  }, [money, toast]);

  if (cr.state === "missing" || cr.state === "loading") return null;

  async function setFinance(v: boolean | null) {
    setBusy("finance");
    try {
      const connection = await api().crPatchConnection({ finance: v });
      patchCr((d) => ({ ...d, connection }));
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function tick(step: CrStep, d: boolean) {
    setBusy(step.id);
    try {
      const connection = await api().crPatchConnection({ step: step.id, done: d });
      patchCr((o) => ({ ...o, connection }));
      setOpened(null);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function checkNow() {
    setChecking(true);
    try {
      const out = await api().crRefreshMoney();
      toast.info(out.started ? "Checking Content Rewards. The numbers change in a moment." : "Checked a moment ago. Try again in a few minutes.");
      void reloadCr();
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setChecking(false);
    }
  }

  const state = money?.state;
  // Any move to Whop means Whop is linked: Link your Whop account counts as done.
  const done = [...(conn?.stepsDone ?? []), ...(memo.moved ? ["move-whop"] : [])];
  const steps = moneySteps(conn?.finance);
  const main = moneyMainStep(steps, money, done, justMoved);
  const showTiles = !!money && (state === "ok" || state === "checking");
  const paidLine = money?.paidSoFarCents == null ? "Checking…" : `Content Rewards paid you ${usd(money.paidSoFarCents)} so far${money.lastPaidAt ? ` · last money ${dayDate(money.lastPaidAt)}` : ""}`;

  return (
    <section className="cr-money glass" id="content-rewards" data-help="cr-money" aria-labelledby="cr-money-title" tabIndex={-1}>
      <div className="dash-section-head">
        <h2 className="dash-section-title" id="cr-money-title">
          Content Rewards
        </h2>
        <span className="money-tag">Content Rewards&apos; numbers</span>
      </div>
      <p className="cr-money__lede">Whop is the website where Content Rewards sends your money. From there it goes to your bank.</p>

      {cr.state === "soon" ? (
        <p className="dash-grey">Content Rewards is coming soon to Clip Factory.</p>
      ) : cr.state === "error" && !money ? (
        <p className="dash-grey">{cr.error}</p>
      ) : state === "not_connected" ? (
        <p>
          <A href={CR_SETUP_PATH} className="text-link">
            Connect Content Rewards to see your campaign money.
          </A>
        </p>
      ) : state === "needs_reconnect" ? (
        <p>
          <A href={CR_SETUP_PATH} className="text-link">
            Sign in to Content Rewards again to see your money.
          </A>
        </p>
      ) : state === "none_yet" ? (
        <p>No campaign money yet. It shows here when the brand approves your clips.</p>
      ) : state === "error" ? (
        <p className="dash-grey">{money?.error ?? "Content Rewards didn't answer. Try again in a few minutes."}</p>
      ) : null}

      {showTiles && money ? (
        <>
          <div className="cr-tiles">
            <Tile testid="still" title="Still earning" cents={money.stillEarningCents} hint="Clips still earning. The amount can still change. (On Content Rewards: **Queued** and **Arriving**.)" />
            <Tile testid="way" title="On its way" cents={money.onItsWayCents} hint="Moving to your Whop balance." />
            <Tile testid="ready" title="Ready to move" cents={money.readyToMoveCents} hint="You can move this to Whop now. (On Content Rewards: **Balance**.)" />
          </div>
          {money.waitingForBrand > 0 ? (
            <p className="dash-grey">
              {money.waitingForBrand === 1 ? "1 clip is" : `${money.waitingForBrand} clips are`} waiting for the brand. Their money shows here after the brand says yes.
            </p>
          ) : null}
          <p className="cr-money__paid" data-paid-line="">
            {paidLine}
          </p>
          {/* A total shows only once Content Rewards' list was read to its end (§38.7). */}
          {money.campaigns.length && money.paidSoFarCents === null ? (
            <p className="dash-grey" data-campaign-totals="checking">
              Checking…
            </p>
          ) : money.campaigns.length ? (
            <ul className="cr-money__list" aria-label="Money per campaign">
              {money.campaigns.map((c) => (
                <li key={c.campaignId ?? c.name}>
                  <span className="user-text">{c.name}</span>
                  <span>
                    {usd(c.paidCents)} paid{c.pendingCents > 0 ? ` · ${usd(c.pendingCents)} still earning` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {money?.asOf ? <p className="dash-grey">Content Rewards&apos; numbers · checked {relative(money.asOf)}</p> : null}
      {conn && conn.status !== "not_connected" ? (
        <Button variant="glass" size="sm" icon="retry" act="retry" loading={checking} onClick={checkNow}>
          Check now
        </Button>
      ) : null}

      {conn && conn.status !== "not_connected" ? (
        <div className="cr-money__steps">
          <div className="gstep__picker">
            <span className="gstep__picker-label">
              <Rich text="Do you see **Finance** in the Content Rewards menu?" />
            </span>
            {conn.finance === undefined ? (
              <Segmented<"yes" | "no" | "">
                label="Do you see Finance in the Content Rewards menu?"
                value=""
                options={[
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                ]}
                onChange={(v) => void setFinance(v === "yes")}
              />
            ) : (
              <p className="gstep__note">
                <Icon name="checkCircle" size={18} />
                <span>{conn.finance ? "Yes, I see Finance." : "No Finance in my menu."}</span>
                <Button variant="ghost" size="sm" onClick={() => setFinance(null)} loading={busy === "finance"}>
                  Change my answer
                </Button>
              </p>
            )}
          </div>
          {steps.length && (money?.onItsWayCents ?? 0) > 0 && (money?.readyToMoveCents ?? 0) < MOVE_MIN_CENTS ? (
            <p className="gstep__note is-ok" role="status" data-cr="on-its-way">
              <Icon name="clock" size={18} />
              <span>Your {usd(money!.onItsWayCents)} is on its way to Whop. It usually takes minutes.</span>
            </p>
          ) : null}
          {steps.length ? (
            <ol className="guide-steps">
              {steps.map((step, i) => {
                const stepDone = step.repeat === "once" && done.includes(step.id);
                const isMain = main === step.id;
                const amount = amountChip(step.id, money, memo.lastMoveCents);
                return (
                  <CrStepCard
                    key={step.id}
                    step={step}
                    number={i + 1}
                    done={stepDone}
                    open={opened === step.id || (opened === null && isMain)}
                    current={isMain}
                    primary={isMain}
                    onToggle={() => setOpened((o) => (o === step.id ? "" : step.id))}
                    onDone={step.manual === false ? undefined : (d) => tick(step, d)}
                    busy={busy === step.id}
                    copies={amount ? [{ label: "Amount", value: amount }] : undefined}
                  >
                    {isMain && justMoved && (step.id === "bank-cashout" || step.id === "fin-bank") ? (
                      <p className="gstep__note is-ok">
                        <Icon name="checkCircle" size={18} />
                        <span>Your money is on Whop. Move it to your bank.</span>
                      </p>
                    ) : null}
                    {step.id === "move-withdraw" && (money?.onItsWayCents ?? 0) > 0 && (money?.readyToMoveCents ?? 0) >= MOVE_MIN_CENTS ? (
                      <p className="gstep__note is-ok">
                        <Icon name="checkCircle" size={18} />
                        <span>{usd(money!.onItsWayCents)} is on its way to Whop.</span>
                      </p>
                    ) : null}
                  </CrStepCard>
                );
              })}
            </ol>
          ) : null}
        </div>
      ) : null}
      {money?.lastPaidAt ? <span className="sr-only">Last money {shortDay(money.lastPaidAt)}</span> : null}
    </section>
  );
}
