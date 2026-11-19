## What is deliberately relaxed

- No MFA, long-lived sessions (30 days, rotating).
- Pull requests merge automatically when CI is green, and `main` deploys without approval. CI is the gate.
- The deploy role may use broad permissions (`PowerUserAccess`), because only `main` of this repository can assume
  it. It still cannot make itself an administrator: IAM is limited to `cf-prod-*` roles that carry the
  `cf-prod-role-boundary` permissions boundary ([DEPLOYMENT.md](DEPLOYMENT.md) section 2), and the desktop build job,
  which runs npm and cargo, cannot ask for its OIDC token.
- No AWS WAF in front of CloudFront or the APIs (cost, one user; the JWT and WebSocket authorizers reject everything
  else, and the public REST API is throttled). A WAF web ACL can be attached to the REST API stage later.
- Webhook signatures are not verified yet; stored events trigger nothing.
- The owner's Google app is **published but not verified** ([ADR-33](DECISIONS.md#adr-33-posting-setup-bring-your-own-keys-with-a-guided-list-per-platform)):
  Google shows "Google hasn't verified this app" on Connect, which is expected for an app only its owner uses.
  Instagram's Meta app stays in Development mode. Neither widens who can use the app: only the owner's accounts
  can connect, and only the owner can sign in to Clip Factory.
- The desktop `.dmg` and `.exe` are not code-signed yet ([ADR-19](DECISIONS.md#adr-19-unsigned-desktop-builds-for-now)).
  Download them only from the app's own Get the app card, never from a copy someone sends you.
