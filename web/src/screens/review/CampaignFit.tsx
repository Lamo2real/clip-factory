// Review › a campaign clip (docs/CONTRACTS.md §39.3): the fit block at the top of the card, "Campaign clip · FaZe
// Clips", the verdict's headline, its lines and the buttons that fix what Clip Factory can fix. The API decides the
// fit; the card only re-checks the four items that change while the owner types or taps (lib/crFit.ts). The block
// never adds a second vermilion: when it has its own main button (a copy, new clips, the one thing to do first)
// Upload steps back to glass; otherwise Upload is the screen's vermilion.
import { useId, useState } from "react";
import type { CampaignFit as Fit, FitItem, FitState } from "../../api/types.ts";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { A, Button, LinkButton } from "../../components/ui.tsx";
import { herePath, withBack } from "../../lib/backLink.ts";
import { campaignPath } from "../../lib/contentRewards.ts";
import { checkPages, fitMain, isChecked, isWait, safeFixHref, saveChecked } from "../../lib/crFit.ts";
import { GreenButton, OpenButton } from "../campaigns/bits.tsx";
import { Rich } from "../settings/setup/bits.tsx";

/** Where the copy of this clip stands, as the Review list sees it. */
export type CopyState = "none" | "making" | "ready";

export const KEEP_IT_HERE = "Keep it here. Upload turns on by itself when it can go.";
export const COULDNT_CHECK = "I couldn't check these:";
export const READ_THEM = "I read them. They're OK";
export const making = (name: string) => `Making a ${name} copy… It shows here in about 3 minutes.`;
export const copyReady = (name: string) => `The ${name} copy is ready, right below. Upload the copy to earn money. You can throw this one away.`;

const ICON: Record<FitState, IconName> = {
  no: "xCircle",
  todo: "info",
  remake: "scissors",
  fix: "edit",
  check: "question",
  note: "info",
  ok: "checkCircle",
};

/** One line of the block: an icon for its state (never colour alone) and the server's sentence. */
export function FitLine({ item }: { item: FitItem }) {
  return (
    <li className={`cr-fit__line is-${item.state}`} data-rule={item.rule} data-state={item.state}>
      <Icon name={isWait(item) ? "clock" : ICON[item.state]} size={18} />
      <span>
        <Rich text={item.text} />
      </span>
    </li>
  );
}

/** A fix's link: a setup page gets the way back here (§39.1); Content Rewards' pages open in a new tab. */
function FixLink({ item, primary, label }: { item: FitItem; primary: boolean; label?: string }) {
  const to = safeFixHref(item.fix);
  if (!to || !item.fix) return null;
  const text = label ?? item.fix.label;
  if (to.external) return <OpenButton label={text} href={to.href} primary={primary} size={primary ? "lg" : "md"} />;
  const href = withBack(to.href, herePath());
  return (
    <LinkButton
      href={href}
      variant={primary ? "primary" : "glass"}
      size={primary ? "lg" : "md"}
      icon={item.fix.kind === "new_clips" ? "scissors" : "chevronRight"}
      data-help-clear={primary ? "" : undefined}
    >
      {text}
    </LinkButton>
  );
}

export function CampaignFit({
  clipId,
  fit,
  primary,
  copy = "none",
  onRemake,
  remaking = false,
  onFixCaptions,
  fixing = false,
  onBranded,
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
}) {
  const id = useId();
  const name = fit.campaignName;
  const problems = fit.items.filter((i) => i.state !== "ok");
  const oks = fit.items.filter((i) => i.state === "ok");
  const checks = problems.filter((i) => i.state === "check");
  const checkTexts = checks.map((i) => i.text);
  const [readNow, setReadNow] = useState(false);
  const checked = fit.verdict === "cant_tell" && (readNow || isChecked(clipId, fit.campaignId, checkTexts));
  const main = copy === "none" ? fitMain(fit) : null;
  const mainOn = primary && !!main;
  const firstTodo = fit.verdict === "fixable" ? problems.find((i) => i.state === "todo") : undefined;
  // What the lines say, by verdict (§39.3's "Then" column). Problems first; one thing at a time for a todo.
  const lines =
    fit.verdict === "fixable" && firstTodo
      ? [firstTodo, ...problems.filter((i) => i.state !== "todo")]
      : fit.verdict === "cant_tell"
        ? problems.filter((i) => i.state !== "check")
        : problems;
  const captionFix = problems.some((i) => i.fix?.kind === "captions");
  const branded = problems.find((i) => i.fix?.kind === "tiktok_branded");
  // Other pages to open (a setup page, Content Rewards' settings), one button each, never the main one twice.
  const opens: FitItem[] = [];
  const seen = new Set<string>();
  for (const i of lines) {
    if (i === main || i.state === "check" || !i.fix || i.fix.kind !== "open" || !i.fix.href || seen.has(i.fix.href)) continue;
    seen.add(i.fix.href);
    opens.push(i);
  }
  // "Read the rules" once per page, never one per line (and never twice next to an Open of the same page).
  const pages = checkPages(fit.verdict === "cant_tell" && !checked ? checks : lines).filter((f) => !seen.has(f.href ?? ""));
  const headline = checked ? `You checked these for ${name}` : fit.headline;
  const ok = fit.verdict === "fits";

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
        <Icon name={ok || checked ? "checkCircle" : fit.verdict === "wait" ? "clock" : fit.verdict === "doesnt_fit" ? "xCircle" : "info"} size={20} />
        <span>{headline}</span>
      </h3>

      {copy === "making" ? <p className="cr-fit__copy" role="status">{making(name)}</p> : null}
      {copy === "ready" ? <p className="cr-fit__copy is-ok" role="status">{copyReady(name)}</p> : null}

      {fit.verdict === "wait" ? (
        <>
          <ul className="cr-fit__lines">
            {problems.filter(isWait).map((i) => (
              <FitLine key={`${i.rule}:${i.text}`} item={i} />
            ))}
          </ul>
          <p className="cr-fit__keep">{KEEP_IT_HERE}</p>
        </>
      ) : null}

      {lines.length && fit.verdict !== "wait" ? (
        <ul className="cr-fit__lines">
          {lines.map((i) => (
            <FitLine key={`${i.rule}:${i.platform ?? ""}:${i.text}`} item={i} />
          ))}
        </ul>
      ) : null}
      {fit.verdict === "wait" && problems.some((i) => !isWait(i)) ? (
        <ul className="cr-fit__lines">
          {problems
            .filter((i) => !isWait(i))
            .map((i) => (
              <FitLine key={`${i.rule}:${i.platform ?? ""}:${i.text}`} item={i} />
            ))}
        </ul>
      ) : null}

      {fit.verdict === "cant_tell" && !checked ? (
        <div className="cr-fit__checks">
          <p className="cr-fit__lead">{COULDNT_CHECK}</p>
          <ul className="cr-fit__lines">
            {checks.map((i) => (
              <FitLine key={`${i.rule}:${i.platform ?? ""}:${i.text}`} item={i} />
            ))}
          </ul>
        </div>
      ) : null}

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
      {oks.length ? (
        <details className="cr-fit__fold">
          <summary className="cr-fold__q">
            <span>See what&apos;s right ({oks.length})</span>
            <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
          </summary>
          <ul className="cr-fit__lines">
            {oks.map((i) => (
              <FitLine key={`${i.rule}:${i.platform ?? ""}:${i.text}`} item={i} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
