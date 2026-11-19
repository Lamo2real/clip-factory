## Research sources (checked on 16 Nov 2026)

Each step above was written from these official pages. Uncertain details are worded as "If you see…" in the app.

**YouTube and Google**
- [YouTube Data API: Videos: insert](https://developers.google.com/youtube/v3/docs/videos/insert)
- [Resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)
- [Using OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
  and [refresh token expiry](https://developers.google.com/identity/protocols/oauth2) (7 days in Testing, 6 months unused)
- [Get started with the Google Auth Platform](https://support.google.com/cloud/answer/15544987),
  [Manage OAuth app branding](https://support.google.com/cloud/answer/10311615),
  [Manage app audience](https://support.google.com/cloud/answer/15549945),
  [Manage OAuth clients](https://support.google.com/cloud/answer/15549257),
  [Unverified apps](https://support.google.com/cloud/answer/7454865)
- [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies) and
  [Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service) (privacy choice, policy
  wording, deleting data after revocation)
- [Quota and compliance audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)
- [Three-minute YouTube Shorts](https://support.google.com/youtube/answer/15424877)

**TikTok**
- [Register your app](https://developers.tiktok.com/doc/getting-started-create-an-app)
- [Add a Sandbox](https://developers.tiktok.com/doc/add-a-sandbox)
- [Login Kit for Web](https://developers.tiktok.com/doc/login-kit-web) and
  [token management](https://developers.tiktok.com/doc/oauth-user-access-token-management)
- [Content Posting API: Get started (Direct Post)](https://developers.tiktok.com/doc/content-posting-api-get-started),
  [Direct Post reference](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post),
  [Query creator info](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info),
  [Media transfer guide](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide)
- [Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines) (the Post to TikTok sheet)
- [App review guidelines](https://developers.tiktok.com/doc/app-review-guidelines)

**Meta (Instagram and Facebook)**
- [Register as a Meta developer](https://developers.facebook.com/docs/development/register) and
  [Create an app](https://developers.facebook.com/docs/development/create-an-app)
- [App modes](https://developers.facebook.com/docs/development/build-and-test/app-modes) (Development and Live)
- [Instagram API with Facebook Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login),
  [Content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing),
  [Resumable uploads](https://developers.facebook.com/docs/instagram-platform/content-publishing/resumable-uploads)
- [Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business)
- [Reels publishing for Pages](https://developers.facebook.com/docs/video-api/guides/reels-publishing)
- [Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog) (v27.0)

**X**
- [Getting access](https://docs.x.com/x-api/getting-started/getting-access) and
  [Developer Console](https://docs.x.com/resources/fundamentals/developer-portal)
- [Pricing and credits](https://docs.x.com/x-api/getting-started/pricing)
- [OAuth 2.0 authorization code with PKCE](https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code)
- [Chunked media upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked) and
  [Create a post](https://docs.x.com/x-api/posts/create-post)

### What changed on 19 Nov 2026

Checked again for Instagram, Facebook, YouTube and X (TikTok has its own check above). Ask, the in-app helper,
reads these same official pages when a step may be out of date (docs/CONTRACTS.md §28.3).

- **Instagram step 2**: new "If you see **Manage connection**" hints. On Facebook's phone app, a Page whose
  Instagram is already linked shows **Manage connection** after **Edit profile**; a Page that is not linked shows
  **Connect**. The Instagram app route (Edit profile › Page) is still right.
- **Instagram step 4** (business portfolio) is now only if Meta asks. Neither the Instagram Platform overview nor
  Content publishing requires a portfolio for a User access token on accounts you own
  ([overview](https://developers.facebook.com/documentation/instagram-platform/overview)). Content publishing also
  says a Page with a Business Manager role may need the ads permissions, so not using a portfolio is the simpler path
  ([content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing)).
- **Instagram step 12**: a Page that needs Page Publishing Authorization cannot be posted to until it is done
  (same content publishing page).
- **Facebook step 1**: posting Reels needs the Page's **Content** task, not full control; full control is only needed
  to link Instagram ([Reels publishing](https://developers.facebook.com/documentation/video-api/guides/reels-publishing)).
- **Facebook step 7**: pages_show_list and business_management are added by default; **step 9**: leave the
  Deauthorize and Data Deletion Request boxes empty; **step 13**: Meta now says **Publish**, then **Publish** at the
  bottom right ([Create an app for Pages](https://developers.facebook.com/documentation/pages-api/create-an-app)).
  Reels from apps are 3 to 90 seconds, 9:16, at least 540x960, 30 app posts a day per Page (Reels publishing).
- **YouTube**: no step changed ([Videos: insert](https://developers.google.com/youtube/v3/docs/videos/insert)).
- **X**: no step changed; the first auto-recharge is matched up to $50
  ([Pricing](https://docs.x.com/x-api/getting-started/pricing)).
