## If something goes wrong

- **Lost device**: in the Cognito console, open `cf-prod-users` → Users → your user and sign the user out globally
  (`AdminUserGlobalSignOut`), which revokes every refresh token. Then reset the password from the same page.
- **Leaked cookies file**: delete it in Settings (or `DELETE /v1/settings/cookies`) and sign out of YouTube in the
  browser it came from, which invalidates those cookies.
- **Suspicious deploy**: check the Actions run that produced it; revert on `main`.
- **Leaked webhook verify token**: change the parameter's value version in Terraform (`value_wo_version`) and deploy;
  then paste the new value into the platform console.
- **A leaked platform key** (Client secret or App secret): make a new secret on the platform (Google **Add secret**
  then **Disable** the old one; TikTok, Meta and X **Reset** or **Regenerate**), paste it in Settings › Posting › Set up
  posting › {Platform} › **Save keys**, then **Connect again**. To cut a platform off at once, press **Disconnect**
  (it revokes the token where the platform allows it and deletes the token secret) or remove the app's access on the
  platform (for Google: <https://myaccount.google.com/permissions>).
- **Content Rewards: an unknown sign-in or a lost Mac**: press **Disconnect** in Settings › Posting › Set up posting ›
  Content Rewards (it revokes the refresh token and deletes the token secret), then on Content Rewards open Settings ›
  **Connected apps** and press **Disconnect** next to Clip Factory. Nothing on any platform is deleted. Connect again
  on the Mac when you want it back.
- **Content Rewards or Whop asks Clip Factory to stop reading its pages**: set `cr_finder_enabled` back to `false` in
  `infra/envs/prod` the same day, in a one-line pull request, and let `deploy.yml` apply it (never a local AWS CLI);
  every finder route then answers 503 and no look starts ([DEPLOYMENT.md](DEPLOYMENT.md#campaign-finder-contracts-41)).
- **Your bank: a lost device, or a bank link you don't recognise**: sign out globally (above), then on Settings ›
  Posting › Get paid › Your bank tap "Stop reading Swedbank" on each bank, or "Forget my bank" to remove every
  payment and link Clip Factory kept. To cut it off at the source too, delete the app on Enable Banking's **API
  applications** page; the bank's own app or website can also end the link.
- **Your bank: the bank key may have leaked** (a .pem file left in Downloads, say): stop reading every bank, make a new
  bank key (no button yet: `POST /v1/getpaid/bank/key` with `{"again": true}`; it keeps `hashKey`, so stored payments
  keep their ids), do steps 3 to 6 for a new Enable Banking app (a restricted app reads only accounts linked to it),
  delete the old app on **API applications**, then "Connect your bank" again.
- **Enable Banking says Clip Factory's use isn't personal use, or sends notice that the app will be deactivated**:
  first the owner taps "Stop reading Swedbank" on each bank while Your bank is still on: Enable Banking closes each
  link, no daily read touches it again, and the money found stays (his records). Only if he also wants Clip
  Factory's records gone does he tap "Forget my bank". Then set `bank_reading_enabled` back to `false` in
  `infra/envs/prod` the same day, in a one-line pull request, and let `deploy.yml` apply it (never a local AWS CLI).
  Every bank route then answers 503, `cf-prod-money` reads no bank, and every screen says "Clip Factory can't see
  your bank. Look in your bank's app to see what arrived." again. If the switch has to go off first, nothing is read
  any more, but each link stays open at Enable Banking ("Stop reading" answers 503 while the switch is off) until it
  ends (90 to 180 days) or he ends it in his bank's app or on Enable Banking.
- **The help assistant says something wrong or unwanted**: set the kill switch (`HELP` / `SWITCH`, `enabled: false`, or
  `model: false` to keep answers from search only) with the command in
  [DEPLOYMENT.md](DEPLOYMENT.md#ask-clip-factory-kill-switch); it takes effect within 60 seconds, no deploy needed.
- **A live connection you do not recognise**: sign out globally (above). Existing connections close within 2 hours at
  the latest, and no new one opens without a valid token.
