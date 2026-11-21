// YouTube's Get paid steps (docs/CONTRACTS.md §40.1), checked against Google's pages on 21 Nov 2026. The payout steps
// follow YouTube's own money levels for Sweden: the bank opens at kr 70, before the ID and address checks at about
// $10, so the bank and its test payment come first and the PIN letter last.
import type { GetPaidGuide } from "./types.ts";

const YT = "https://support.google.com/youtube/answer";
export const ADSENSE_FOR_YOUTUBE = "https://adsense.google.com/";
/** The AdSense permission Allow payment reading asks for (config/platforms.json youtube.paymentScopes). */
export const ADSENSE_SCOPE = "https://www.googleapis.com/auth/adsense.readonly";
const OPEN_ADSENSE = { label: "Open AdSense for YouTube", url: ADSENSE_FOR_YOUTUBE };

export const youtube: GetPaidGuide = {
  place: "youtube",
  name: "YouTube",
  checkedOn: "2026-11-21",
  minutes: 30,
  cost: "Free",
  timeNote: "over a few weeks",
  facts: [
    { text: "AdSense for YouTube is Google's page that pays you.", source: `${YT}/14727140` },
    { text: "YouTube pays creators in Sweden through its Partner Program.", source: `${YT}/72851`, countries: ["SE"] },
    { text: "To join: 1,000 subscribers, and 4,000 watch hours in 12 months or 10 million Shorts views in 90 days.", source: `${YT}/72851` },
    { text: "From 1 Feb 2027, new channels need 8,000 hours or 20 million Shorts views.", source: `${YT}/12843009` },
    { text: "YouTube doesn't pay for Shorts that only reuse other people's videos.", source: `${YT}/12504220` },
    { text: "A Short over 1 minute with claimed content (often music) can't earn.", source: `${YT}/12504220` },
    { text: "YouTube pays in kronor, straight to your bank. Not PayPal.", source: `${YT}/14728152`, countries: ["SE"] },
    { text: "It pays between the 21st and 26th once you have kr 700. Your bank gets it up to 7 workdays later.", source: `${YT}/14728151`, countries: ["SE"] },
  ],
  steps: [
    {
      id: "yt-join",
      role: "earn",
      icon: "play",
      title: "Join the Partner Program",
      auto: "in_program",
      doneLabel: "I'm in",
      open: { label: "Open YouTube Studio", url: "https://studio.youtube.com/channel/UC/monetization" },
      say: [
        "Tap **Apply Now**, then **Start**.",
        "Read the terms and tap **Accept**.",
        "Tap **Start** on the AdSense card. Pick your Google account. Type your name and address.",
        "YouTube checks your channel. It takes about a month.",
      ],
      ifYouSee: [
        { see: "the Dashboard instead", do: "Tap **Earn** on the left." },
        { see: "**Get notified**", do: "You're not there yet. Tap it. YouTube emails you when you are." },
        { see: "**In Progress**", do: "Nothing to do. YouTube is checking." },
        { see: "that you were not approved", do: "You can appeal within 21 days, or try again after 30 days." },
        { see: "the AdSense website asking you to sign up", do: "Go back. Make it from YouTube Studio, not the AdSense website." },
      ],
    },
    {
      id: "yt-reading",
      role: "reading",
      icon: "eye",
      title: "Let Clip Factory see payments",
      auto: "payment_reading",
      manual: false,
      action: "allow_payment_reading",
      lead: "A grown-up does this once on the Mac. Then Clip Factory sees holds and payments.",
      when: "Do this after step 1 made your AdSense for YouTube.",
      open: { label: "Turn on AdSense reading", url: "https://console.cloud.google.com/apis/library/adsense.googleapis.com" },
      more: [{ label: "Open Google's permissions page", url: "https://console.cloud.google.com/auth/scopes", before: 1 }],
      say: [
        "Check **Clip Factory** is picked at the top. Tap **Enable**.",
        "Tap **Add or remove scopes**.",
        "Paste this in **Manually add scopes**:",
        "Tap **Add to table**, **Update**, then **Save**.",
        "Tap Allow payment reading. Pick the Google account you use for AdSense for YouTube. It can be a different one.",
      ],
      copy: [{ label: "Permission", value: ADSENSE_SCOPE }],
      copyAt: 3,
      ifYouSee: [
        { see: "**Manage** instead of **Enable**", do: "It's on already." },
        { see: "**Google hasn't verified this app**", do: "Tap **Advanced**, then **Go to …**. It's your own app." },
        {
          see: "“That Google account has no AdSense for YouTube”",
          do: "Tap Allow payment reading again. Pick the Google account that has AdSense for YouTube. Still no luck? Skip this step. Your ticks still work.",
        },
      ],
    },
    {
      id: "yt-tax",
      role: "payout",
      icon: "file",
      title: "Add your US tax info",
      auto: "sent",
      open: OPEN_ADSENSE,
      say: [
        "Tap **Payments**, then **Payments info**, then **Manage settings**.",
        "Next to **United States tax info**, tap edit, then **Manage tax info**.",
        "Fill in the form for people outside the US.",
        "Without it, Google may keep up to 24% of your money.",
        "Google may show this a little differently. Look for the same words.",
      ],
      ifYouSee: [
        { see: "two payments accounts", do: "In **Payments account**, pick the one for YouTube." },
        { see: "a question about Sweden and US tax", do: "Pick Sweden. YouTube's help calls this money Other Copyright Royalties." },
      ],
    },
    {
      id: "yt-bank",
      role: "payout",
      icon: "card",
      title: "Add your bank",
      auto: "sent",
      when: "YouTube lets you once you've earned kr 70.",
      open: OPEN_ADSENSE,
      say: [
        "Tap **Payments**, then **Payments info**, then **Add payment method**.",
        "Pick bank transfer. Type your bank details.",
        "Tick **Set as primary payment method**. Tap **Save**.",
        "Pick Swedish kronor. You can't change it later.",
      ],
      ifYouSee: [
        { see: "PayPal", do: "Not offered in Sweden. Use your bank." },
        { see: "that it's after the 20th", do: "Fine. Your first money may come a month later." },
      ],
    },
    {
      id: "yt-test",
      role: "payout",
      icon: "coin",
      title: "Confirm the tiny test payment",
      auto: "sent",
      when: "A tiny payment from Google arrives in 1 to 5 workdays.",
      open: OPEN_ADSENSE,
      say: [
        "Look in your bank's app for a tiny payment, a few kronor, from GOOGLE.",
        "Tap **Payments**, then **Payments info**, then **Manage payment methods**.",
        "Tap **Verify now**. Type the amount. Tap **Verify**.",
      ],
      ifYouSee: [
        { see: "nothing after 10 workdays", do: "Your bank details may be wrong. Fix them in **Payments info**." },
        { see: "a third try", do: "After 3 wrong tries you must ask AdSense for YouTube's help team." },
      ],
    },
    {
      id: "yt-id",
      role: "payout",
      icon: "user",
      title: "Check your ID",
      auto: "sent",
      when: "YouTube asks once you've earned about $10.",
      open: OPEN_ADSENSE,
      say: [
        "Tap **Payments**, then **Verification check**.",
        "Send a photo of your passport, ID card or driving licence.",
        "YouTube checks it in up to 2 days.",
      ],
      ifYouSee: [
        { see: "“45 days”", do: "Send it in time, or YouTube stops your ads." },
        { see: "that you can't send it", do: "Sign in with the Google account that made AdSense for YouTube." },
      ],
    },
    {
      id: "yt-pin",
      role: "payout",
      icon: "lock",
      title: "Type the PIN from the letter",
      auto: "sent",
      when: "A letter comes by post 3 to 4 weeks after your ID check.",
      open: OPEN_ADSENSE,
      say: ["Tap **Payments**, then **Verification check**.", "Type the 6 numbers from the letter. Tap **Submit**."],
      ifYouSee: [
        { see: "no letter after 4 weeks", do: "Ask for a new PIN on the same page." },
        { see: "a wrong-PIN warning", do: "Type it slowly. After 3 wrong tries YouTube stops your ads." },
      ],
    },
  ],
  eachTime: { say: ["Nothing to do. Google sends your money by itself. Clip Factory tells you when it does."] },
};
