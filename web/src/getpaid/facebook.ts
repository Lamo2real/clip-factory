// Facebook's Get paid steps (docs/CONTRACTS.md §40.1), checked against Meta's pages on 21 Nov 2026. A computer is
// easiest here. `meta-payout` is the same step as Instagram's: one tick for both.
import { META_PAYOUT_HINTS, META_PAYOUT_LEAD, META_PAYOUT_LINES, META_PAYOUT_WHEN } from "./instagram.ts";
import type { GetPaidGuide } from "./types.ts";

const META = "https://www.facebook.com/business/help";

export const facebook: GetPaidGuide = {
  place: "facebook",
  name: "Facebook",
  checkedOn: "2026-11-21",
  minutes: 15,
  cost: "Free",
  facts: [
    { text: "Content Monetization: only when Meta invites you. Sweden is on its list.", source: `${META}/1049081556813520` },
    { text: "Stars: 500 followers for 30 days in a row.", source: `${META}/300444652164185` },
    { text: "Subscriptions: 5,000 followers.", source: `${META}/310335859546716` },
    {
      text: "Paying for no ads, or picking less personal ads, stops a profile from earning with Content Monetization.",
      source: `${META}/1563729837497242`,
      // (EU): the EU and EEA countries of the country picker (Settings › Posting › Money).
      countries: ["DE", "FR", "ES", "IT", "NL", "SE", "IE"],
    },
    { text: "Meta pays around the 21st once you have $25, in dollars.", source: `${META}/194187525195870` },
  ],
  steps: [
    {
      id: "fb-join",
      role: "earn",
      icon: "users",
      title: "Join a Facebook money tool",
      doneLabel: "I joined",
      open: { label: "Open Meta Business Suite", url: "https://business.facebook.com/latest/monetization" },
      say: [
        "Tap **Monetization**, then **Status**, then **View Page eligibility**.",
        "A **Set up** button means you can join. Tap it and accept.",
        "Invited to Content Monetization? Tap **Content monetization**, then **Sign up**.",
        "On a phone: Creator Dashboard, then **Monetization**. It says **Ready to set up** or **Not yet eligible**.",
      ],
      ifYouSee: [
        { see: "no **Monetization**", do: "Tap **All tools**, then **Monetization**." },
        {
          see: "**Not yet eligible**",
          do: "Meta invites creators. Tell Meta you'd like it:",
          open: { label: "Open Meta's form", url: "https://creators.facebook.com/content-monetization-interest-form" },
        },
      ],
    },
    {
      id: "meta-payout",
      role: "payout",
      icon: "card",
      title: "Tell Meta where to pay you",
      shared: "meta",
      lead: META_PAYOUT_LEAD.replace("on Facebook", "on Instagram"),
      when: META_PAYOUT_WHEN,
      open: { label: "Open Meta Business Suite", url: "https://business.facebook.com/" },
      say: [
        "Tap **All tools**, then **Payouts**.",
        ...META_PAYOUT_LINES,
        "In Content Monetization's sign-up this is **Payout details**, then **Complete setup**.",
      ],
      ifYouSee: META_PAYOUT_HINTS,
    },
  ],
  eachTime: { say: ["Nothing to do. Meta sends your money around the 21st by itself."] },
};
