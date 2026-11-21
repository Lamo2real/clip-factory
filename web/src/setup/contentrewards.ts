// Content Rewards (docs/CONTRACTS.md §38.3, §38.4, §38.7): one-time setup, joining a campaign, and getting paid.
// Plain data like the five platform guides (§17.2), checked against Content Rewards' app on 21 Nov 2026. **Bold** is
// the other site's own label, word for word. CR_GUIDE is its own guide: it is not one of the five in GUIDES, never
// joins the "2 of 5 ready" ring and never shows on the floating setup list (§17.13).
import type { CrGuide, CrStep } from "./types.ts";

export const CR_HOME = "https://contentrewards.com";
export const CR_SIGNUP = "https://contentrewards.com/login?intent=signup";
export const CR_LOGIN = "https://contentrewards.com/login";
export const CR_SETTINGS = "https://contentrewards.com/c/settings";
export const CR_DISCOVER = "https://contentrewards.com/c/discover";
export const CR_SUBMISSIONS = "https://contentrewards.com/c/submissions";
export const CR_EARNINGS = "https://contentrewards.com/c/earnings";
export const CR_APP_HOME = "https://contentrewards.com/c/home";
export const WHOP = "https://whop.com/";
export const YOUTUBE_STUDIO = "https://studio.youtube.com/";

/** The pilot email (§38.3): written for Content Rewards' support team, so it is only ever under Show more. */
export const CR_PILOT_EMAIL = {
  to: "support@contentrewards.com",
  subject: "Please let my account connect apps (MCP sign-in pilot)",
  body:
    "Hi! Please let my Content Rewards account connect apps, so Clip Factory can send my own clips for me. My login is this email address. Thank you! (For your team: MCP sign-in pilot, scope my_submissions:write.)",
} as const;

/** `mailto:` with the subject and body URL-encoded (the desktop app hands it to Mail). */
export function pilotMailto(email: { to: string; subject: string; body: string } = CR_PILOT_EMAIL): string {
  return `mailto:${email.to}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`;
}

/** Step 2's line after "Clip Factory posts to: …" (§38.3, unchanged), and its last line (§39.1). */
const CR_TIKTOK_WAITS_LINE =
  "TikTok can wait. TikTok posts from Clip Factory stay private until TikTok checks the app, and private posts can't earn.";
const CR_SOCIALS_LAST_LINE = "Then come back to Clip Factory. Tap I added them.";

/** Whop's screens were not seen (§38.1): every Whop step says so. */
export const WHOP_HINT = "Whop may show this a little differently. Look for the same words.";

/**
 * "Content Rewards said no?" (§38.3): an unnumbered card under step 3, open when Connect said the account can't
 * connect apps (or the sign-in is read only); otherwise folded under its question. It ticks itself on can_submit.
 */
export const CR_PILOT: CrStep = {
  id: "connect-pilot",
  icon: "info",
  title: "Content Rewards said no?",
  say: [
    "Content Rewards turns this on by email.",
    "Send it from the email you use to sign in to Content Rewards. Check the From line.",
  ],
  mailto: { label: "Open email", href: pilotMailto() },
  copy: [{ label: "Email to Content Rewards", value: CR_PILOT_EMAIL.body }],
  ask: { label: "I sent it", said: "pilot_sent" },
  auto: "can_submit",
  manual: false,
};

/** The lines after "I sent it" on the "Content Rewards said no?" card. */
export const CR_PILOT_AFTER = [
  "Content Rewards will email you back. When they say yes, come back and tap Connect Content Rewards.",
  "Until then, you send each clip yourself. I'll remind you after each post.",
  "Sign in to Content Rewards on your phone now. Then sending by hand is quick.",
];

export const CR_GUIDE: CrGuide = {
  name: "Content Rewards",
  checkedOn: "2026-11-21",
  minutes: 10,
  cost: "Free",
  parts: [
    {
      id: "setup",
      title: "Set it up once",
      steps: [
        {
          id: "ready-account",
          icon: "user",
          title: "Make a Content Rewards account",
          lead: "Have one already? Tap I have an account.",
          doneLabel: "I have an account",
          say: [
            "Tap **Continue with Google**. Pick your Google account.",
            "Or type your email in **Email**. Tap **Send code**. Type the 6 numbers from the email. Tap **Verify**.",
            "You must be 18 or older. One account per person.",
            "Then come back to Clip Factory. Tap I have an account.",
          ],
          open: { label: "Open Content Rewards", url: CR_SIGNUP },
          auto: "connected",
          ifYouSee: [
            { see: "“That code is incorrect or has expired”", do: "Tap **Resend code** and use the newest email." },
            { see: "“We already sent a code”", do: "Look in Spam or Promotions." },
            { see: "the wrong email", do: "Tap **Change it**." },
            { see: "a few questions after signing in", do: "Answer them. Any answer is fine." },
            { see: "a cookie bar", do: "Tap **Accept** or **Decline**. Both are fine." },
          ],
        },
        {
          id: "ready-socials",
          icon: "link",
          title: "Add your accounts there",
          // The {places} of the lead are the places connected in Clip Factory (CrSetup.tsx says them).
          lead: "Already added YouTube there? Tap I added them.",
          doneLabel: "I added them",
          say: [
            "Tap **Accounts**.",
            "Tap **Connect account**. Tap YouTube.",
            "On the next screen, leave every box ticked and tap Allow or Continue.",
            "Add Instagram, X and Facebook the same way, if you post there.",
            "Each one should say **Connected**.",
            // The page puts "Clip Factory posts to: …" (from GET /v1/setup) right before the TikTok line.
            CR_TIKTOK_WAITS_LINE,
            CR_SOCIALS_LAST_LINE,
          ],
          open: { label: "Open Content Rewards settings", url: CR_SETTINGS },
          auto: "linked",
          ifYouSee: [
            { see: "no **Accounts** tab", do: "Look for **Connected accounts**." },
            { see: "**Verify** in red", do: "Tap it and allow again." },
            { see: "**Sign in again**", do: "Tap it." },
            { see: "**In review**", do: "Nothing to do. Content Rewards adds it for you." },
            { see: "“already connected to another creator”", do: "That account is on another Content Rewards account. Take it off there, or ask Content Rewards support." },
            { see: "“access wasn't granted”", do: "Tap **Connect account** again and leave every box ticked." },
            { see: "“No YouTube channel found”", do: "Pick the Google account that owns your channel." },
          ],
          folds: [
            {
              id: "fold-instagram",
              question: "Content Rewards says **Not a professional account**?",
              say: [
                "Already Creator or Business? Skip this.",
                "Tap **More**, then **Settings**.",
                "Tap **Account type and tools**.",
                "Tap **Switch to professional account**. Tap **Business**, then **Next**.",
                "Pick any category. Then add Instagram again on Content Rewards.",
              ],
              open: { label: "Open Instagram", url: "https://www.instagram.com/" },
            },
            {
              id: "fold-facebook",
              question: "Content Rewards asks for a Facebook code?",
              say: [
                "Tap **Connect account**, then Facebook. Type your Page name and tap **Continue**.",
                "Tap **Copy code**.",
                "Tap Reel. Pick any short video from your phone.",
                "Paste the code as the caption.",
                "Set who sees it to **Public**. Tap Share.",
                "On the Reel tap Share, then Copy link.",
                "Go back to Content Rewards. Paste it in **Your Facebook post link**. Tap **Verify account**.",
                "The code works for 24 hours.",
              ],
              open: { label: "Open Facebook", url: "https://www.facebook.com/" },
              ifYouSee: [
                { see: "“That's a link to a Facebook post, not a Reel”", do: "Post a Reel, then copy the Reel's link." },
                { see: "“We couldn't read that Facebook post”", do: "Set the Reel to **Public**, then tap **Check again**." },
                { see: "“Not there yet”", do: "Wait 30 seconds and tap **Check again**." },
              ],
            },
          ],
        },
        {
          id: "connect",
          icon: "key",
          title: "Connect Content Rewards",
          // The Mac app's words; the page shows the words for where it runs (lib/crConnect.ts connectPlace()).
          say: [
            "Your web browser opens Content Rewards. Sign in with the same account.",
            "Tap the button that allows Clip Factory.",
            "When the page says Done, come back here.",
          ],
          auto: "connected",
          manual: false,
          ifYouSee: [
            { see: "**Sign-in failed**", do: "Close that tab and tap Connect Content Rewards again." },
            { see: "“your account can't connect apps”", do: "Look at the card Content Rewards said no? below. It has an email for you." },
            { see: "nothing happen", do: "Look for a new browser tab. Still nothing? Tap Connect Content Rewards again." },
          ],
        },
      ],
    },
    {
      id: "join",
      title: "Join a campaign",
      steps: [
        {
          id: "join-find",
          icon: "search",
          title: "Pick a campaign",
          say: [
            "Tap **Sort**, then **Highest CPM**. That shows the best pay first.",
            "Pick one that pays for YouTube. Skip ones that need your face, a sound, or only TikTok.",
            "Not sure? Paste its link here first. I'll check it before you join.",
          ],
          open: { label: "Open Content Rewards", url: CR_DISCOVER },
          manual: false,
        },
        {
          id: "join-join",
          icon: "plusSquare",
          title: "Join it",
          say: [
            "Open the campaign. Tap **Join Campaign**.",
            "Some campaigns say **Apply**. Tap it.",
            "Tick your YouTube and Instagram accounts. Answer the questions.",
            "Tap **Submit application**.",
          ],
          auto: "membership",
          manual: false,
          ifYouSee: [
            { see: "**Hold to confirm**", do: "Press and hold it." },
            { see: "“Select at least one account”", do: "Tick at least one account." },
            { see: "“Must be at least … characters”", do: "Write a little more." },
            { see: "“Enter a full link, e.g. https://…”", do: "Tap a Copy chip above and paste it." },
            { see: "a box about Discord", do: "Tap **Done**. You don't need Discord." },
            { see: "“This brand has gone quiet”", do: "Pick another campaign." },
            { see: "a sign-in page", do: "Sign in with your email code, then tap the button again." },
            { see: "“Campaign is not accepting applications”", do: "Pick another campaign." },
          ],
        },
        {
          id: "join-copy",
          icon: "copy",
          title: "Copy its link",
          say: [
            "Tap the share icon at the top right, then **Copy campaign link**. It says Link copied.",
            "Or copy the address at the top of the browser.",
            "Come back to Clip Factory. Tap Paste in the box at the top.",
          ],
          manual: false,
        },
      ],
    },
    {
      id: "move",
      title: "Move your money to Whop",
      steps: [
        {
          id: "move-whop",
          icon: "link",
          title: "Link your Whop account",
          finance: "no",
          repeat: "once",
          say: [
            "No Whop account? Tap **Open Whop** and make one with the same email.",
            "Find Connect your Whop account and tap **Open Whop**.",
            "Sign in to Whop and allow it. Then come back.",
          ],
          open: { label: "Open Content Rewards settings", url: CR_SETTINGS },
          auto: "whop_linked",
          ifYouSee: [
            { see: "no Connect your Whop account", do: "Tap **Profile** and look again." },
            { see: "“Could not open Whop. Try again.”", do: "Tap **Open Whop** again." },
            { see: "“already connected to another creator”", do: "Use your own Whop account, or ask Content Rewards support." },
          ],
        },
        {
          id: "fin-setup",
          icon: "shield",
          title: "Set up payouts",
          finance: "yes",
          repeat: "once",
          say: [
            "Tap **Finance** in the menu. You'll see **Set up payouts**.",
            "Do each one: **Verify your identity**, **Set your tax handling**, **Turn on two-factor auth**, **Add a bank account**.",
            "Some open on Whop. Tap **Continue on Whop**, finish there, then come back.",
          ],
          open: { label: "Open Content Rewards", url: CR_APP_HOME },
          ifYouSee: [
            { see: "“Your details are in review with Whop”", do: "Nothing to do. Wait a day or two." },
            { see: "“Setup session expired”", do: "Tap **Continue on Whop** again." },
            { see: "“Payouts are turned off”", do: "Ask Content Rewards support." },
          ],
        },
        {
          id: "move-withdraw",
          icon: "coin",
          title: "Move money to Whop",
          finance: "both",
          repeat: "each_time",
          say: [
            "Tap **Withdraw**.",
            "Paste the amount in **Amount**. It must be $1.00 or more.",
            "Tap **Withdraw** again.",
            "It says the money is on its way to your Whop balance. It usually takes minutes.",
          ],
          open: { label: "Open Earnings", url: CR_EARNINGS },
          auto: "money_moving",
          manual: false,
          ifYouSee: [
            { see: "“Minimum withdrawal is $1.00.”", do: "Wait until you have $1 or more." },
            { see: "“Connect payout account in Settings”", do: "Do the step above: link Whop." },
            { see: "“You don't have any available balance to withdraw yet.”", do: "Money under **Queued** or **Arriving** isn't ready yet." },
            { see: "**Add your phone number**", do: "Type your number and tap **Save number**, or tap **Skip**." },
            { see: "“Your withdrawal is processing”", do: "Tap **Try again** with the same amount." },
          ],
        },
      ],
    },
    {
      id: "bank",
      title: "Get it to your bank",
      steps: [
        {
          id: "bank-setup",
          icon: "card",
          title: "Add your bank on Whop",
          finance: "no",
          repeat: "once",
          say: [
            "Tap **Dashboard**, then **Balances**, then **Payout methods**.",
            "Tap **Add payout method**. Type your bank details.",
            "Whop checks your ID once. It wants a photo of your ID and a selfie. It can take a day or two.",
            "Whop may ask you to turn on a phone code. Tap **Security & Privacy**, then **Two-factor authentication**, then **Text message**.",
            WHOP_HINT,
          ],
          open: { label: "Open Whop", url: WHOP },
        },
        {
          id: "bank-cashout",
          icon: "coin",
          title: "Get it to your bank",
          finance: "no",
          repeat: "each_time",
          say: [
            "Tap **Balances** (or **Profile**, then **Balance**).",
            "Tap **Withdraw**.",
            "Paste the amount in **Amount**. Tap **Continue**.",
            "Tap **Payout**.",
            "Pick the normal way, not instant. It costs less. It takes up to 5 weekdays.",
            "Whop may need $10 or more before it sends to your bank.",
            WHOP_HINT,
          ],
          open: { label: "Open Whop", url: WHOP },
          auto: "money_moved",
          manual: false,
        },
        {
          id: "fin-bank",
          icon: "card",
          title: "Get it to your bank",
          finance: "yes",
          repeat: "each_time",
          say: ["Tap **Finance**. Look under Recent withdrawals.", "Processing to bank means it's on its way."],
          open: { label: "Open Content Rewards", url: CR_APP_HOME },
          manual: false,
          ifYouSee: [{ see: "“Bank send didn't go through”", do: "Tap **Manage** and check your bank details." }],
        },
      ],
    },
  ],
};

export const CR_TIKTOK_WAITS = CR_TIKTOK_WAITS_LINE;
export const CR_SOCIALS_LAST = CR_SOCIALS_LAST_LINE;

/** The shortcut above the steps, while steps 1 and 2 are both not done (§39.1 item 0). */
export const CR_SHORTCUT = { question: "Already use Content Rewards, with {places} added there?", none: "Already use Content Rewards, with your accounts added?", yes: "Yes" } as const;

/** The three numbered setup steps (the ring counts these). */
export const CR_SETUP_STEPS: readonly CrStep[] = CR_GUIDE.parts.find((p) => p.id === "setup")!.steps;

export function crPart(id: "setup" | "move" | "bank" | "join") {
  return CR_GUIDE.parts.find((p) => p.id === id)!;
}

/** Every CR_GUIDE step (and the "said no?" card), for the knowledge pack and the tests. */
export function crAllSteps(): CrStep[] {
  return [...CR_GUIDE.parts.flatMap((p) => p.steps), CR_PILOT];
}
