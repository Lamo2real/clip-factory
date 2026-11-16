// X setup (docs/CONTRACTS.md §17.2), checked against the X Developer Console on 16 Nov 2026. Posting on X costs
// money (pay per use), so this guide asks for a grown-up and a card first.
import { CHECKED_ON, type SetupGuide } from "./types.ts";

export const x: SetupGuide = {
  platform: "x",
  name: "X",
  checkedOn: CHECKED_ON,
  minutes: 15,
  cost: "Costs a little: about $1.50 for 100 clips",
  keyWords: "Client ID and Client Secret",
  fix: { keys: "key-paste", redirect: "key-addresses", account: ["ready-account"] },
  parts: [
    {
      id: "ready",
      title: "Get ready",
      steps: [
        {
          id: "ready-account",
          icon: "user",
          title: "Use the X account your clips go on",
          say: [
            "Its email must be confirmed. X may ask for a phone number.",
            "It must not be protected, or only followers see your clips.",
          ],
        },
        {
          id: "ready-computer",
          icon: "monitor",
          title: "Use a computer",
          say: ["The developer websites work best on a computer.", "Use the same browser for every step."],
        },
        {
          id: "ready-card",
          icon: "card",
          title: "Ask a grown-up for a card",
          say: [
            "X charges a little for every post: about 1.5 cents.",
            "Ask a grown-up to help with a normal credit or debit card.",
            "Prepaid cards get no bonus.",
          ],
          extra: "x-cost",
        },
      ],
    },
    {
      id: "key",
      title: "Make your X key",
      steps: [
        {
          id: "key-console",
          icon: "globe",
          title: "Sign in to the X Developer Console",
          say: [
            "Open the X Developer Console with the same X account.",
            "Accept the **Developer Agreement and Policy**.",
            "In the use-case box, paste the text below.",
          ],
          open: { label: "Open the X Developer Console", url: "https://console.x.com/" },
          copy: [{ label: "Use case", value: { ref: "xUseCase" } }],
        },
        {
          id: "key-credits",
          icon: "card",
          title: "Buy a few credits",
          say: [
            "Open **Billing**, then **Credits**. Save the card with your grown-up.",
            "Buy the smallest amount. Set a spending limit of $10.",
            "Leave auto-recharge OFF.",
            "X may add $20 free after the first purchase.",
          ],
        },
        {
          id: "key-app",
          icon: "plus",
          title: "Create the app",
          say: [
            "Open **Apps**. Press **Create App** (or **New App**).",
            "Name: paste it (taken? add your name). Description: paste it. Press **Create**.",
            "Clip Factory does NOT need the API Key, API Secret, Bearer Token or Access Token.",
            "Press **Close**.",
          ],
          copy: [
            { label: "App name", value: { ref: "appName" } },
            { label: "Description", value: { ref: "xUseCase" } },
          ],
          ifYouSee: [
            {
              see: "a **Client ID** and **Client Secret** in the box",
              do: "Paste them now in the Paste step below, then press Close.",
            },
          ],
        },
        {
          id: "key-auth-settings",
          icon: "settings",
          title: "Open the sign-in settings",
          say: [
            "Open your app, then **Keys & Tokens**.",
            "Next to **User authentication settings**, press **Set up** (or **Edit**).",
          ],
        },
        {
          id: "key-permissions",
          icon: "key",
          title: "Pick Read and write",
          say: ["App permissions: **Read and write**.", "Type of App: **Web App, Automated App or Bot**."],
        },
        {
          id: "key-addresses",
          icon: "link",
          title: "Paste the addresses",
          say: [
            "Paste the **Callback URI / Redirect URL** and the **Website URL**.",
            "If X asks, paste the Terms and Privacy links too.",
            "Press **Save Changes**.",
          ],
          copy: [
            { label: "Callback URI / Redirect URL", value: { ref: "redirectUri" } },
            { label: "Website URL", value: { ref: "websiteUrl" } },
            { label: "Terms of service", value: { ref: "termsUrl" } },
            { label: "Privacy policy", value: { ref: "privacyUrl" } },
          ],
        },
        {
          id: "key-paste",
          icon: "paste",
          title: "Paste Client ID and Secret",
          say: [
            "Copy the **Client ID** and the **Client Secret**. X shows them only once.",
            "Paste them below. Press **Save keys**, then **Close** on X.",
          ],
          paste: ["clientId", "clientSecret"],
          auto: "keys",
          ifYouSee: [{ see: "that you lost them", do: "Open **Keys & Tokens** and press **Regenerate**." }],
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
          title: "Connect X",
          say: ["Press **Connect X**.", "Check it is the right account. Press **Authorize** (it may say **Authorize app**)."],
          auto: "connected",
          ifYouSee: [
            { see: "**Callback URL not approved**", do: "Redo the Paste the addresses step with the Copy button." },
          ],
        },
      ],
    },
    {
      id: "public",
      title: "Go public",
      steps: [
        {
          id: "public-credits",
          icon: "card",
          title: "Keep a few credits",
          say: [
            "Each post uses a few credits. Clip Factory stops at $10 a month.",
            "Clip Factory never puts links in X posts (a link costs $0.20).",
          ],
          gate: "credits",
        },
      ],
    },
  ],
};
