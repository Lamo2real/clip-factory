// Prices for the picture and video makers (docs/CONTRACTS.md §45.6 StoriesAiConfig.prices "by model key or provider
// id", §45.29 Video "provider cost where known", §45.33 "Provider usage (Nova Canvas images, Nova Reel seconds) …
// priced only when a price is known"). Neither has a known list price (stories/config/models.json: pricing null), so
// each starts at "No price set" with a form. The price is saved in the AI configuration (PUT …/ai, on its version)
// the way the usage is counted: a provider's units (pictures, seconds) are its `input`, so a price for one unit is
// kept as `inputPer1M` = that price × 1,000,000 and `outputPer1M` 0, and cost = units × inputPer1M / 1,000,000, the
// same sum as a model's.
import { useState } from "react";
import { useToast } from "../../components/Toasts.tsx";
import type { Price } from "../api/types.ts";
import modelsFile from "../../../../stories/config/models.json";
import { Btn, cheer, Chip, money, SetSelect } from "./bits.tsx";
import type { useAi } from "./data.ts";

/** The makers that can carry a price, with the unit their use is counted in. */
export const PRICED_MAKERS: { id: "nova-canvas" | "nova-reel"; label: string; unit: string; units: string; example: string }[] = [
  { id: "nova-canvas", label: modelsFile.imageModel.label, unit: "a picture", units: "picture", example: "0.04" },
  { id: "nova-reel", label: modelsFile.videoModel.label, unit: "a second of video", units: "second", example: "0.08" },
];

/** The API takes at most 100,000 for a million units, so at most 0.10 for one (Nova's prices are a few cents). */
export const MAX_UNIT = 0.1;

/** The price of one unit (one picture, one second) from a stored price. */
export function unitPrice(p: Price): number {
  return Math.round(p.inputPer1M) / 1_000_000;
}

/** The stored price for one unit (see the top of this file). */
export function makerPrice(perUnit: number, currency: string, unit: string): Price {
  return {
    inputPer1M: Math.round(perUnit * 1_000_000),
    outputPer1M: 0,
    cacheReadPer1M: null,
    cacheWritePer1M: null,
    longContext: null,
    currency,
    source: "owner",
    note: `Your price for ${unit}.`,
  };
}

type Ai = ReturnType<typeof useAi>;

function MakerPriceRow({ maker, ai }: { maker: (typeof PRICED_MAKERS)[number]; ai: Ai }) {
  const toast = useToast();
  const data = ai.data!;
  const price = data.ai.prices[maker.id] ?? null;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(price ? String(unitPrice(price)) : "");
  const [currency, setCurrency] = useState(price?.currency ?? "USD");
  const [busy, setBusy] = useState(false);
  const { version: _v, ...config } = data.ai;
  const put = async (prices: Record<string, Price>) => {
    setBusy(true);
    try {
      return await ai.saveAi({ ...config, prices });
    } finally {
      setBusy(false);
    }
  };
  const save = async (el: HTMLElement | null) => {
    if (busy) return;
    const n = Number(text.replace(",", "."));
    if (!text.trim() || !Number.isFinite(n) || n < 0 || n > MAX_UNIT) {
      toast.error(`Type the price for ${maker.unit} as a number from 0 to 0.10, like ${maker.example}.`);
      return;
    }
    if (await put({ ...data.ai.prices, [maker.id]: makerPrice(n, currency, maker.unit) })) {
      setOpen(false);
      cheer(el);
      toast.success(`${maker.label}'s price is saved.`);
    }
  };
  const clear = async () => {
    if (busy) return;
    const { [maker.id]: _gone, ...rest } = data.ai.prices;
    if (await put(rest)) toast.info(`Your price for ${maker.label} is removed.`);
  };
  return (
    <li className="st-stg-price">
      <div className="st-stg-price__head">
        <span className="st-stg-price__name">{maker.label}</span>
        {price ? <Chip tone="sky">Your price</Chip> : <Chip tone="sun">No price set.</Chip>}
      </div>
      <p className="st-stg-price__text">{price ? `${money(unitPrice(price), price.currency)} for ${maker.unit}` : `No cost is worked out for it until you type its price for ${maker.unit}.`}</p>
      {open ? (
        <form
          className="st-stg-price__form"
          onSubmit={(e) => {
            e.preventDefault();
            void save(e.currentTarget.querySelector("button[type=submit]"));
          }}
        >
          <span className="st-stg-field">
            <label className="st-stg-label" htmlFor={`unit-${maker.id}`}>
              Price for one {maker.units}
            </label>
            <input id={`unit-${maker.id}`} className="st-stg-input" inputMode="decimal" value={text} placeholder={maker.example} onChange={(e) => setText(e.target.value)} />
          </span>
          <SetSelect label="Currency" value={currency} onChange={setCurrency} options={["USD", "EUR", "GBP"].map((c) => ({ value: c, label: c }))} />
          <div className="st-stg-actions">
            <Btn main type="submit" off={busy ? "Saving…" : undefined}>
              Save the price
            </Btn>
            <Btn quiet onClick={() => setOpen(false)}>
              Cancel
            </Btn>
          </div>
        </form>
      ) : (
        <div className="st-stg-actions">
          <Btn onClick={() => setOpen(true)} label={`${price ? "Change your price" : "Type a price"} for ${maker.label}`}>
            {price ? "Change your price" : "Type a price"}
          </Btn>
          {price ? (
            <Btn quiet off={busy ? "Working…" : undefined} onClick={() => void clear()} label={`Remove your price for ${maker.label}`}>
              Remove my price
            </Btn>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** Each maker that can carry a price, with its form. */
export function MakerPrices({ ai }: { ai: Ai }) {
  if (!ai.data) return ai.error ? <p className="st-stg-small">{ai.error}</p> : null;
  return (
    <ul className="st-stg-prices" aria-label="Each maker's price">
      {PRICED_MAKERS.map((m) => (
        <MakerPriceRow key={m.id} maker={m} ai={ai} />
      ))}
    </ul>
  );
}
