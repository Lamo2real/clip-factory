// YouTube setup (docs/CONTRACTS.md §17.2), checked against Google's pages on 16 Nov 2026.
import { CHECKED_ON, type SetupGuide } from "./types.ts";

const CONSOLE = "https://console.cloud.google.com";

export const youtube: SetupGuide = {
  platform: "youtube",
  name: "YouTube",
  checkedOn: CHECKED_ON,
  minutes: 20,
  cost: "Free",
  keyWords: "Client ID and secret",
  fix: { keys: "key-client", redirect: "key-client", account: ["ready-channel"] },
  parts: [
    {
      id: "ready",
      title: "Get ready",
      steps: [
        {
          id: "ready-channel",
          icon: "play",
          title: "Have a YouTube channel",
          say: [
            "Open your YouTube account page.",
            "No channel yet? Tap your profile picture, then **Create a channel**.",
            "Shorts are tall videos up to 3 minutes long.",
            "Keep clips with music under 1 minute. Longer ones with music get blocked.",
          ],
          open: { label: "Open YouTube", url: "https://www.youtube.com/account" },
        },
        {
          id: "ready-computer",
          icon: "monitor",
          title: "Use a computer",
          say: [
            "The developer websites work best on a computer.",
            "Use the same browser for every step.",
            "Sign in to Google with the account that owns your channel.",
          ],
        },
      ],
    },
    {
      id: "key",
      title: "Make your YouTube key",
      steps: [
        {
          id: "key-console",
          icon: "globe",
          title: "Open Google Cloud",
          say: [
            "Open Google Cloud.",
            "First time here? Pick your country, tick the box, press **Agree and continue**.",
            "You do not need a card. Skip any free trial offer.",
          ],
          open: { label: "Open Google Cloud", url: `${CONSOLE}/` },
        },
        {
          id: "key-project",
          icon: "folder",
          title: "Make a project",
          say: [
            "Open the new project page.",
            "Project name: paste the name below. Location: **No organization**.",
            "Press **Create**. Wait for the bell at the top to say it is done.",
            "Check that **Clip Factory** is picked at the top of the page.",
          ],
          open: { label: "Open New project", url: `${CONSOLE}/projectcreate` },
          copy: [{ label: "Project name", value: { ref: "appName" } }],
        },
        {
          id: "key-data-api",
          icon: "play",
          title: "Turn on YouTube Data API v3",
          say: ["Open the YouTube Data API v3 page.", "Press **Enable**."],
          open: { label: "Open YouTube Data API v3", url: `${CONSOLE}/apis/library/youtube.googleapis.com` },
          ifYouSee: [{ see: "a **Manage** button instead of Enable", do: "It is already on. Press I did this." }],
        },
        {
          id: "key-analytics-api",
          icon: "chart",
          title: "Turn on YouTube Analytics API",
          say: ["Open the YouTube Analytics API page.", "Press **Enable**."],
          open: { label: "Open YouTube Analytics API", url: `${CONSOLE}/apis/library/youtubeanalytics.googleapis.com` },
          ifYouSee: [{ see: "a **Manage** button instead of Enable", do: "It is already on. Press I did this." }],
        },
        {
          id: "key-get-started",
          icon: "sparkle",
          title: "Start Google Auth Platform",
          say: [
            "Press **Get started**. App name: paste it. Support email: pick yours. Press **Next**.",
            "Audience: pick **External**. Press **Next**.",
            "Contact email: paste it. Press **Next**.",
            "Tick the User Data Policy box. Press **Continue**, then **Create**.",
          ],
          open: { label: "Open Google Auth Platform", url: `${CONSOLE}/auth/overview` },
          copy: [
            { label: "App name", value: { ref: "appName" } },
            { label: "Contact email", value: { ref: "ownerEmail" } },
          ],
        },
        {
          id: "key-branding",
          icon: "file",
          title: "Fill in Branding",
          say: [
            "Paste the three links into the three **App domain** boxes.",
            "Press **Add domain** twice. Paste one domain in each box.",
            "Developer contact: paste your email. Leave the logo empty.",
            "Press **Save**.",
          ],
          open: { label: "Open Branding", url: `${CONSOLE}/auth/branding` },
          copy: [
            { label: "Application home page", value: { ref: "websiteUrl" } },
            { label: "Privacy policy link", value: { ref: "privacyUrl" } },
            { label: "Terms of service link", value: { ref: "termsUrl" } },
            { label: "Domain 1", value: { ref: "appDomain" } },
            { label: "Domain 2", value: { ref: "hooksDomain" } },
            { label: "Developer contact", value: { ref: "ownerEmail" } },
          ],
          ifYouSee: [
            {
              see: "an error about a domain",
              do: "If Google will not take a domain, tell Clip Factory support. A custom domain fixes it.",
            },
          ],
        },
        {
          id: "key-scopes",
          icon: "key",
          title: "Add the 3 permissions",
          say: [
            "Press **Add or remove scopes**. Scroll down to **Manually add scopes**.",
            "Paste the 3 permissions below. Press **Add to table**.",
            "Press **Update**, then **Save**.",
          ],
          open: { label: "Open Data access", url: `${CONSOLE}/auth/scopes` },
          copy: [{ label: "Permissions (one per line)", value: { ref: "scopes" } }],
          ifYouSee: [{ see: "**Your sensitive scopes**", do: "That is normal. Keep going." }],
        },
        {
          id: "key-publish",
          icon: "globe",
          title: "Publish the app",
          say: [
            "Press **Publish app**, then confirm.",
            "It must say **In production**. In **Testing**, YouTube stops after 7 days.",
            "Do NOT press **Prepare for verification**.",
          ],
          open: { label: "Open Audience", url: `${CONSOLE}/auth/audience` },
          gate: "published_app",
        },
        {
          id: "key-client",
          icon: "key",
          title: "Make the key",
          say: [
            "Press **Create client**. Application type: **Web application**. Name: paste it.",
            "Under **Authorized redirect URIs** press **Add URI**. Paste the return address.",
            "Press **Create**.",
            "Copy BOTH values now, or press **Download JSON**. Google shows the secret only once.",
          ],
          open: { label: "Open Clients", url: `${CONSOLE}/auth/clients` },
          copy: [
            { label: "Name", value: { ref: "appName" } },
            { label: "Return address", value: { ref: "redirectUri" } },
          ],
        },
        {
          id: "key-paste",
          icon: "paste",
          title: "Paste the key here",
          say: [
            "Paste the **Client ID** and the **Client secret** below.",
            "Or drop the key file Google gave you here: both boxes fill in.",
            "Press **Save keys**.",
          ],
          paste: ["clientId", "clientSecret"],
          auto: "keys",
          ifYouSee: [
            {
              see: "that you lost the secret",
              do: "Open the client, press **Add secret**, use the new one, then **Disable** the old one.",
            },
          ],
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
          title: "Connect YouTube",
          say: [
            "Press **Connect YouTube**. Pick your account, then your channel.",
            "Google says it has not verified this app? Press **Advanced**, then **Go to … (unsafe)**.",
            "Tick every box (or **Select all**). Press **Continue**.",
          ],
          auto: "connected",
          ifYouSee: [
            { see: "a web address instead of the app name", do: "That is normal for your own app. Keep going." },
            {
              see: "**redirect_uri_mismatch**",
              do: "Wait 5 minutes and press Connect again. Still wrong? Redo the Make the key step with the Copy button.",
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
          id: "public-privacy",
          icon: "eye",
          title: "Pick who can see your clips",
          say: ["Pick who can see new clips on YouTube.", "You can change it any time."],
          extra: "youtube-privacy",
        },
        {
          id: "public-keep-alive",
          icon: "clock",
          title: "Post at least every 6 months",
          say: [
            "Google deletes keys that are not used for 6 months.",
            "It emails you 30 days before. Pressing Connect again keeps them alive.",
          ],
          optional: true,
        },
        {
          id: "public-quota",
          icon: "chart",
          title: "Only if you post over 100 a day",
          say: ["You do not need this to start.", "Posting more than 100 clips a day? Fill in Google's form."],
          open: { label: "Open Google's ask-for-more form", url: "https://support.google.com/youtube/contact/yt_api_form" },
          optional: true,
        },
      ],
    },
  ],
};
