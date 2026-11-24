// The "Paste a Content Rewards campaign link" box (docs/CONTRACTS.md §38.4) and the group picker: one card per
// sibling of a group link, tapping one adds it. Used by the Campaigns page; Home's own box adds through `addCampaign`.
import { useId, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { GroupChoice } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { ActGlyph, Button } from "../../components/ui.tsx";
import { campaignPath, pasteByHand, payLine, reloadCr } from "../../lib/contentRewards.ts";
import { campaignLink } from "../../lib/links.ts";
import { useAction } from "../../lib/motion.ts";
import { clipsGoLater } from "../../app/shell.ts";
import { Rich } from "../settings/setup/bits.tsx";
import { BrandText } from "./bits.tsx";

export type AddOutcome = { kind: "added"; campaignId: string } | { kind: "group"; name: string; choices: GroupChoice[] } | { kind: "failed"; message: string };

/** POST /v1/contentrewards/campaigns: the campaign's page opens, or the group's choices come back. */
export async function addCampaign(url: string): Promise<AddOutcome> {
  try {
    const out = await api().crAddCampaign(url);
    void reloadCr();
    if (out.group) return { kind: "group", name: out.group.name, choices: out.group.choices };
    return { kind: "added", campaignId: out.campaign.campaignId };
  } catch (e) {
    return { kind: "failed", message: friendlyMessage(e) };
  }
}

export function GroupPicker({ name, choices, onPicked }: { name: string; choices: GroupChoice[]; onPicked?: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function pick(c: GroupChoice) {
    setBusy(c.campaignId);
    const out = await addCampaign(c.url);
    setBusy(null);
    if (out.kind === "added") {
      onPicked?.();
      clipsGoLater(campaignPath(out.campaignId));
      return true;
    }
    toast.error(out.kind === "failed" ? out.message : "Tap one campaign.");
    return false;
  }
  return (
    <section className="cr-group glass" aria-labelledby="cr-group-title" role="region">
      <h2 className="cr-group__title" id="cr-group-title">
        This link is a group of campaigns. Tap the one you want.
      </h2>
      <p className="cr-group__name user-text">{name}</p>
      <ul className="cr-group__list">
        {choices.map((c) => (
          <li key={c.campaignId}>
            <button type="button" className="cr-choice" onClick={() => void pick(c)} aria-busy={busy === c.campaignId || undefined}>
              <span className="cr-choice__text">
                <BrandText text={c.name} className="cr-choice__name" />
                {c.brand ? <span className="cr-choice__brand user-text">{c.brand}</span> : null}
                {c.pay?.length ? <span className="cr-choice__pay">{payLine(c.pay[0]!, "cpm")}</span> : null}
                {c.access ? <span className="cr-choice__pay">{c.access === "open" ? "Open to everyone" : "The brand picks creators (you apply)"}</span> : null}
              </span>
              {busy === c.campaignId ? <span className="spinner" aria-hidden="true" /> : <Icon name="chevronRight" size={20} />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The paste box at the top of Campaigns. `primary`: "Add campaign" is the screen's vermilion once a link is in it. */
export function CampaignPasteBox({ onGroup, onTyped }: { onGroup: (g: { name: string; choices: GroupChoice[] }) => void; onTyped?: (hasLink: boolean) => void }) {
  const id = useId();
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pasteAct = useAction("paste");
  const addAct = useAction("add");
  const link = campaignLink(text);
  const isLink = link.kind === "campaign";

  function take(value: string) {
    setText(value);
    setError(null);
    onTyped?.(campaignLink(value).kind === "campaign");
  }

  async function paste() {
    try {
      const got = await navigator.clipboard.readText();
      if (!got.trim()) {
        pasteAct.fail({ sound: false });
        toast.info("Nothing is copied yet. On Content Rewards tap the share icon, then Copy campaign link.");
        return;
      }
      take(got.trim());
    } catch {
      pasteAct.fail({ sound: false });
      document.getElementById(`${id}-box`)?.focus();
      toast.info(pasteByHand());
    }
  }

  async function add() {
    if (link.kind === "refused") {
      setError(link.message);
      return false;
    }
    if (link.kind !== "campaign") {
      setError("Paste a Content Rewards campaign link. On Content Rewards tap the share icon, then Copy campaign link.");
      return false;
    }
    setBusy(true);
    const out = await addCampaign(link.url + (link.group ? "?group=1" : ""));
    setBusy(false);
    if (out.kind === "added") {
      clipsGoLater(campaignPath(out.campaignId));
      return true;
    }
    if (out.kind === "group") {
      onGroup({ name: out.name, choices: out.choices });
      return true;
    }
    setError(out.message);
    return false;
  }

  return (
    <form
      className="cr-paste glass"
      data-help="cr-campaign-paste"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
      noValidate
    >
      <label className="field__label" htmlFor={`${id}-box`}>
        Paste a Content Rewards campaign link
      </label>
      <div className={`linkbox${isLink ? " is-ok" : ""}${error ? " is-bad" : ""}`} data-help-dodge="">
        <span className="linkbox__mark" aria-hidden="true">
          <Icon name={isLink ? "coin" : "link"} />
        </span>
        <input
          id={`${id}-box`}
          className="linkbox__input"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://contentrewards.com/c/campaigns/…"
          value={text}
          onChange={(e) => take(e.target.value)}
          aria-invalid={!!error || undefined}
          aria-describedby={`${id}-status`}
        />
        <button
          type="button"
          className="linkbox__paste"
          data-act="paste"
          onClick={() => {
            void paste();
            pasteAct.play();
          }}
        >
          <ActGlyph act={pasteAct}>
            <Icon name="paste" size={18} />
          </ActGlyph>
          <span>Paste</span>
        </button>
      </div>
      <p className={`field__status${error ? " is-bad" : isLink ? " is-ok" : ""}`} id={`${id}-status`} aria-live="polite">
        {error ? (
          <>
            <Icon name="alert" size={18} />
            <span>
              <Rich text={error} />
            </span>
          </>
        ) : isLink ? (
          <>
            <Icon name="checkCircle" size={18} />
            <span>That&apos;s a Content Rewards campaign!</span>
          </>
        ) : (
          <span>
            <Rich text="On Content Rewards, tap the share icon, then **Copy campaign link**. Then tap Paste." />
          </span>
        )}
      </p>
      <div className="cr-paste__actions">
        <Button type="submit" variant={isLink ? "primary" : "glass"} size="lg" icon="plus" act={addAct} loading={busy} data-help-clear={isLink ? "" : undefined}>
          Add campaign
        </Button>
      </div>
    </form>
  );
}
