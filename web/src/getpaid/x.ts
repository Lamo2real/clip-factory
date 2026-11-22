// X's Get paid steps (docs/CONTRACTS.md §40.1), checked against X's help (archive copy of 19 Oct 2026) on 21 Nov 2026.
// X's paid plan costs money, so `x-premium` is never the vermilion. X's warning (that it probably won't pay for Clip
// Factory clips) is the server's `warning`, shown in the status block above the steps.
import type { GetPaidGuide } from "./types.ts";

const OCR = "https://help.x.com/en/using-x/original-content-rewards";
export const X_CREATOR_STUDIO = "https://x.com/i/jf/creators/studio";
export const STRIPE_EXPRESS = "https://connect.stripe.com/express_login";
const OPEN_STUDIO = { label: "Open Creator Studio", url: X_CREATOR_STUDIO };

export const x: GetPaidGuide = {
  place: "x",
  name: "X",
  checkedOn: "2026-11-21",
  minutes: 15,
  cost: "X Premium costs money",
  facts: [
    { text: "X's rules leave out posts made or posted by automated means, and reuploaded or barely changed clips.", source: OCR },
    { text: "Creator Revenue Sharing ended in September 2026.", source: OCR },
    { text: "Original Content Rewards needs a paid plan (not Basic), 500 verified followers and 500,000 views from verified people in 90 days.", source: OCR },
    { text: "Then X reviews you.", source: OCR },
    { text: "X pays every two weeks once you have $30, through Stripe.", source: OCR },
  ],
  steps: [
    {
      id: "x-premium",
      role: "earn",
      icon: "star",
      title: "Get X Premium",
      auto: "premium",
      doneLabel: "I have Premium",
      paid: true,
      open: { label: "Open X", url: "https://x.com/" },
      say: [
        "X probably won't pay for Clip Factory clips. Only buy Premium if you also post your own videos.",
        "Tap **Premium** in the menu.",
        "Pick any paid plan except **Basic**.",
      ],
    },
    {
      id: "x-apply",
      role: "earn",
      icon: "sparkle",
      title: "Apply for Original Content Rewards",
      doneLabel: "X said yes",
      open: OPEN_STUDIO,
      say: ["Tap **Original Content Rewards**.", "Apply. X checks your account.", "Tap X said yes when X lets you in."],
      ifYouSee: [
        { see: "that you were not accepted", do: "You can ask once more. Or apply again after 42 days." },
        { see: "money paused for a past rule break", do: "Accounts that are paused can't join." },
      ],
    },
    {
      id: "x-stripe",
      role: "payout",
      icon: "card",
      title: "Connect Stripe for payouts",
      open: OPEN_STUDIO,
      say: [
        "Connect Stripe so X can pay you.",
        "Stripe checks your ID once. Have it ready.",
        "Add your bank in Stripe.",
        "X may show this a little differently. Look for **Stripe**.",
      ],
      ifYouSee: [{ see: "that you did this for Revenue Sharing", do: "You don't need to do it again. Tap I did this." }],
    },
  ],
  eachTime: {
    say: ["Nothing to do. X's help says Stripe sends money to your bank in 3 to 5 workdays. It can take longer.", "See what Stripe sent:"],
    open: { label: "Open Stripe", url: STRIPE_EXPRESS },
  },
};
