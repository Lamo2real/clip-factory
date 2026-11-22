// The shape of one place's Get paid guide (docs/CONTRACTS.md §40.1). Plain data like the setup guides (§17.2): the
// screens draw it, the tests check it. Guide types only: the API's shapes (GetPaid, GetPaidCard, SentLine, …) live in
// api/types.ts. SetupGuide and CrGuide are unchanged.
import type { Platform } from "../api/types.ts";
import type { IconName } from "../components/Icon.tsx";

export type { GetPaidPlace } from "../api/types.ts";

export type GetPaidRole = "earn" | "reading" | "payout" | "each_time";
export type GetPaidAuto = "in_program" | "payment_reading" | "sent" | "premium";

export interface GetPaidStep {
  /** ^[a-z0-9-]{1,40}$, exactly the ids of §40.1 (the server has the same list, §40.2). */
  id: string;
  /** earn: he can earn there · payout: money can reach him · reading: Clip Factory can see · each_time: every payout. */
  role: GetPaidRole;
  icon: IconName;
  /** Six words or fewer. */
  title: string;
  /** Short lines, one action each. **bold** = the other site's own label, word for word. */
  say: string[];
  /** The step's first line, before its Open. */
  lead?: string;
  /** For a step that waits for the platform ("YouTube asks for this once you've earned about $10."). */
  when?: string;
  /** Opens the exact page in a new tab (https only). */
  open?: { label: string; url: string };
  /** More Opens, each drawn before the line `before` it belongs to (the reading step's second page). */
  more?: { label: string; url: string; before: number }[];
  copy?: { label: string; value: string }[];
  /** The Copy chips are drawn before this line (default: after every line). */
  copyAt?: number;
  /** "If you see X, do Y" hints; a hint may hold one Open of its own ("Open Meta's form"). */
  ifYouSee?: { see: string; do: string; open?: { label: string; url: string } }[];
  /** Also ticks itself (the server's steps[].by "auto"). */
  auto?: GetPaidAuto;
  /** Default true: the green answer (PATCH /v1/getpaid/steps). */
  manual?: boolean;
  /** The green answer's words; default "I did this". */
  doneLabel?: string;
  /** On a computer: "Do this in the {app} app on your phone." and no Open. */
  phone?: boolean;
  /** Costs money (x-premium): never the vermilion, even when next. */
  paid?: boolean;
  /** The step's main button is Clip Factory's own, not an Open. */
  action?: "allow_payment_reading";
  /** meta-payout: one tick for Instagram and Facebook. */
  shared?: "meta";
}

export interface GetPaidFact {
  text: string;
  /** https, the platform's own help host. */
  source: string;
  /** Default: every country. */
  countries?: string[];
}

export interface GetPaidGuide {
  place: Platform;
  name: string;
  checkedOn: "2026-11-21";
  minutes: number;
  cost: "Free" | "X Premium costs money";
  /** Extra words after the minutes ("over a few weeks"). */
  timeNote?: string;
  facts: GetPaidFact[];
  steps: GetPaidStep[];
  /** "Each time": what happens with every payout when there is nothing to do (an `each_time` step says more). */
  eachTime?: { say: string[]; open?: { label: string; url: string } };
}
