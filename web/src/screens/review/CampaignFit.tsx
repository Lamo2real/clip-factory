// Review › a campaign clip (docs/CONTRACTS.md §39.3): the fit block at the top of the card, "Campaign clip · FaZe
// Clips", the verdict's headline, its lines and the buttons that fix what Clip Factory can fix. The API decides the
// fit; the card only re-checks the four items that change while the owner types or taps (lib/crFit.ts). The block
// never adds a second vermilion: when it has its own main button (a copy, new clips, the one thing to do first)
// Upload steps back to glass; otherwise Upload is the screen's vermilion. A note asking to set up a skipped place
// ("X pays too. Set it up…") is left out; a campaign that pays only there keeps its own blocker.
import { useId, useState } from "react";
import type { CampaignFit as Fit, FitItem, FitState, Platform } from "../../api/types.ts";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { A, Button, LinkButton } from "../../components/ui.tsx";
import { herePath, withBack } from "../../lib/backLink.ts";
import { campaignPath } from "../../lib/contentRewards.ts";
import { checkLineText, checkPages, fitLines, fitMain, isChecked, isWait, safeFixHref, saveChecked, type CopyState } from "../../lib/crFit.ts";
import { FIND_PATH, finderHref, useFinderSummary } from "../../lib/finder.ts";
import { GreenButton, OpenButton } from "../campaigns/bits.tsx";
import { Rich } from "../settings/setup/bits.tsx";

export type { CopyState } from "../../lib/crFit.ts";

export const KEEP_IT_HERE = "Keep it here. Upload turns on by itself when it can go.";
export const COULDNT_CHECK = "I couldn't check these:";
export const READ_THEM = "I read them. They're OK";
export const making = (name: string) => `Making a ${name} copy… It shows here in about 3 minutes.`;
export const copyReady = (name: string) => `The ${name} copy is ready, right below. Upload the copy to earn money.`;
export const copyDone = (name: string) => `The ${name} copy is uploaded. You can throw this one away.`;

/** The copy's line (null when there is none to show). */
export function copyLine(copy: CopyState, name: string): string | null {
  return copy === "making" ? making(name) : copy === "ready" ? copyReady(name) : copy === "done" ? copyDone(name) : null;
}

const ICON: Record<FitState, IconName> = {
  no: "xCircle",
  todo: "info",
  remake: "scissors",
  fix: "edit",
  check: "question",
  note: "info",
  ok: "checkCircle",
};

/**
 * The fit without the notes that ask him to set up a skipped place ("Instagram pays too. Set it up to earn there as
 * well."): he chose to leave it out (rule S). Only those notes go: a place that is set up (its "Turn it on" note),
 * a todo or a no (the campaign's own rule, such as "Set up YouTube first.") all stay.
 */
export function withoutSkippedNotes(fit: Fit, skipped: readonly Platform[]): Fit {
  if (!skipped.length) return fit;
  const hidden = (i: FitItem) =>
    i.rule === "places" && i.state === "note" && i.fix?.kind === "open" && !!i.platform && skipped.includes(i.platform) && !fit.uploadPlaces.includes(i.platform);
  return fit.items.some(hidden) ? { ...fit, items: fit.items.filter((i) => !hidden(i)) } : fit;
}

const NO_SKIPS: readonly Platform[] = [];

/** One line of the block: an icon for its state (never colour alone) and the server's sentence. */
export function FitLine({ item, text }: { item: FitItem; text?: string }) {
  return (
    <li className={`cr-fit__line is-${item.state}`} data-rule={item.rule} data-state={item.state}>
      <Icon name={isWait(item) ? "clock" : ICON[item.state]} size={18} />
      <span>
        <Rich text={text ?? item.text} />
      </span>
    </li>
  );
}

/** A fix's link: a setup page gets the way back here (§39.1); Content Rewards' pages open in a new tab. */
function FixLink({ item, primary, label }: { item: FitItem; primary: boolean; label?: string }) {
  // §41.6 change 2: while the finder is on, Content Rewards' Discover becomes the Find page (same tab).
  const finderOn = !!useFinderSummary();
  const safe = safeFixHref(item.fix);
  const to = safe ? finderHref(safe.href, finderOn) : null;
  if (!to || !item.fix) return null;
  const text = label ?? item.fix.label;
  if (to.external) return <OpenButton label={text} href={to.href} primary={primary} size={primary ? "lg" : "md"} />;
  const href = withBack(to.href, herePath());
  return (
    <LinkButton
      href={href}
      variant={primary ? "primary" : "glass"}
      size={primary ? "lg" : "md"}
      icon={item.fix.kind === "new_clips" ? "scissors" : to.href === FIND_PATH ? "search" : "chevronRight"}
      data-help-clear={primary ? "" : undefined}
    >
      {text}
    </LinkButton>
  );
}

export function CampaignFit({
  clipId,
  fit: given,
  primary,
  copy = "none",
  onRemake,
  remaking = false,
  onFixCaptions,
  fixing = false,
  onBranded,
  onAdded,
  skipped = NO_SKIPS,
}: {
  clipId: string;
  /** The fit after the card's live check. */
  fit: Fit;
  /** The top card: the block's own main button (if it has one) is the screen's vermilion. */
  primary: boolean;
  copy?: CopyState;
  onRemake?: () => unknown;
  remaking?: boolean;
  /** "Fix it for me" (Review only: the card's captions). */
  onFixCaptions?: () => unknown;
  fixing?: boolean;
  /** "Turn on Branded content" (Review only: the card's TikTok choices). */
  onBranded?: () => unknown;
  /** "I added it" for a place Content Rewards doesn't know yet (Review only: the same relinked PATCH as its row). */
  onAdded?: (platform: Platform) => unknown;
  /** The skipped places (Settings.setupSkipped): their "Set it up" notes are left out. */
  skipped?: readonly Platform[];
}) {
  const id = useId();
  const fit = withoutSkippedNotes(given, skipped);
  const name = fit.campaignName;
  const oks = fit.items.filter((i) => i.state === "ok");
  const checks = fit.items.filter((i) => i.state === "check");
  const checkTexts = checks.map((i) => i.text);
  const [readNow, setReadNow] = useState(false);
  const [addedBusy, setAddedBusy] = useState(false);
  const checked = fit.verdict === "cant_tell" && (readNow || isChecked(clipId, fit.campaignId, checkTexts));
  const main = copy === "none" ? fitMain(fit) : null;
  const mainOn = primary && !!main;
  // What the lines say, by verdict (§39.3's "Then" column): one thing at a time.
  const { lines, folded } = fitLines(fit);
  const firstTodo = fit.verdict === "fixable" ? lines.find((i) => i.state === "todo") : undefined;
  // "Add YouTube in Content Rewards first. Then tap I added it.": its answer sits right next to its Open button.
  const addedPlace: Platform | null = firstTodo?.rule === "places" && firstTodo.platform && onAdded ? firstTodo.platform : null;
  const captionFix = lines.some((i) => i.fix?.kind === "captions");
  const branded = lines.find((i) => i.fix?.kind === "tiktok_branded");
  // Other pages to open (a setup page, Content Rewards' settings), one button each, never the main one twice.
  const opens: FitItem[] = [];
  const seen = new Set<string>(main?.fix?.href ? [main.fix.href] : []);
  for (const i of lines) {
    if (i === main || i.state === "check" || !i.fix || i.fix.kind !== "open" || !i.fix.href || seen.has(i.fix.href)) continue;
    seen.add(i.fix.href);
    opens.push(i);
  }
  // "Read the rules" once per page, never one per line (and never twice next to an Open of the same page).
  const pages = checkPages(fit.verdict === "cant_tell" && !checked ? checks : lines).filter((f) => !seen.has(f.href ?? ""));
  const headline = checked ? `You checked these for ${name}` : fit.headline;
  const ok = fit.verdict === "fits";
  const copyWords = copyLine(copy, name);
  const right = [...oks, ...folded];

  return (
    <section className={`cr-fit is-${fit.verdict}`} data-help="cr-review-strip cr-fit" data-verdict={fit.verdict} aria-labelledby={`${id}-h`}>
      <p className="cr-fit__for">
        <Icon name="coin" size={18} />
        <span>
          Campaign clip ·{" "}
          <A href={campaignPath(fit.campaignId)} className="text-link">
            <strong className="user-text">{name}</strong>
          </A>
        </span>
      </p>
      <h3 className={`cr-fit__headline${ok ? " is-ok" : ""}`} id={`${id}-h`}>
        {/* Only Clip Factory's own "Can earn" gets the check mark; his own check is an eye, never our tick. */}
        <Icon name={ok ? "checkCircle" : checked ? "eye" : fit.verdict === "wait" ? "clock" : fit.verdict === "doesnt_fit" ? "xCircle" : "info"} size={20} />
        <span>{headline}</span>
      </h3>

      {copyWords ? (
        <p className={`cr-fit__copy${copy === "making" ? "" : " is-ok"}`} role="status">
          {copyWords}
        </p>
      ) : null}

      {/* "I couldn't check these:" heads only its own lines: they sit together on a soft fill of their own, and the
          fix and note lines after them come in a list apart, with room between (never read as one list of six). */}
      {fit.verdict === "cant_tell" && !checked ? (
        <div className="cr-fit__checks">
          <p className="cr-fit__lead" id={`${id}-checks`}>
            {COULDNT_CHECK}
          </p>
          <ul className="cr-fit__lines" aria-labelledby={`${id}-checks`}>
            {checks.map((i) => (
              <FitLine key={`${i.rule}:${i.platform ?? ""}:${i.text}`} item={i} text={checkLineText(i.text)} />
            ))}
          </ul>
        </div>
      ) : null}

      {lines.length ? (
        <ul className="cr-fit__lines cr-fit__more">
          {lines.map((i) => (
            <FitLine key={`${i.rule}:${i.platform ?? ""}:${i.text}`} item={i} />
          ))}
        </ul>
      ) : null}
      {fit.verdict === "wait" ? <p className="cr-fit__keep">{KEEP_IT_HERE}</p> : null}

      <div className="cr-fit__actions">
        {main?.fix?.kind === "remake" && onRemake ? (
          <Button
            variant={mainOn ? "primary" : "glass"}
            size={mainOn ? "lg" : "md"}
            icon="scissors"
            loading={remaking}
            data-help-clear={mainOn ? "" : undefined}
            onClick={onRemake}
          >
            {main.fix.label}
          </Button>
        ) : main && main.fix?.kind !== "remake" ? (
          <FixLink item={main} primary={mainOn} />
        ) : null}
        {addedPlace ? (
          <GreenButton
            loading={addedBusy}
            onClick={async () => {
              setAddedBusy(true);
              try {
                return await onAdded!(addedPlace);
              } finally {
                setAddedBusy(false);
              }
            }}
          >
            I added it
          </GreenButton>
        ) : null}
        {branded && onBranded ? (
          <GreenButton size="lg" onClick={onBranded}>
            {branded.fix!.label}
          </GreenButton>
        ) : null}
        {captionFix && onFixCaptions ? (
          <Button variant="glass" icon="edit" act="tick" loading={fixing} onClick={onFixCaptions}>
            Fix it for me
          </Button>
        ) : null}
        {opens.map((i) => (
          <FixLink key={i.fix!.href} item={i} primary={false} />
        ))}
        {pages.map((f) => (
          <FixLink key={f.href} item={{ rule: "uncertain", state: "check", text: "", fix: f }} primary={false} />
        ))}
        {fit.verdict === "cant_tell" && !checked ? (
          <GreenButton
            onClick={() => {
              // His own answer, kept on this device only: it never changes Upload or the verdict.
              saveChecked(clipId, fit.campaignId, checkTexts);
              setReadNow(true);
            }}
          >
            {READ_THEM}
          </GreenButton>
        ) : null}
      </div>

      {checked ? (
        <details className="cr-fit__fold">
          <summary className="cr-fold__q">
            <span>You checked this ({checks.length})</span>
            <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
          </summary>
          <ul className="cr-fit__lines">
            {checks.map((i) => (
              <FitLine key={`${i.rule}:${i.text}`} item={i} />
            ))}
          </ul>
        </details>
      ) : null}
      {right.length ? (
        <details className="cr-fit__fold">
          <summary className="cr-fold__q">
            <span>See what&apos;s right ({right.length})</span>
            <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
          </summary>
          <ul className="cr-fit__lines">
            {right.map((i) => (
              <FitLine key={`${i.rule}:${i.platform ?? ""}:${i.text}`} item={i} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
