// Prices for the picture and video makers (docs/CONTRACTS.md §45.34 "Provider usage and cost", §45.29 Video
// "provider cost where known"). None has a known list price (stories/config/models.json: price null), so each
// starts at "No price set" with a form. The price is the owner's price for one unit, saved in the AI configuration
// (PUT …/ai `prices`, by provider id, on its version) as a Price with `perUnit` and its `unit` (pictures by the
// picture, video by the second) and the token prices 0; the usage card's cost is units × perUnit.
import { useState } from "react";
import { useToast } from "../../components/Toasts.tsx";
import type { Price } from "../api/types.ts";
import { Btn, cheer, Chip, money, SetSelect } from "./bits.tsx";
import type { useAi } from "./data.ts";

/**
 * The makers that can carry a price, with the unit their use is counted in (the API's ai_config.PRICE_PROVIDERS):
 * Stability AI by the picture and Luma AI Ray2 by the second of video (§45.37), the sound makers by the second of
 * sound (ElevenLabs, your own sound model) or the character spoken (Amazon Polly), and the two Amazon ended on 30 Sep
 * 2026, kept for what they made before.
 */
export type PricedUnit = "image" | "second" | "character";
export const PRICED_MAKERS: { id: "stability" | "luma-ray" | "elevenlabs" | "own-sound" | "polly" | "nova-canvas" | "nova-reel"; label: string; unit: PricedUnit; per: string; units: string; example: string }[] = [
  { id: "stability", label: "Stability AI pictures", unit: "image", per: "a picture", units: "picture", example: "0.04" },
  { id: "luma-ray", label: "Luma AI Ray2", unit: "second", per: "a second of video", units: "second", example: "0.75" },
  { id: "elevenlabs", label: "ElevenLabs sound effects and music", unit: "second", per: "a second of sound", units: "second", example: "0.002" },
  { id: "own-sound", label: "Your own sound model", unit: "second", per: "a second of sound", units: "second", example: "0.002" },
  { id: "polly", label: "A spoken voice (Amazon Polly)", unit: "character", per: "a character spoken", units: "character", example: "0.000016" },
  { id: "nova-canvas", label: "Amazon Nova Canvas", unit: "image", per: "a picture", units: "picture", example: "0.04" },
  { id: "nova-reel", label: "Amazon Nova Reel 1.1", unit: "second", per: "a second of video", units: "second", example: "0.08" },
];

/** The highest price for one picture or one second the form takes (Nova's prices are a few cents). */
export const MAX_UNIT = 100;

/** The price of one unit (one picture, one second) from a stored price (an older one kept it per million units). */
export function unitPrice(p: Price): number {
  if (typeof p.perUnit === "number") return p.perUnit;
  return Math.round(p.inputPer1M) / 1_000_000;
}

/** The stored price for one unit (§45.34): perUnit and its unit, the token prices 0. */
export function makerPrice(perUnit: number, currency: string, unit: PricedUnit, per: string): Price {
  return {
    inputPer1M: 0,
    outputPer1M: 0,
    cacheReadPer1M: null,
    cacheWritePer1M: null,
    longContext: null,
    currency,
    source: "owner",
    note: `Your price for ${per}.`,
    perUnit,
    unit,
  };
}

type Ai = ReturnType<typeof useAi>;

function MakerPriceRow({ maker, ai, open, setOpen }: { maker: (typeof PRICED_MAKERS)[number]; ai: Ai; open: boolean; setOpen: (open: boolean) => void }) {
  const toast = useToast();
  const data = ai.data!;
  const price = data.ai.prices[maker.id] ?? null;
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
      toast.error(`Type the price for ${maker.per} as a number, like ${maker.example}.`);
      return;
    }
    if (await put({ ...data.ai.prices, [maker.id]: makerPrice(n, currency, maker.unit, maker.per) })) {
      setOpen(false);
      cheer(el);
      toast.success(`${maker.label}'s price is saved. Its cost shows in Use and costs.`);
    }
  };
  const clear = async () => {
    if (busy) return;
    const { [maker.id]: _gone, ...rest } = data.ai.prices;
    if (await put(rest)) toast.info(`Your price for ${maker.label} is removed.`);
  };
  return (
    <li className="st-stg-price" id={`price-${maker.id}`}>
      <div className="st-stg-price__head">
        <span className="st-stg-price__name">{maker.label}</span>
        {price ? <Chip tone="sky">Your price</Chip> : <Chip tone="sun">No price set.</Chip>}
      </div>
      <p className="st-stg-price__text">{price ? `${money(unitPrice(price), price.currency)} for ${maker.per}` : `No cost is worked out for it until you type its price for ${maker.per}.`}</p>
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

/**
 * Each maker that can carry a price, with its form; `open` is the maker whose form is open (the usage card opens one).
 * A row that closes names itself (`from`): a save that ends after another maker's form was opened closes only its own.
 */
export function MakerPrices({ ai, open, setOpen }: { ai: Ai; open: string | null; setOpen: (id: string | null, from: string) => void }) {
  if (!ai.data) return ai.error ? <p className="st-stg-small">{ai.error}</p> : null;
  return (
    <ul className="st-stg-prices" aria-label="Each maker's price">
      {PRICED_MAKERS.map((m) => (
        <MakerPriceRow key={m.id} maker={m} ai={ai} open={open === m.id} setOpen={(v) => setOpen(v ? m.id : null, m.id)} />
      ))}
    </ul>
  );
}
