## How every setup works

Every platform page has the same four parts:

1. **Get ready**: what your account needs before you start.
2. **Make your {Platform} key**: a few clicks on the platform's developer website. You do this once.
3. **Connect**: one big button. You say yes on the platform and come back to Clip Factory.
4. **Go public**: what the platform still has to allow, and how it is going.

Each step is a big numbered card. The numbers run on from one part to the next. A card has only what that step needs:

| On the card | What it does |
|---|---|
| **Open {site}** | Opens the right page of the platform in a new tab. Come back to the Clip Factory tab after. |
| **Copy** | Copies a value (a name, a web address). You see **Copied!**. Then paste it on the platform. |
| A paste box with **Paste** | Where you put a key from the platform. The box checks it while you type and says what is wrong. |
| An upload box | Only on TikTok: where you drop the file TikTok gives you. |
| **If you see…** | What to do when the platform looks a little different. |
| **I did this** | Press it when you finished the step. The next step opens. |

Some steps tick themselves (for example when your keys are saved or when you are connected). Steps marked **(only if
you need it)** are extra and do not count in the ring.

There is always **one** vermilion-red button on the screen: it is the next thing to press.

**Use a computer.** The developer websites work best on a computer. Use the same browser for every step, and keep
Clip Factory open in one tab and the platform in another.

### The values Clip Factory gives you

You never type these. Every step that needs one has a **Copy** button. They are listed here so a grown-up can check
them. `{app}` is your Clip Factory address and `{hooks}` is its sign-in return address; the app fills in the real ones.

| Name on the card | What it is |
|---|---|
| App name | `Clip Factory` (Facebook: `Clip Factory Pages`) |
| Description | "Clip Factory turns my gameplay recordings into short vertical clips and posts them to my own accounts when I press Keep." |
| Website | `{app}/about.html` |
| Website prefix (TikTok) | `{app}/` |
| Privacy Policy | `{app}/legal/privacy.html` |
| Terms of Service | `{app}/legal/terms.html` |
| Data deletion instructions | `{app}/legal/privacy.html#delete` |
| App domain | the host of `{app}`, for example `dxxxx.cloudfront.net` |
| Return address domain | the host of `{hooks}`, for example `xxxx.execute-api.eu-north-1.amazonaws.com` |
| Redirect URI (return address) | `{hooks}/oauth/{platform}/callback`, for example `…/oauth/youtube/callback`. Exact, no slash at the end. |
| Permissions (scopes) | the list for that platform (YouTube: 3 lines) |
| Your email | the email you sign in to Clip Factory with |
| X use case | "Post my own short video clips to my own X account and read their view and like counts in my personal Clip Factory app." |
| TikTok review text | See [step 21 of TikTok](#21-ask-tiktok-to-check-the-app). |

The About, Privacy and Terms pages live on your Clip Factory address on purpose: TikTok checks that the website is
yours, and Google lists every web address your app uses.

---
