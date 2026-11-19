## ADR-37 About, Privacy and Terms on the app's own domain

- **Context.** TikTok verifies the website by a file at a URL prefix, and Google lists every domain an OAuth app
  uses; both expect the privacy and terms pages on that domain. The GitHub Pages legal site (ADR-09) is on another
  domain and must not change.
- **Decision.** The web app serves static `about.html`, `legal/privacy.html` (with a `#delete` section) and
  `legal/terms.html` from CloudFront, with the YouTube API Services wording. TikTok's verification file is uploaded in
  the setup and written to the web bucket root; `upload-web.sh` never deletes `tiktok*.txt`.
- **Alternatives.** *Point the platforms at GitHub Pages* (a second domain to verify, and TikTok's file cannot be
  placed there from the app). *A custom domain* (on the roadmap; needs DNS and a certificate).
- **Consequences.** Every value the platforms ask for comes from `GET /v1/setup` and is one Copy button. If the app
  moves to a custom domain, every platform's redirect URI and website must be updated (the setup's **Check it** finds
  a mismatch).
