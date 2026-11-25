// "What this cost" (docs/CONTRACTS.md §51): the AI's bill for one job, in one small block. The total is big, the tokens
// sit under it, and one fold lists each model. Numbers roll when they change (a running job's cost keeps growing). A
// failed or stopped job shows what it spent so far. Old jobs have no cost: nothing is drawn.
import type { Job } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { Roll } from "../../components/Roll.tsx";
import { aiCostOf, dollars, minutes, tokens } from "../../lib/aiCost.ts";
import { shortDate } from "../../lib/format.ts";

export function AiCostBlock({ job }: { job: Job }) {
  const cost = aiCostOf(job);
  if (!cost) return null;
  const sofar = job.status === "failed" || job.status === "canceled";
  const checked = cost.pricesChecked ? shortDate(`${cost.pricesChecked}T12:00:00Z`) : null;
  return (
    <section className="panel glass ai-cost" aria-labelledby="ai-cost-title">
      <div className="panel__head">
        <h2 className="panel__title" id="ai-cost-title">
          What this cost
        </h2>
        {sofar ? <span className="panel__pct">so far</span> : null}
      </div>
      <p className="ai-cost__total">
        {cost.estimated ? <span className="ai-cost__about">about </span> : null}
        <Roll n={cost.totalDollars} text={dollars(cost.totalDollars)} />
      </p>
      <p className="ai-cost__tokens">
        <Roll n={cost.totalTokens} text={tokens(cost.totalTokens)} /> tokens
        {cost.transcribe ? <span> · {minutes(cost.transcribe.minutes)} of sound</span> : null}
      </p>
      <details className="cr-fold ai-cost__fold">
        <summary className="cr-fold__q">
          <span>See the details</span>
          <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
        </summary>
        <div className="cr-fold__body">
          <ul className="ai-cost__rows">
            {cost.models.map((m) => (
              <li key={m.key} className="ai-cost__row">
                <span className="ai-cost__name">{m.label}</span>
                <span className="ai-cost__money">{m.dollars === undefined ? "price not known" : `${m.estimated ? "about " : ""}${dollars(m.dollars)}`}</span>
                <span className="ai-cost__small">
                  {`${m.calls} ${m.calls === 1 ? "call" : "calls"} · ${tokens(m.inputTokens)} in · ${tokens(m.outputTokens)} out`}
                  {m.cacheReadTokens + m.cacheWriteTokens > 0 ? ` · ${tokens(m.cacheReadTokens + m.cacheWriteTokens)} remembered` : ""}
                </span>
              </li>
            ))}
            {cost.transcribe ? (
              <li className="ai-cost__row">
                <span className="ai-cost__name">Amazon Transcribe</span>
                <span className="ai-cost__money">
                  {cost.transcribe.dollars === undefined ? "price not known" : dollars(cost.transcribe.dollars)}
                </span>
                <span className="ai-cost__small">{minutes(cost.transcribe.minutes)} of sound</span>
              </li>
            ) : null}
          </ul>
          {cost.estimated ? <p className="ai-cost__note">A price was missing or is a guess, so this is about, not exact.</p> : null}
          {checked ? <p className="ai-cost__note">Prices checked {checked}.</p> : null}
        </div>
      </details>
    </section>
  );
}
