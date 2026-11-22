// Money › Get paid (docs/CONTRACTS.md §40.1 item 3): one glass card right after All your money, before the Apps band.
// "Can money reach you from each place?": one row per place (mark, name, the status pill) and one glass button at the
// row's right end, to that place's page with the way back to Money. Status only (one job per card): what was sent to
// the bank is in All your money. No vermilion: Content Rewards' money part keeps its own (§38.7). An API from before
// §40 (404) shows nothing.
import "../../styles/getpaid.css";
import { useId } from "react";
import { LinkButton } from "../../components/ui.tsx";
import { getPaidPath } from "../../getpaid/index.ts";
import { rowButton, useGetPaid } from "../../lib/getPaid.ts";
import { PlaceMark } from "../getpaid/GetPaidList.tsx";
import { StatusPill } from "../getpaid/StatusPill.tsx";

export const GETPAID_CARD_LINE = "Can money reach you from each place?";

export function GetPaidCard() {
  const load = useGetPaid();
  const id = useId();
  if (load.state === "missing") return null;
  if (load.state === "loading") return <section className="gp-money glass is-loading" aria-hidden="true" data-help="getpaid-card" />;
  const data = load.data;
  return (
    <section className="gp-money glass" data-help="getpaid-card" aria-labelledby={`${id}-t`}>
      <div className="gp-money__head">
        <h2 className="gp-money__title" id={`${id}-t`}>
          Get paid
        </h2>
        <p className="gp-money__line">{GETPAID_CARD_LINE}</p>
      </div>
      {data ? (
        <ul className="gp-money__rows" aria-label="Can money reach you">
          {data.places.map((card) => (
            <li key={card.place} className="gp-money__row" data-place={card.place} data-status={card.status}>
              <PlaceMark place={card.place} size={20} />
              <span className="gp-money__name">{card.name}</span>
              <span className="gp-money__pill">
                <StatusPill card={card} />
              </span>
              <span className="gp-money__button">
                <LinkButton href={`${getPaidPath(card.place)}?back=/money`} variant="glass" size="sm" iconAfter="chevronRight" aria-label={`${rowButton(card.status)}: ${card.name}`}>
                  {rowButton(card.status)}
                </LinkButton>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="cr-all__why" role="alert">
          {load.state === "error" ? load.error : ""}
        </p>
      )}
    </section>
  );
}
