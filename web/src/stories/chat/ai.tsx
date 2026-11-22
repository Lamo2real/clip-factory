// The model and effort line ("Model: Claude Opus 5.5 · Effort: High") and its picker (docs/CONTRACTS.md §45.25,
// §45.27, §45.28). The line always shows what the next request really uses (the server's effective values, with a
// just-this-once override on top). Tapping the model or the effort opens the picker: in the chat it changes the
// conversation's own setting, or, with "Just for this message", only the next message (never saved). Each model
// shows what its last real call said, and only the efforts it offers.
import type { ReactNode } from "react";
import { EFFORT_LABEL, type Effort, type ModelOverride } from "../api/types.ts";
import { Btn, Chip, Pick, Sheet, type PickOption } from "./kit.tsx";
import { EFFORT_LINE, effortLabel, effortProblem, findModel, modelLabel, NO_EFFORT_LINE, statusWords, type ModelView } from "./models.ts";

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
  return (
    <div className={`st-chat-ai${once ? " is-once" : ""}`}>
      <div className="st-chat-ai__row">
        {once ? <Chip tone="sun">{onceLabel}</Chip> : null}
        <p className="st-chat-ai__line">
          <button type="button" className="st-chat-ai__part" onClick={() => onPick("model", once)} aria-label={`Model: ${modelLabel(models, current.model)}. Change the model`}>
            Model: <b>{modelLabel(models, current.model)}</b>
          </button>
          <span className="st-chat-ai__dot" aria-hidden="true">
            {" · "}
          </span>
          <button type="button" className="st-chat-ai__part" onClick={() => onPick("effort", once)} aria-label={`Effort: ${noEffort ? "its own level" : effortLabel(current.effort)}. Change the effort`}>
            Effort: <b>{noEffort ? "Its own level" : effortLabel(current.effort)}</b>
          </button>
        </p>
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

export function modelOptions(models: ModelView[], withDefault: string | null): PickOption<string>[] {
  const out: PickOption<string>[] = [];
  if (withDefault !== null) out.push({ value: DEFAULT, label: "Same as Settings", line: withDefault });
  for (const m of models) {
    const s = statusWords(m);
    out.push({
      value: m.key,
      label: m.label,
      line: [m.line, s.tone === "coral" ? s.line : ""].filter(Boolean).join(" "),
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

/**
 * The picker. `scopes` are the places a choice can go ("chat": this conversation's saved setting; "once": the next
 * request only); `values` holds the choice shown for the current scope (DEFAULT for "Same as Settings").
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
  scope: "chat" | "once";
  scopes: { value: "chat" | "once"; label: string }[];
  onScope: (s: "chat" | "once") => void;
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
  const withDefault = scope === "chat" ? "Uses the model and effort from Lamo Stories › Settings › AI." : null;
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
        {scope === "chat" ? "Saved for this chat. Every new message uses it." : "Only for the next one. Your settings stay as they are."}
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
