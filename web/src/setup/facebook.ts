// Facebook setup (docs/CONTRACTS.md §17.2): Page Reels with Facebook Login for Business, Graph API v27.0, checked
// against Meta for Developers on 19 Nov 2026. Its own Meta app ("Clip Factory Pages"), separate from Instagram's.
import { CHECKED_ON, type SetupGuide } from "./types.ts";

export const facebook: SetupGuide = {
  platform: "facebook",
  name: "Facebook",
  checkedOn: CHECKED_ON,
  minutes: 25,
  cost: "Free",
  keyWords: "App ID, App secret and Configuration ID",
  fix: { keys: "key-paste", redirect: "key-redirect", account: ["ready-page"] },
  parts: [
    {
      id: "ready",
      title: "Get ready",
      steps: [
        {
          id: "ready-page",
          icon: "users",
          title: "Have a Facebook Page",
          say: [
            "Open your Pages. None yet? Press **Create new Page**.",
            "Profiles cannot post Reels through apps. You need a Page.",
            "You need **Content** or **Full control** access on the Page.",
            "Then tap your picture and switch back to your own profile. Do not change Page settings.",
          ],
          open: { label: "Open your Pages", url: "https://www.facebook.com/pages/?category=your_pages" },
          ifYouSee: [
            {
              see: "your Page in a business portfolio",
              do: "Keep your own access too: Page **Settings** › **Page access**. Your account needs **Full control**.",
            },
            {
              see: "**Manage connection** after **Edit profile** on your Page",
              do: "If it shows your Instagram name, it is linked. Close it. Never press **Disconnect**. Press I did this.",
            },
            {
              see: "**People who help manage your Page**",
              do: "Leave those choices as they are. They only matter if other people help run your Page.",
            },
          ],
        },
        {
          id: "ready-computer",
          icon: "monitor",
          title: "Use a computer",
          say: ["The developer websites work best on a computer.", "Use the same browser for every step."],
        },
      ],
    },
    {
      id: "key",
      title: "Make your Facebook key",
      steps: [
        {
          id: "key-developer",
          icon: "user",
          title: "Turn on Meta for developers",
          say: [
            "Press **Log in** or **Get Started**. Accept.",
            "Check your phone or email with the code Meta sends.",
            "Already done in the Instagram setup? Just press I did this.",
          ],
          open: { label: "Open Meta for Developers", url: "https://developers.facebook.com/" },
        },
        {
          id: "key-app",
          icon: "plus",
          title: "Create the app",
          say: [
            "App name: paste it. Never put Facebook, Meta or Instagram in the name.",
            "Add your email. Press **Next**.",
          ],
          open: { label: "Open Create an app", url: "https://developers.facebook.com/apps/creation/" },
          copy: [{ label: "App name", value: { ref: "appName" } }],
        },
        {
          id: "key-use-case",
          icon: "check",
          title: "Pick one use case",
          say: [
            "Tick only **Manage everything on your Page**.",
            "Do not tick the Instagram one or **Authenticate and request data from users with Facebook Login**.",
            "Use cases cannot be removed later. Press **Next**.",
          ],
        },
        {
          id: "key-finish-app",
          icon: "folder",
          title: "Finish the app",
          say: [
            "Business: pick your portfolio, or **I don't want to connect a business portfolio yet**.",
            "Press **Next**, **Next**, then **Go to dashboard**.",
          ],
        },
        {
          id: "key-permissions",
          icon: "key",
          title: "Turn on Page permissions",
          say: [
            "On the **Dashboard**, press **Customize the Manage everything on your Page use case**.",
            "Press **Add** next to pages_read_engagement, pages_manage_posts, read_insights and pages_manage_engagement.",
            "pages_show_list and business_management are already there. Press **Ready to test**.",
          ],
        },
        {
          id: "key-basic",
          icon: "file",
          title: "Fill in Basic settings",
          say: [
            "Open **App settings**, then **Basic**. Paste the App domain, Privacy, Terms and **Data deletion instructions URL**.",
            "Pick a **Category**. Upload the icon below as the **App icon**.",
            "In the EU: **Data Protection Officer** is your name and email.",
            "Press **+ Add platform**, then **Website**. Paste the **Site URL**. Press **Save changes**.",
          ],
          download: { label: "Download the icon", href: "/brand/clip-factory-1024.png" },
          copy: [
            { label: "App domains", value: { ref: "appDomain" } },
            { label: "Privacy Policy URL", value: { ref: "privacyUrl" } },
            { label: "Terms of Service URL", value: { ref: "termsUrl" } },
            { label: "Data deletion instructions URL", value: { ref: "dataDeletionUrl" } },
            { label: "Site URL", value: { ref: "websiteUrl" } },
          ],
        },
        {
          id: "key-redirect",
          icon: "link",
          title: "Paste the return address",
          say: [
            "Open **Facebook Login for Business**, then **Settings**.",
            "Set **Client OAuth login**, **Web OAuth login** and **Enforce HTTPS** to Yes. Turn Strict Mode on.",
            "Paste the address into **Valid OAuth Redirect URIs**. Press **Check URI**.",
            "Press **Save changes**.",
          ],
          copy: [{ label: "Valid OAuth Redirect URI", value: { ref: "redirectUri" } }],
          ifYouSee: [
            {
              see: "no Facebook Login for Business in the menu",
              do: "Look under **Use cases** › **Customize**, or **Add product**.",
            },
            {
              see: "**Deauthorize Callback URL** or **Data Deletion Request URL** boxes",
              do: "Leave them empty.",
            },
          ],
        },
        {
          id: "key-config",
          icon: "settings",
          title: "Make a login configuration",
          say: [
            "Open **Facebook Login for Business**, then **Configurations**. Press **+ Create configuration** (not a template).",
            "Name: paste it. If asked, pick **General**. Token: **User access token**, the longest expiry.",
            "Assets: **Pages**. Tick the 6 permissions below.",
            "Press **Create**.",
          ],
          copy: [
            { label: "Name", value: { ref: "appName" } },
            { label: "Permissions", value: { ref: "scopes" } },
          ],
        },
        {
          id: "key-paste",
          icon: "paste",
          title: "Paste the 3 values",
          say: [
            "Paste the **App ID** and the **App secret** from **App settings** › **Basic**.",
            "Paste the **Configuration ID** from **Configurations**.",
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
          title: "Connect Facebook",
          say: [
            "Press **Connect Facebook**, then **Continue**.",
            "Tick your clip Page. Leave every switch ON. One off and Facebook gives nothing.",
            "Press **Save**, then **Got it**.",
            "Several Pages? You pick one in Clip Factory next.",
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
          id: "public-live",
          icon: "globe",
          title: "Make the app Live",
          say: [
            "In the left menu, press **Publish**. Check the list. Press **Go live** at the bottom right.",
            "No **Publish** in the menu? Flip the **App Mode** switch to **Live**.",
            "Meta says info is missing? Go back to Fill in Basic settings.",
            "Press I did this when the top bar says **Live**.",
          ],
          gate: "app_live",
          ifYouSee: [
            {
              see: "**App Review** or **Advanced access**",
              do: "You do not need it for your own Page. Skip it. Press **Go live**. Meta still says no? It lists what is missing. Go back to Fill in Basic settings.",
            },
          ],
        },
      ],
    },
  ],
};
