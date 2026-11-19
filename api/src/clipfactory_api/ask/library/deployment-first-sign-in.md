## First sign-in

1. On the first deploy, Cognito emails `CF_OWNER_EMAIL` a temporary password (from `[hidden]`;
   check spam).
2. Open `app_url` (the `https://dxxxx.cloudfront.net` address from the run summary).
3. Sign in with your email and the temporary password, then choose your own password.
4. Install the app: press **Get the app** in the sidebar (on a phone: Settings › App & account › Get the app, or the banner on Home). It offers the
   `.dmg` on a Mac, the `.exe` on Windows, the install button on Android and the Add to Home Screen steps on iPhone.

The temporary password is valid for 7 days. If it expires, an AWS admin can reset it: Cognito console → user pool
`cf-prod-users` → Users → your email → Reset password.

You stay signed in as long as you open the app at least once every 30 days ([SECURITY.md](SECURITY.md)).
