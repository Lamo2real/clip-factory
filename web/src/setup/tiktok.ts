// TikTok setup (docs/CONTRACTS.md §17.2), checked against TikTok for Developers on 19 Nov 2026, from what the owner
// really met there: Save on the app page stays off until App review has its text and a video, Display API is now part
// of Login Kit (video.list and user.info.stats come from Login Kit's Add scopes), and Platforms is Web only.
// Until TikTok approves the app, it only posts to private accounts, and every post is "Only me".
import type { SetupGuide } from "./types.ts";

const DEV = "https://developers.tiktok.com";

export const tiktok: SetupGuide = {
  platform: "tiktok",
  name: "TikTok",
  checkedOn: "2026-11-19",
  minutes: 40,
  cost: "Free",
  timeNote: "+ TikTok's review time",
  keyWords: "Client key and secret",
  fix: { keys: "key-paste", redirect: "key-redirect", account: ["ready-account"] },
  publicNote: "TikTok may say no to a tool only you use. Then your posts stay private, but they still post.",
  parts: [
    {
      id: "ready",
      title: "Get ready",
      steps: [
        {
          id: "ready-account",
          icon: "user",
          title: "Have your TikTok account",
          say: ["Use the TikTok account your clips go on.", "Know its login. You will log in a few times."],
        },
        {
          id: "ready-computer",
          icon: "monitor",
          title: "Use a computer",
          say: ["The developer websites work best on a computer.", "Use the same browser for every step."],
        },
        {
          id: "ready-private",
          icon: "lock",
          title: "Make your TikTok private for now",
          say: [
            "In the TikTok app, tap **Profile**, then the menu (three lines).",
            "Tap **Settings and privacy**, then **Privacy**.",
            "Turn on **Private account**.",
            "Until TikTok checks the app, it only posts to private accounts.",
          ],
        },
      ],
    },
    {
      id: "key",
      title: "Make your TikTok key",
      steps: [
        {
          id: "key-signup",
          icon: "user",
          title: "Make a TikTok developer account",
          say: ["Open TikTok for Developers.", "Press **Sign up** (or **Log in**). Accept the terms."],
          open: { label: "Open TikTok for Developers", url: `${DEV}/signup` },
        },
        {
          id: "key-org",
          icon: "users",
          title: "Make an organization",
          say: ["Press **Add organization**.", "Name: paste it. Press **Create**."],
          open: { label: "Open Organizations", url: `${DEV}/organizations` },
          copy: [{ label: "Organization name", value: { ref: "appName" } }],
        },
        {
          id: "key-app",
          icon: "plus",
          title: "Create the app",
          say: [
            "Tap your profile icon, then **Manage apps**.",
            "Press **Connect an app**.",
            "Pick your organization. Press **Confirm**.",
          ],
          open: { label: "Open Manage apps", url: `${DEV}/apps/` },
        },
        {
          id: "key-details",
          icon: "file",
          title: "Fill in App details",
          say: [
            "Download the icon below, then upload it as the app icon.",
            "Paste the App name and the Description. Category: pick the one that fits best.",
            "Paste the **Terms of Service URL** and the **Privacy Policy URL**.",
            "Don't press **Save** yet. It stays off until **App review** has its text and a video (step 13).",
          ],
          download: { label: "Download the icon", href: "/brand/clip-factory-1024.png" },
          copy: [
            { label: "App name", value: { ref: "appName" } },
            { label: "Description", value: { ref: "appDescription" } },
            { label: "Terms of Service URL", value: { ref: "termsUrl" } },
            { label: "Privacy Policy URL", value: { ref: "privacyUrl" } },
          ],
        },
        {
          id: "key-web",
          icon: "globe",
          title: "Choose Web",
          say: ["Under **Platforms**, tick **Web** only. Not **Desktop**, not Android or iOS.", "Website URL: paste it."],
          copy: [{ label: "Website URL", value: { ref: "websiteUrl" } }],
        },
        {
          id: "key-products",
          icon: "plus",
          title: "Add 2 products",
          say: [
            "Press **Add products**.",
            "Add **Login Kit** and **Content Posting API**. Nothing else.",
            "There is no **Display API** to add now. Its permissions come with Login Kit.",
          ],
        },
        {
          id: "key-redirect",
          icon: "link",
          title: "Paste the return address",
          say: ["Open the **Login Kit** settings.", "Paste the return address into **Redirect URI** for **Web**."],
          copy: [{ label: "Redirect URI", value: { ref: "redirectUri" } }],
        },
        {
          id: "key-direct-post",
          icon: "bolt",
          title: "Turn on Direct Post",
          say: ["Open the **Content Posting API** settings.", "Turn on **Direct Post**."],
          ifYouSee: [{ see: "a switch with \"Direct Post\" in its name", do: "Turn that one on." }],
        },
        {
          id: "key-scopes",
          icon: "key",
          title: "Add 2 permissions",
          say: [
            "In **Login Kit**, open **Scopes**. Press **Add scopes**.",
            "Tick **video.list** (your views) and **user.info.stats** (your followers, for the money tile). Press **Add**.",
            "Now these must be there: user.info.basic, video.publish, video.list, user.info.stats.",
            "video.upload may be there too. Leave it.",
          ],
          ifYouSee: [{ see: "no **Add scopes** button", do: "Open **Login Kit** first. The button is under its **Scopes**." }],
        },
        {
          id: "key-review",
          icon: "review",
          title: "Fill in App review, then Save",
          say: [
            "Open **App review**. Paste the text below.",
            "Record your screen for a few seconds: the About page, then this setup page. Upload that video.",
            "Now press **Save**. You swap in the real demo video later (step 21).",
          ],
          copy: [
            { label: "Review text", value: { ref: "tiktokReviewText" } },
            { label: "About page", value: { ref: "websiteUrl" } },
          ],
          ifYouSee: [{ see: "**Save** still won't press", do: "App review needs both: the text and a video. Check both are there." }],
        },
        {
          id: "key-verify",
          icon: "shield",
          title: "Prove the website is yours",
          say: [
            "Open **URL properties**. Press **Verify properties** with **Production** picked.",
            "Pick **URL prefix** (not Domain). Paste the address. Press **Verify**.",
            "Download TikTok's file. Drop it in the box below.",
            "Back on TikTok, press **Verify**.",
          ],
          copy: [{ label: "URL prefix", value: { ref: "websitePrefix" } }],
          upload: "tiktok-verification",
          auto: "files",
        },
        {
          id: "key-paste",
          icon: "paste",
          title: "Paste Client key and secret",
          say: [
            "Open **Credentials**.",
            "Press the copy icon next to **Client key**. Paste it below.",
            "Do the same for **Client secret**. Press **Save keys**.",
          ],
          paste: ["clientId", "clientSecret"],
          auto: "keys",
        },
      ],
    },
    {
      id: "connect",
      title: "Connect",
      steps: [
        {
          id: "sandbox-make",
          icon: "layers",
          title: "Make a Sandbox for testing",
          say: [
            "Switch **Production** to **Sandbox**. Press **Create Sandbox**.",
            "Give it a name. Clone Production. Press **Confirm**.",
            "Press **Apply changes**.",
            "Connect in the Sandbox first. Posts stay private until TikTok approves the app.",
          ],
        },
        {
          id: "sandbox-user",
          icon: "user",
          title: "Add yourself as a test user",
          say: [
            "Open **Sandbox settings**, then **Target users**.",
            "Press **Add account**. Log in and accept.",
            "It can take up to an hour. Refresh the page to check.",
          ],
        },
        {
          id: "sandbox-verify",
          icon: "shield",
          title: "Verify the website in Sandbox too",
          say: [
            "Do the Prove the website step again, with **Sandbox** picked.",
            "Drop that file in the box below too.",
          ],
          copy: [{ label: "URL prefix", value: { ref: "websitePrefix" } }],
          upload: "tiktok-verification",
        },
        {
          id: "sandbox-keys",
          icon: "key",
          title: "Use the Sandbox keys",
          say: ["Look at **Credentials** in the Sandbox."],
          optional: true,
          ifYouSee: [
            {
              see: "a different Client key in the Sandbox",
              do: "Paste those keys here for now: open the Paste step and press Change keys.",
            },
          ],
        },
        {
          id: "connect",
          icon: "link",
          title: "Connect TikTok",
          say: [
            "Press **Connect TikTok**. Log in.",
            "Check that it says Clip Factory. Leave every switch on.",
            "Press **Authorize**.",
          ],
          auto: "connected",
        },
      ],
    },
    {
      id: "public",
      title: "Go public",
      steps: [
        {
          id: "public-demo",
          icon: "video",
          title: "Record the real demo video",
          say: [
            "Record your screen while you use Clip Factory, connected in the Sandbox.",
            "Show: open Clip Factory, press **Connect TikTok**, TikTok's **Authorize** screen.",
            "Then press **Upload** on a clip, pick in the **Post to TikTok** sheet, and Upload.",
            "Then show the post arriving on your TikTok.",
          ],
          copy: [{ label: "About page", value: { ref: "websiteUrl" } }],
        },
        {
          id: "public-review",
          icon: "review",
          title: "Ask TikTok to check the app",
          say: [
            "Switch back to **Production**. Open **App review**.",
            "Check the text below is there. Swap in the real demo video (up to 5, 50 MB each). Press **Save**.",
            "Press **Submit for review**. Then pick what TikTok says below.",
          ],
          copy: [{ label: "Review text", value: { ref: "tiktokReviewText" } }],
          gate: "app_review",
          extra: "tiktok-review",
          ifYouSee: [{ see: "**Not approved**", do: "Read **Review comments**, fix what they say, and submit again." }],
        },
        {
          id: "public-live-keys",
          icon: "key",
          title: "When it says Live",
          say: ["Look at **Credentials** in **Production**."],
          optional: true,
          ifYouSee: [
            {
              see: "Production keys that are not the Sandbox ones",
              do: "Paste them in the Paste step, then press Connect again.",
            },
          ],
        },
        {
          id: "public-audit",
          icon: "shield",
          title: "Ask to post publicly",
          say: [
            "Open TikTok's form and fill it in.",
            "Until it passes, every post is **Only me**.",
            "TikTok may say no to a tool only you use. Then posts stay private.",
          ],
          open: { label: "Open TikTok's form", url: `${DEV}/application/content-posting-api` },
          gate: "posting_audit",
        },
        {
          id: "public-unprivate",
          icon: "lock",
          title: "Make your account public again",
          say: ["Only after TikTok says yes to the form.", "In the TikTok app, turn **Private account** off."],
        },
      ],
    },
  ],
};
