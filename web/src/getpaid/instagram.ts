// Instagram's Get paid steps (docs/CONTRACTS.md §40.1), checked against Meta's pages on 21 Nov 2026. Instagram and
// Facebook share one Meta payout account: `meta-payout` is one tick for both.
import type { GetPaidGuide, GetPaidStep } from "./types.ts";

const IG = "https://www.facebook.com/help/instagram";
const META = "https://www.facebook.com/business/help";
const OPEN_INSTAGRAM = { label: "Open Instagram", url: "https://www.instagram.com/" };

/** The lines both Meta places share, from **Get Started** on (§40.1). */
export const META_PAYOUT_LINES = [
  "Tap **Get Started**. Type your legal name, birthday and country. Tap **Next**.",
  "For business type pick **Individual**. Tap **Next**.",
  "Tap **Sign into your bank** and use BankID. Or pick another way.",
  "Tap **Link payout method**.",
  "Tap **Add tax info**, sign, tap **Submit form**, then **Done**.",
  "Meta may show this a little differently. Look for the same words.",
];

/** The hints both Meta places share. */
export const META_PAYOUT_HINTS: NonNullable<GetPaidStep["ifYouSee"]> = [
  { see: "**Get Started** right after you accept Gifts", do: "Do it there. It's this step." },
  { see: "“minimum earnings”", do: "Come back when you have $25." },
  { see: "**Add later**", do: "Fine, but don't wait 6 months, or Meta keeps the money." },
  { see: "that you want to change it later", do: "Meta holds your money for 5 days after a change." },
];

export const META_PAYOUT_LEAD = "Did this on Facebook already? It's the same one. Tap I did this.";
export const META_PAYOUT_WHEN = "Meta lets you once you've earned $25.";

export const instagram: GetPaidGuide = {
  place: "instagram",
  name: "Instagram",
  checkedOn: "2026-11-21",
  minutes: 15,
  cost: "Free",
  facts: [
    { text: "Gifts: 500 followers, 18 or older, a professional account.", source: `${IG}/738469380549477` },
    { text: "Subscriptions: 10,000 followers.", source: `${IG}/478012211024479` },
    { text: "Bonuses: only when Instagram invites you.", source: `${IG}/331274061770840` },
    { text: "Meta pays around the 21st once you have $25. It pays in dollars. Your bank changes it to kronor.", source: `${META}/194187525195870` },
    { text: "Until you tell Meta where to pay you, you can earn up to $500 per money tool. Wait more than 6 months and the money is lost.", source: `${META}/487364569891814` },
  ],
  steps: [
    {
      id: "ig-gifts",
      role: "earn",
      icon: "star",
      title: "Turn on Gifts",
      phone: true,
      doneLabel: "I turned it on",
      open: OPEN_INSTAGRAM,
      say: ["Tap **Profile**, then **Professional dashboard**.", "Under **Your tools**, tap **Gifts**.", "Tap **Get started** and accept."],
      ifYouSee: [
        { see: "no **Professional dashboard**", do: "Switch to a professional account first: **Settings**, **Account type and tools**." },
        { see: "no **Gifts**", do: "You need 500 followers and a professional account." },
      ],
    },
    {
      id: "meta-payout",
      role: "payout",
      icon: "card",
      title: "Tell Meta where to pay you",
      phone: true,
      shared: "meta",
      lead: META_PAYOUT_LEAD,
      when: META_PAYOUT_WHEN,
      open: OPEN_INSTAGRAM,
      say: ["Tap **Profile**, **Professional dashboard**, then **Payouts**.", ...META_PAYOUT_LINES],
      ifYouSee: META_PAYOUT_HINTS,
    },
  ],
  eachTime: { say: ["Nothing to do. Meta sends your money around the 21st by itself."] },
};
