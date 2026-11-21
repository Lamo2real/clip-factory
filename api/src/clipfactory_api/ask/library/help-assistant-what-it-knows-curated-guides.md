## What it knows (curated guides)

| Topic | Guides (ids in `helpKb.json`) | Button |
|---|---|---|
| About the app | `what-is-clip-factory` | Go to Home, lights up the link box |
| Making clips | `make-clips-link`, `make-clips-upload` | Go to Home, lights up **Paste**, **Make clips** or the upload box |
| Jobs | `job-progress`, `job-failed`, `jobs-running` | Open Jobs; `job-failed` lights up the failed row in the Jobs list (`failed-job`) and **Try again** |
| Review | `review-keep`, `review-upload-to`, `review-throw-away`, `review-captions`, `review-waiting`, `clip-posting-failed` | Open Review, lights up **Upload**, **Throw away** or the captions |
| Library | `library-where` ("where are my clips / videos") | Open Library, lights up Library in the navigation |
| Clip numbers | `clip-performance`, `refresh-numbers`, `this-week-best`, `best-clip-week-views` | Open Library or This week, lights up the **Best this week** star |
| Posting | `posting-setup-{youtube,instagram,facebook,tiktok,x}`, `tiktok-private`, `where-clips-go`, `x-costs` ("What X charges for numbers"), `accounts-connected` | Open Set up posting `/settings/posting/setup` (lights up the platform's card `setup-{platform}`), that platform's steps `/settings/posting/setup/{platform}`, X setup (lights up **What X costs**), or Where clips go; `tiktok-private` opens Library |
| Get paid ([CONTRACTS §40](CONTRACTS.md#40-get-paid-set-up-payouts-see-if-you-can-get-paid-and-what-reached-your-bank-owner-request-2026-11-21)) | `getpaid-setup` ("How do I set up getting paid?"), `getpaid-status` ("What does Can get paid mean?"), `getpaid-sent` ("How much was sent to my bank?"), `getpaid-youtube`, `getpaid-tiktok-sweden`, `getpaid-x-clips`, `getpaid-whop`, and `money-payouts` ("Where do I add my bank account to get paid?") | Open Get paid (lights up the list, `getpaid-list`), a place's page (`getpaid-place`, its status `getpaid-status`, its payments `getpaid-sent`, the Whop card `getpaid-whop`), or Money's Get paid card (`getpaid-card`). Before the Get paid screens are on main the guides open Settings › Posting › Money (or Money) and light nothing up |
| Clip making settings | `skills-add`, `skills-write`, `skills-edit`, `skills-delete`, `skills-what`, `clip-count`, `youtube-cookies` | Open Skills, Clips or YouTube help |
| Look and feel | `sounds-click`, `sounds-error`, `sounds-off`, `motion-and-background` | Open Sounds, Motion or Background |
| App | `get-app-desktop` (Mac and Windows), `get-app-browser` (Linux, ChromeOS and unknown desktops: install from the browser), `get-app-iphone`, `get-app-android`, `updates`, `sign-out` | Get the app, Open Updates, Open Account |

Every Settings tree, branch and setting also gets a generated doc, so "where do I change the background?" works
without a guide. Guides marked `"extends": "§17"` (the five `posting-setup-*` ones) point at Settings › Posting ›
Set up posting and the platform's own steps page. A setting that lives on a platform's setup page (an apple with an
`href`, such as **What X costs**) becomes a doc on that page.

Guides with a `when` filter are shown only where they fit: the Mac and Windows download only on desktops that have not
installed the app, the install-from-the-browser steps on other desktops, the iPhone steps only on iOS, the Android steps only on Android. There are no roles or plans: there
is one owner, and everything else is visible.
