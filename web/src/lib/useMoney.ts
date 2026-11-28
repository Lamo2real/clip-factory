// Loading the money view and playing its celebrations once each (docs/CONTRACTS.md §25.7). A celebration is
// acknowledged on the server (POST /v1/money/seen), so it never plays again on another device or after a reload.
import { useEffect } from "react";
import { api } from "../api/index.ts";
import type { MoneyCelebration, MoneyView } from "../api/types.ts";
import { useToast } from "../components/Toasts.tsx";
import { burst } from "./confetti.ts";
import { useLoad } from "./hooks.ts";

/** Keys played in this page's life: React may mount twice, the owner must still see each one once. */
const played = new Set<string>();

/** The biggest party for the first money and for being able to join, a big one for joining, a normal one for a goal,
 * a small one for being close. */
export const CONFETTI: Record<MoneyCelebration["kind"], number> = { first_money: 200, ready: 200, in_program: 160, goal: 110, close: 90 };

export function useMoney() {
  const loaded = useLoad<MoneyView>(() => api().getMoney());
  const toast = useToast();
  const { data, setData } = loaded;
  useEffect(() => {
    const next = data?.celebrations.find((c) => !played.has(c.key));
    if (!next) return;
    played.add(next.key);
    burst(undefined, CONFETTI[next.kind]);
    toast.success(next.text, { group: `money-${next.key}` });
    void api()
      .seenMoney(next.key)
      .then((v) => setData(() => v))
      .catch(() => {
        /* already seen elsewhere: nothing to do */
      });
  }, [data, toast, setData]);
  return loaded;
}

/** Tests only. */
export function forgetPlayed(): void {
  played.clear();
}
