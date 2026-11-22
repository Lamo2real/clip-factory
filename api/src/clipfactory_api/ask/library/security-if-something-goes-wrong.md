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
- **The help assistant says something wrong or unwanted**: set the kill switch (`HELP` / `SWITCH`, `enabled: false`, or
  `model: false` to keep answers from search only) with the command in
  [DEPLOYMENT.md](DEPLOYMENT.md#ask-clip-factory-kill-switch); it takes effect within 60 seconds, no deploy needed.
- **A live connection you do not recognise**: sign out globally (above). Existing connections close within 2 hours at
  the latest, and no new one opens without a valid token.
