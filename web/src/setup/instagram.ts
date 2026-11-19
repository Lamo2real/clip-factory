// Instagram setup (docs/CONTRACTS.md §17.2): Instagram API with Facebook Login (Facebook Login for Business
// configuration), Graph API v27.0, checked against Meta for Developers on 19 Nov 2026. Its own Meta app, separate
// from the Facebook one. That path needs the Instagram professional account linked to a Facebook Page.
import { CHECKED_ON, type SetupGuide } from "./types.ts";

export const instagram: SetupGuide = {
  platform: "instagram",
  name: "Instagram",
  checkedOn: CHECKED_ON,
  minutes: 25,
  cost: "Free",
  keyWords: "App ID, App secret and Configuration ID",
  fix: { keys: "key-paste", redirect: "key-config", account: ["ready-pro", "ready-page"] },
  parts: [
    {
      id: "ready",
      title: "Get ready",
      steps: [
        {
          id: "ready-pro",
          icon: "user",
          title: "Make Instagram a pro account",
          say: [
            "In the Instagram app, tap your picture, then the menu.",
            "Tap **Account type and tools**, then **Switch to professional account**.",
            "Pick **Creator** or **Business**.",
            "Personal accounts cannot connect.",
          ],
        },
        {
          id: "ready-page",
          icon: "link",
          title: "Link Instagram to a Facebook Page",
          say: [
            "In the Instagram app, tap **Edit profile**, then **Page** (under Public business information).",
            "Pick your Facebook Page, or press **Create a Facebook Page**.",
            "No Page yet? Make one first in the Facebook setup, step 1.",
          ],
          ifYouSee: [
            {
              see: "no **Page** line in Edit profile",
              do: "On Facebook, open your Page, then **Settings**, then **Linked accounts**, then **Instagram**. Press **Connect account**.",
            },
            {
              see: "**Manage connection** on Facebook",
              do: "If it shows your clip Instagram name, it is linked. Close it. Never press **Disconnect**. Press I did this.",
            },
            {
              see: "the wrong Instagram under **Manage connection**",
              do: "Press **Disconnect**, then **Connect account** and log in to your clip Instagram.",
            },
          ],
        },
        {
          id: "ready-computer",
          icon: "monitor",
          title: "Use a computer",
          say: [
            "The developer websites work best on a computer. Use the same browser for every step.",
            "Log in to facebook.com with the Facebook account that will own the app.",
            "Wrong account? Log out first.",
          ],
          open: { label: "Open Facebook", url: "https://www.facebook.com/" },
        },
        {
          id: "ready-portfolio",
          icon: "folder",
          title: "Business portfolio, if Meta asks",
          say: [
            "Only if Meta asks for one. Press **Create a business portfolio**. Fill in a name, your name and email.",
            "Open **Settings**, then **Accounts**, then **Instagram accounts**.",
            "Press **Add** and log in to Instagram.",
            "Already in a portfolio? Use that one.",
          ],
          open: { label: "Open Meta Business", url: "https://business.facebook.com/" },
          optional: true,
        },
      ],
    },
    {
      id: "key",
      title: "Make your Instagram key",
      steps: [
        {
          id: "key-developer",
          icon: "user",
          title: "Become a Meta developer",
          say: ["Press **Next**.", "Type the codes Meta sends you.", "Pick **Creator**."],
          open: { label: "Open Meta for Developers", url: "https://developers.facebook.com/async/registration" },
        },
        {
          id: "key-app",
          icon: "plus",
          title: "Create the app",
          say: [
            "Press **Create app**. App name: paste it. Add your email. Press **Next**.",
            "Use case: **Manage messaging & content on Instagram**. Press **Next**.",
            "Pick your portfolio, or skip it. Press **Next**, then **Go to dashboard**.",
            "Never ask Meta for a review.",
          ],
          open: { label: "Open My Apps", url: "https://developers.facebook.com/apps" },
          copy: [{ label: "App name", value: { ref: "appName" } }],
        },
        {
          id: "key-basic",
          icon: "file",
          title: "Fill in Basic settings",
          say: [
            "Open **App settings**, then **Basic**.",
            "Paste the **Privacy Policy URL** and the **Terms of Service URL**.",
            "Under **User data deletion**, paste the **Data deletion instructions URL**.",
            "Pick a **Category**. Press **Save changes**.",
          ],
          copy: [
            { label: "Privacy Policy URL", value: { ref: "privacyUrl" } },
            { label: "Terms of Service URL", value: { ref: "termsUrl" } },
            { label: "Data deletion instructions URL", value: { ref: "dataDeletionUrl" } },
          ],
        },
        {
          id: "key-config",
          icon: "settings",
          title: "Make the Instagram login setup",
          say: [
            "Open **Use cases**, press **Customize** next to Instagram. Open the tab **API setup with Facebook login**.",
            "Press **Create new configuration** (under Facebook Login for Business › Configurations). Token type: **User access token**, the longest expiry. Assets: your Page and Instagram account.",
            "Press **Edit permissions**. Tick instagram_basic, **instagram_manage_insights**, instagram_content_publish, pages_show_list and pages_read_engagement.",
            "Press **Use this configuration**. Paste the Redirect URL. Press **Save**.",
          ],
          copy: [{ label: "Redirect URL", value: { ref: "redirectUri" } }],
          ifYouSee: [
            { see: "instagram_manage_insights not ticked", do: "Tick it. It is not ticked by itself." },
            { see: "instagram_manage_messages", do: "Leave it ticked." },
          ],
        },
        {
          id: "key-redirect-check",
          icon: "link",
          title: "Double-check the return address",
          say: ["Only if your app has a **Facebook Login for Business** page. No such page? Skip this."],
          copy: [{ label: "Valid OAuth Redirect URI", value: { ref: "redirectUri" } }],
          ifYouSee: [
            {
              see: "**Facebook Login for Business** › **Settings**",
              do: "Paste the address into **Valid OAuth Redirect URIs**. Turn **Enforce HTTPS** on. Press **Save changes**.",
            },
          ],
          optional: true,
        },
        {
          id: "key-paste",
          icon: "paste",
          title: "Paste the 3 values",
          say: [
            "Paste the **App ID** and the **App secret** (press **Show**; Facebook may ask your password).",
            "Paste the **Configuration ID**. The whole **Login URL** works too.",
            "Press **Save keys**.",
          ],
          paste: ["clientId", "clientSecret", "configId"],
          auto: "keys",
        },
      ],
    },
    {
      id: "connect",
      title: "Connect",
      steps: [
        {
          id: "connect",
          icon: "link",
          title: "Connect Instagram",
          say: [
            "Press **Connect Instagram**. Log in with the same Facebook account.",
            "Pick your portfolio if asked, then your Instagram. Confirm.",
            "Several accounts? You pick one in Clip Factory next.",
          ],
          auto: "connected",
          ifYouSee: [
            {
              see: "your Instagram is not in the list",
              do: "It is still personal (step 1), not linked to a Page (step 2), or in another portfolio (step 4).",
            },
          ],
        },
      ],
    },
    {
      id: "public",
      title: "Go public",
      steps: [
        {
          id: "public-try",
          icon: "play",
          title: "Post one test clip",
          say: [
            "Keep one clip and wait a few minutes.",
            "Instagram can take a few minutes to post. Numbers can take 2 days.",
          ],
          ifYouSee: [
            { see: "your Reels missing for other people", do: "Tell Clip Factory support. Meta may want the app Live." },
            {
              see: "Facebook asking you to confirm who runs the Page",
              do: "Do it. Instagram will not post until you do.",
            },
          ],
        },
      ],
    },
  ],
};
