// The model and effort line ("Model: Claude Opus 5.5 · Effort: High", "Anthropic on Amazon Bedrock") and its picker
// (docs/CONTRACTS.md §45.25, §45.27, §45.28, §45.34). The line always shows what the next request really uses (the
// server's effective values, with a just-this-once override on top) and who provides the model. Tapping the model or
// the effort opens the picker: in the chat it changes the conversation's own setting, or, with "Just for this
// message", only the next message (never saved); on a reference video, "Keep with this video" saves the video's own
// setting. Each model names who makes it and who runs it (§45.35 D8: "{provider} on {host}"), shows what its last real
// call said, and only the efforts it offers. In the chat's box on a small phone (under 360 px) the line folds into one
// chip, "Opus 5.5 · High", so the box stays a short row.
import type { ReactNode } from "react";
import { EFFORT_LABEL, type Effort, type ModelOverride } from "../api/types.ts";
import { GlassPill } from "../glass/index.ts";
import { Btn, Chip, Pick, Sheet, type PickOption } from "./kit.tsx";
import { EFFORT_LINE, effortLabel, effortProblem, fileModels, findModel, modelLabel, NO_EFFORT_LINE, providerWords, statusWords, type ModelView } from "./models.ts";

export const DEFAULT = "__default";

export function AiLine({
  models,
  current,
  override,
  onceLabel,
  onPick,
  onClearOverride,
  clearLabel,
  hint,
}: {
  models: ModelView[];
  /** what the next request uses */
  current: { model: string; effort: Effort | null };
  override: ModelOverride | null;
  /** "Just for this message", "Just for this run" */
  onceLabel: string;
  onPick: (part: "model" | "effort", once: boolean) => void;
  onClearOverride: () => void;
  /** the words of the button that drops the override ("Back to this chat's setting") */
  clearLabel: string;
  hint?: ReactNode;
}) {
  const model = findModel(models, current.model);
  const status = statusWords(model);
  const once = !!override && (override.model !== undefined || override.effort !== undefined);
  const noEffort = !!model && model.efforts.length === 0;
  const provider = providerOf(models, current.model);
  return (
    <div className={`st-chat-ai${once ? " is-once" : ""}`}>
      <div className="st-chat-ai__row">
        {once ? <Chip tone="sun">{onceLabel}</Chip> : null}
        <p className="st-chat-ai__line">
          {/* On a small phone the chat's box folds the two into this one chip, "Claude Opus 5.5 · High" (data-effort;
              its sheet has both): chat.css. */}
          <GlassPill
            active={once}
            className="st-chat-ai__part st-chat-ai__part--model"
            data-effort={noEffort ? "Its own level" : effortLabel(current.effort)}
            onClick={() => onPick("model", once)}
            aria-label={`Model: ${modelLabel(models, current.model)}${provider ? `, ${provider}` : ""}. Change the model`}
          >
            <span className="st-chat-ai__word">Model: </span>
            <b>{modelLabel(models, current.model)}</b>
          </GlassPill>
          <span className="st-chat-ai__dot" aria-hidden="true">
            {" · "}
          </span>
          <GlassPill active={once} className="st-chat-ai__part st-chat-ai__part--effort" onClick={() => onPick("effort", once)} aria-label={`Effort: ${noEffort ? "its own level" : effortLabel(current.effort)}. Change the effort`}>
            Effort: <b>{noEffort ? "Its own level" : effortLabel(current.effort)}</b>
          </GlassPill>
        </p>
        {provider ? <span className="st-chat-ai__provider">{provider}</span> : null}
        <span className={`st-chat-ai__status st-chat-ai__status--${status.tone}`}>{status.text}</span>
        {once ? (
          <Btn quiet className="st-chat-ai__once" onClick={onClearOverride}>
            {clearLabel}
          </Btn>
        ) : (
          <Btn quiet className="st-chat-ai__once" onClick={() => onPick("model", true)}>
            {onceLabel}
          </Btn>
        )}
      </div>
      {status.tone === "coral" ? <p className="st-chat-ai__note st-chat-ai__note--bad">{status.line}</p> : null}
      {noEffort ? <p className="st-chat-ai__note">{NO_EFFORT_LINE}</p> : null}
      {hint}
    </div>
  );
}

/**
 * Who makes a model and who runs it ("Anthropic on Amazon Bedrock", §45.35 D8), from the server's list or Lamo
 * Stories' own file; null when unknown.
 */
export function providerOf(models: readonly ModelView[], key: string | null | undefined): string | null {
  const m = findModel(models, key) ?? (key ? fileModels().find((f) => f.key === key) : undefined);
  return providerWords(m);
}

export function modelOptions(models: ModelView[], withDefault: string | null): PickOption<string>[] {
  const out: PickOption<string>[] = [];
  if (withDefault !== null) out.push({ value: DEFAULT, label: "Same as Settings", line: withDefault });
  for (const m of models) {
    const s = statusWords(m);
    out.push({
      value: m.key,
      label: m.label,
      line: [providerWords(m) ? `${providerWords(m)}.` : "", m.line, s.tone === "coral" ? s.line : ""].filter(Boolean).join(" "),
      badge: <span className={`st-chat-ai__status st-chat-ai__status--${s.tone}`}>{s.text}</span>,
    });
  }
  return out;
}

export function effortOptions(model: ModelView | null, withDefault: string | null, suggested: Effort | null): PickOption<string>[] {
  const out: PickOption<string>[] = [];
  if (withDefault !== null) out.push({ value: DEFAULT, label: "Same as Settings", line: withDefault });
  for (const e of model?.efforts ?? []) out.push({ value: e, label: EFFORT_LABEL[e], line: EFFORT_LINE[e], badge: suggested === e ? <span className="st-chat-chip st-chat-chip--mint">Suggested</span> : undefined });
  return out;
}

/** Where a choice in the picker goes: a conversation's own setting, the next request only, or a reference video's own. */
export type AiScope = "chat" | "once" | "keep";

/**
 * The picker. `scopes` are the places a choice can go ("chat": this conversation's saved setting; "once": the next
 * request only; "keep": a reference video's own setting, "Keep with this video"); `values` holds the choice shown for
 * the current scope (DEFAULT for "Same as Settings").
 */
export function AiSheet({
  title,
  models,
  scope,
  scopes,
  onScope,
  values,
  onModel,
  onEffort,
  effortModel,
  suggested,
  problem,
  saved,
  onClose,
}: {
  title: string;
  models: ModelView[];
  scope: AiScope;
  scopes: { value: AiScope; label: string }[];
  onScope: (s: AiScope) => void;
  values: { model: string; effort: string | null };
  onModel: (key: string) => void;
  onEffort: (e: string) => void;
  /** the model whose efforts are offered */
  effortModel: ModelView | null;
  suggested: Effort | null;
  problem: string | null;
  saved: string | null;
  onClose: () => void;
}) {
  const withDefault = scope === "chat" || scope === "keep" ? "Uses the model and effort from Clips Funded › Settings › AI." : null;
  const effortBad = values.effort && values.effort !== DEFAULT ? effortProblem(effortModel, values.effort as Effort) : null;
  return (
    <Sheet
      title={title}
      onClose={onClose}
      wide
      actions={
        <Btn main onClick={onClose}>
          Done
        </Btn>
      }
    >
      {scopes.length > 1 ? <Pick label="Where this choice goes" value={scope} options={scopes} onChange={onScope} className="st-chat-pick--bar" /> : null}
      <p className="st-chat-sheet__lede">
        {scope === "chat"
          ? "Saved for this chat. Every new message uses it."
          : scope === "keep"
            ? "Kept with this video. Every analysis of it uses it. Your other settings stay the same."
            : "Only for the next one. Your settings stay as they are."}
      </p>
      <h3 className="st-chat-sheet__sub">Model</h3>
      <Pick label="Model" value={values.model} options={modelOptions(models, withDefault)} onChange={onModel} stack />
      <h3 className="st-chat-sheet__sub">Effort</h3>
      {effortModel && effortModel.efforts.length === 0 ? (
        <p className="st-chat-sheet__lede">{NO_EFFORT_LINE}</p>
      ) : (
        <Pick label="Effort" value={values.effort ?? DEFAULT} options={effortOptions(effortModel, withDefault, suggested)} onChange={onEffort} stack />
      )}
      {effortBad ? (
        <p className="st-chat-note st-chat-note--bad" role="alert">
          {effortBad}
        </p>
      ) : null}
      {problem ? (
        <p className="st-chat-note st-chat-note--bad" role="alert">
          {problem}
        </p>
      ) : saved ? (
        <p className="st-chat-note st-chat-note--good" role="status">
          {saved}
        </p>
      ) : null}
    </Sheet>
  );
}
