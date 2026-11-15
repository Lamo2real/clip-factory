# Security

## The owner's stance

The owner asked for convenience over strictness: "I don't care about security at all. Just make sure that I don't
have to log in every single day or every single week." So the app keeps sign-ins rare, has no multi-factor prompt,
and merges and deploys without a human approval step.

Convenience does not mean open. The app holds the owner's videos, unpublished clips, skills, YouTube cookies and,
in phase 2, the keys to the owner's social accounts. Everything below stays on because it costs the owner nothing
in daily use.

## Sign-in and tokens

| Setting | Value | What it means for the owner |
|---|---|---|
| Users | One, created by Terraform from `CF_OWNER_EMAIL`; sign-up is off | Nobody else can create an account. |
| Sign-in | The app's own screen, Secure Remote Password (SRP) through Amplify | The password is never sent in clear text, not even over HTTPS. |
| Access and ID tokens | 15 minutes | Refreshed silently in the background; the owner never notices. |
| Refresh token | 30 days, **rotated on every refresh**, 10-second grace period | Every refresh issues a new 30-day refresh token. Using the app at least once a month means never signing in again. After 30 days away, one sign-in. |
| Token revocation | On | Signing out revokes the refresh token. |
| User existence errors | Hidden | A wrong email and a wrong password give the same message. |
| MFA | Off | Owner's choice. Can be turned on later in Cognito without code changes. |

Tokens are stored by Amplify in the browser's local storage on each device. Signing out on one device does not sign
out others until their refresh token is used and found revoked.

## What is protected and how

| Asset | Protection |
|---|---|
| API | Every route except `/v1/health` needs a valid access token (API Gateway JWT authorizer: issuer, audience, expiry). The user id comes from the token's `sub`, never from the request body, so one user can never reach another's data. |
| Videos, clips, skills | Private S3 bucket, encryption at rest (SSE-S3), Block Public Access on. Browsers get presigned URLs that expire after 1 hour. |
| YouTube cookies | Stored at `private/<userId>/youtube-cookies.txt`. The API can replace or delete them but never returns them; only the agent reads them, for yt-dlp. |
| Web app | Private S3 bucket readable only by CloudFront (Origin Access Control). HTTPS only. |
| Database | DynamoDB encrypted at rest, point-in-time recovery for 35 days. |
| AWS access from CI | GitHub OIDC; the deploy role trusts only `main` of `Lamo2real/clip-factory-legal`. No stored AWS keys. |
| Runtime permissions | One IAM role per Lambda, one for the agent runtime and one for the scheduler. Each can reach only its own table, bucket, queue, schedules and model. The agent cannot publish, change IAM or touch infrastructure. |
| Owner email | A GitHub secret, so it is masked in the logs of this public repository. |
| Social account tokens (phase 2) | AWS Secrets Manager, never DynamoDB, never sent to the browser. |
| Publishing | Only after the owner presses Confirm on that clip. The agent has no permission to publish. |
| Desktop app | Opens only the app's own address; any other link opens in the normal browser. It holds no keys or secrets, and sign-in works exactly as in a browser. Built by GitHub Actions from this repository and served from the private web bucket over HTTPS. |

## CORS

The API allows only the app's CloudFront address and `http://localhost:5173` (local development). Media bucket CORS
allows `PUT` from the same origins for uploads.

## What is deliberately relaxed

- No MFA, long-lived sessions (30 days, rotating).
- Pull requests merge automatically when CI is green, and `main` deploys without approval. CI is the gate.
- The deploy role may use broad permissions, because only `main` of this repository can assume it.
- No AWS WAF in front of CloudFront or the API (cost, one user; the JWT authorizer rejects everything else for free).
- The desktop `.dmg` and `.exe` are not code-signed yet ([ADR-19](DECISIONS.md#adr-19-unsigned-desktop-builds-for-now)).
  Download them only from the app's own Get the app card, never from a copy someone sends you.

## If something goes wrong

- **Lost device**: in the Cognito console, open `cf-prod-users` → Users → your user and sign the user out globally
  (`AdminUserGlobalSignOut`), which revokes every refresh token. Then reset the password from the same page.
- **Leaked cookies file**: delete it in Settings (or `DELETE /v1/settings/cookies`) and sign out of YouTube in the
  browser it came from, which invalidates those cookies.
- **Suspicious deploy**: check the Actions run that produced it; revert on `main`.

## Reporting

This is a private tool for one owner. Report a problem through the
[GitHub issues page](https://github.com/Lamo2real/clip-factory-legal/issues).
