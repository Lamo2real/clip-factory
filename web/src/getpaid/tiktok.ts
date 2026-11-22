// TikTok's Get paid steps (docs/CONTRACTS.md §40.1), checked against TikTok's pages on 21 Nov 2026. Every step is done
// in the TikTok app on a phone. There is no numbered tax step: TikTok shows **Tax information** only at the first
// withdrawal, so a numbered step could not be done when it is asked for.
import type { GetPaidGuide } from "./types.ts";

const FAQ = "https://www.tiktok.com/support/faq_detail?id=";
const OPEN_TIKTOK = { label: "Open TikTok", url: "https://www.tiktok.com/" };

export const tiktok: GetPaidGuide = {
  place: "tiktok",
  name: "TikTok",
  checkedOn: "2026-11-21",
  minutes: 15,
  cost: "Free",
  facts: [
    {
      text: "Creator Rewards isn't open in Sweden. TikTok lists only the US, UK, Germany, Japan, South Korea, France, Mexico and Brazil.",
      source: "https://www.tiktok.com/creator-academy/en/article/creator-rewards-program",
      countries: ["SE"],
    },
    { text: "Video Gifts and LIVE Gifts may work in Sweden. Look in TikTok Studio.", source: `${FAQ}7581821551121783352`, countries: ["SE"] },
    { text: "Gifts need you to be 18 or older and a Personal account, not Business.", source: `${FAQ}7581821551121783352` },
    { text: "LIVE needs 1,000 followers.", source: `${FAQ}7543604790438451768` },
    { text: "TikTok counts in dollars. Each payout costs a small fee.", source: "https://www.tiktok.com/legal/page/global/rewards-policy-eea/en" },
    { text: "TikTok pays to PayPal, your bank or Payoneer.", source: "https://www.tiktok.com/platform/legal/page/payment-limit-and-fees", countries: ["SE"] },
    {
      text: "TikTok may ask for a US tax form the first time you take money out. Without it, TikTok may keep up to 30% of US money.",
      source: `${FAQ}7581821550676957752`,
    },
    { text: "TikTok Shop isn't in Sweden.", source: "https://seller.tiktok.com/uk", countries: ["SE"] },
  ],
  steps: [
    {
      id: "tt-gifts",
      role: "earn",
      icon: "star",
      title: "Turn on Gifts",
      phone: true,
      doneLabel: "I turned it on",
      open: OPEN_TIKTOK,
      say: [
        "Tap **Profile**, then the menu ☰, then **TikTok Studio**.",
        "Tap **Video Gifts**, then **Turn on Gifts**.",
        "For LIVE: in the LIVE screen tap **Settings** and turn on **LIVE Gifts**.",
      ],
      ifYouSee: [
        { see: "no **Video Gifts**", do: "Gifts aren't open for you yet. Look again in a month." },
        { see: "a Business account", do: "Switch back to Personal. Business accounts can't get Gifts." },
      ],
    },
    {
      id: "tt-payout",
      role: "payout",
      icon: "card",
      title: "Add where TikTok pays you",
      phone: true,
      open: OPEN_TIKTOK,
      say: [
        "Tap **Profile**, the menu ☰, then **Balance**.",
        "Tap **LIVE rewards**. Set up how you get paid.",
        "Pick PayPal, your bank or Payoneer. PayPal takes 1.5%. A bank costs $3 each time.",
        "TikTok may show this a little differently. Look for the same words.",
      ],
      ifYouSee: [
        { see: "“not available in your region”", do: "TikTok doesn't pay out there yet." },
        { see: "“linked in more than 2 countries”", do: "Keep your payment ways in one country." },
      ],
    },
    {
      id: "tt-withdraw",
      role: "each_time",
      icon: "coin",
      title: "Move money to your bank",
      phone: true,
      manual: false,
      open: OPEN_TIKTOK,
      say: [
        "Tap **Profile**, ☰, **Balance**, then **LIVE rewards**.",
        "Withdraw to your PayPal, bank or Payoneer.",
        "See what went out: **Balance**, then **Transactions**, then **Withdrawal**.",
      ],
      ifYouSee: [{ see: "that TikTok asks for a tax form", do: "Tap **Tax information**. Fill in the form for people outside the US (W-8BEN)." }],
    },
  ],
};
