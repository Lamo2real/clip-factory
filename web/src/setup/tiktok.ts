// TikTok setup (docs/CONTRACTS.md §17.2), checked against TikTok for Developers on 19 Nov 2026, from what the owner
// really met there: Save on the app page stays off until App review has its text and a video, Display API is now part
// of Login Kit (video.list and user.info.stats come from Login Kit's Add scopes), and Platforms is Web only.
// Until TikTok approves the app, it only posts to private accounts, and every post is "Only me".
// Go public checked again on 21 Nov 2026 against TikTok's Content Sharing Guidelines and what applicants met in the
// Direct Post audit form (4 pages that do not save: General Information, API client information, Supporting
// documents, Review). App review must say Live before the form's Apply link shows. The answers below are literally
// true today: Clip Factory is one creator's own clipping tool, invite-only, used by that one creator.
import type { SetupGuide } from "./types.ts";

const DEV = "https://developers.tiktok.com";

/** The demo video for App review and the audit form: every point TikTok checks, in order, by the app's own words. */
export const TIKTOK_DEMO_SHOTS = [
  "1. Start on the About page. Show the Privacy and Terms links, and keep the address bar in sight.",
  "2. Sign in. Open Settings › Posting › Set up posting › TikTok. Press Connect TikTok. Show TikTok's screen with every permission, press Authorize, then show TikTok connected.",
  "3. Show where the clip comes from: the long video or stream you picked (or the campaign brief).",
  "4. Open Review. Play the clip. Show it has no watermark or logo on it.",
  "5. Show nothing is set for TikTok yet. Tap the TikTok row (caption and settings). Show \"Asking TikTok…\", then \"Posting as\" with your name and picture.",
  "6. Change the TikTok caption: the words and the hashtags.",
  "7. Show Upload is held: \"Pick who can see it on TikTok first.\" Open Who can see it: nothing is picked, and only TikTok's choices are there. Don't pick yet.",
  "8. Show Comments, Duet and Stitch: all off. Turn one on by hand. A switch you turned off in TikTok is grey: \"Turned off in your TikTok settings.\"",
  "9. Turn on Commercial content. Show the line under it: \"Pick Your brand, Branded content, or both.\" Pick Only me in Who can see it. Show Upload is still held: \"Pick Your brand or Branded content on TikTok first.\"",
  "10. Tick Your brand. Show its \"Promotional content\" tag.",
  "11. Tick Branded content. Show \"Paid partnership\" and the Branded Content Policy line above Upload. Who can see it now says: \"Branded content can't be Only me. Turn off Branded content.\"",
  "12. Untick Branded content. Pick Only me by hand. Turn Commercial content off.",
  "13. Show the Music Usage Confirmation line right above Upload.",
  "14. Press Upload. Show the note: \"TikTok can take a few minutes to process your clip.\"",
  "15. Open Library. Show the clip on its way, then Posted.",
  "16. Open TikTok. Show the post: private (only you can see it), your caption as you changed it, your Comments, Duet and Stitch picks, and no watermark.",
  "17. Open Money. Show the TikTok part (it uses video.list and user.info.stats). If it asks for your OK, give it, so TikTok's screen shows user.info.stats.",
  "18. Last, on another clip: show nothing is on. Tap Use my settings: your saved TikTok choices go on with that one tap. Tap the TikTok row to show every option.",
].join("\n");

/** TikTok's own app Description (App details): the same facts as the audit answers, not the shared APP_DESCRIPTION. */
export const TIKTOK_APP_DESCRIPTION =
  "My own clipping tool. It turns long videos and streams I pick (my own and other creators', including paid clipping campaigns) into short clips, and posts the ones I approve to my own accounts when I press Upload.";

/** Audit form, page 1: what Clip Factory is and who uses it. True today: one creator, invite-only. */
export const TIKTOK_AUDIT_DESCRIPTION = [
  "Clip Factory is my own clipping tool, for me as one creator. Today I am its only user. Sign-up is invite-only, so it is not open to the public.",
  "There is no company. Clip Factory is the name of my tool, and I am one person.",
  "It turns long videos and streams I pick into short vertical clips. The sources are my own gameplay recordings and other creators' streams and videos, including paid clipping campaigns (such as Content Rewards), where a creator pays clippers to post clips of their content. I treat campaign clips as paid partnerships and mark them as Branded content.",
  "I watch every clip and post only the ones I approve, to my own TikTok account, which I connected myself with Login Kit.",
].join("\n\n");

/** Audit form, page 2: how Direct Post is used, with every creator control the Post to TikTok choices really have. */
export const TIKTOK_AUDIT_DIRECT_POST = [
  "Clip Factory uses Direct Post to post one clip to my own TikTok account when I press Upload. Nothing posts by itself.",
  "Before each post it asks TikTok for my creator info and shows my nickname and picture. I pick who can see it from TikTok's own options; nothing is picked for me. Comments, Duet and Stitch start off, and a setting I turned off in TikTok stays off and grey. I can turn on Commercial content and pick Your brand, Branded content or both; Branded content can't be Only me. I can edit the caption. TikTok's Music Usage Confirmation (and the Branded Content Policy for branded content) shows above Upload. A clip longer than TikTok allows for me can't be posted.",
  "After Upload, Clip Factory sends the video file, tells me TikTok can take a few minutes, and checks the post status until it is posted.",
  "A Use my settings button puts my saved TikTok choices on with one tap of mine, per clip. Opening the TikTok row shows every option.",
  "Other scopes: user.info.basic shows my name and picture. video.list shows the views and likes of my own posts. user.info.stats shows my follower count on my Money page, only after I say OK.",
].join("\n\n");

/** Audit form, page 2: how the daily users number was found (pick the smallest choice in the dropdown). */
export const TIKTOK_AUDIT_USAGE =
  "Clip Factory has one user: me. Sign-up is invite-only, so at most 1 creator posts with it on any day, up to about 15 clips, which is TikTok's own daily limit for one creator. So I picked the smallest choice.";

/** Audit form, page 3: every piece of TikTok data Clip Factory keeps (checked against the api code, 21 Nov 2026). */
export const TIKTOK_AUDIT_DATA = [
  "Clip Factory stores this TikTok data, for my one account only:",
  "- open_id",
  "- access token and refresh token (in AWS Secrets Manager, encrypted at rest), and when they expire",
  "- the scopes I granted",
  "- username, display name and avatar URL",
  "- for each post: publish_id, the privacy level I picked, the post status, TikTok's post id, and the error if a post fails",
  "- the caption I wrote",
  "- views, likes, comments and shares of my own posts (video.list)",
  "- a total of views and a count of long videos from my recent videos (video.list)",
  "- my follower count (user.info.stats, only after I say OK)",
  "Disconnect revokes the token and deletes it.",
].join("\n");

export const tiktok: SetupGuide = {
  platform: "tiktok",
  name: "TikTok",
  checkedOn: "2026-11-21",
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
            { label: "Description", value: TIKTOK_APP_DESCRIPTION },
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
            "Use a computer. Connect in the Sandbox, with your TikTok still private. Record your screen with the address bar in sight.",
            "Follow the shot list below, in order. It starts on the About page, then **Connect TikTok** and TikTok's **Authorize** screen.",
            "Then **Upload** one clip, choosing everything by hand in the **TikTok** row. Show each line TikTok wants to see.",
            "End with the post arriving on your TikTok. Keep it short, about 1 minute. Save it as MP4, under 50 MB.",
          ],
          copy: [
            { label: "Shot list", value: TIKTOK_DEMO_SHOTS },
            { label: "About page", value: { ref: "websiteUrl" } },
          ],
          ifYouSee: [
            {
              see: "a line from the shot list you can't find",
              do: "Tap the **TikTok** row to open it. Every line is in there or right above **Upload**. TikTok checks every one.",
            },
            { see: "your Client secret, a key or a long code on screen", do: "Cut that part out before you upload the video." },
          ],
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
            "Only after **App review** says **Live**. In **Production**, open **Content Posting API**. Press **Apply** next to **Direct Post**.",
            "The form has 4 pages and does not save. Paste each answer below into the box with the same name.",
            "For how many users, pick the smallest choice. Upload your demo video. Read and tick the 3 boxes. Press **Next**.",
            "TikTok's rules ask for apps that many people can use. Clip Factory is only for you. If it says no, posts stay private but still post.",
          ],
          open: { label: "Open TikTok's form", url: `${DEV}/application/content-posting-api` },
          copy: [
            { label: "Organization name", value: { ref: "appName" } },
            { label: "Organization website", value: { ref: "websiteUrl" } },
            { label: "Organization description", value: TIKTOK_AUDIT_DESCRIPTION },
            { label: "How you use Direct Post", value: TIKTOK_AUDIT_DIRECT_POST },
            { label: "How you got the number", value: TIKTOK_AUDIT_USAGE },
            { label: "Data you store", value: TIKTOK_AUDIT_DATA },
          ],
          gate: "posting_audit",
          ifYouSee: [
            { see: "**Your full name**", do: "Type your own name." },
            { see: "a box for the app ID", do: "Copy the long number after /app/ in the address bar of your TikTok app page." },
            { see: "no **Apply** button", do: "Wait until **App review** says **Live**, or press Open TikTok's form above." },
            { see: "a spinner after **Next**", do: "Your video is uploading. It can take 2 minutes. Keep the page open." },
            { see: "**Under review**", do: "You are done for now. TikTok often takes 1 to 3 weeks." },
            { see: "a no with empty **Review comments**", do: "Ask TikTok support for the reason before you try again." },
          ],
        },
        {
          id: "public-unprivate",
          icon: "lock",
          title: "Make your account public again",
          say: [
            "Only after TikTok says yes to the form.",
            "In the TikTok app, turn **Private account** off.",
            "Posts from before stay private. To show one, change it to **Everyone** in the TikTok app.",
            "TikTok still allows about 15 posts a day.",
          ],
        },
      ],
    },
  ],
};
