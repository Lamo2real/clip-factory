# Clip Factory Cloud

Clip Factory Cloud turns long videos and streams into short, vertical clips that are ready to post. It is the cloud
version of the Clip Factory app that used to run on one Mac. Everything now runs on AWS, serverless, and you use it
from a browser, from your phone, or as an app on your computer (a `.dmg` for Mac, an `.exe` for Windows, or installed
from the browser). It is built so simply that a child could use it.

**Nothing is ever posted without your Confirm.**

## How it works

1. **Sign in.** One owner account (Amazon Cognito). You stay signed in for as long as you use the app at least once a month.
2. **Paste a link or upload a file.** A YouTube, Twitch or Kick link, or a video from your device.
3. **The agent gets to work in the cloud.** An agent on Amazon Bedrock AgentCore, running Claude Fable 5.1, downloads
   the audio, transcribes it with Amazon Transcribe and finds the most viral moments, guided by the skills you
   attach in Settings and by what worked on earlier posts.
   Every step appears on screen within a second or two, pushed over a WebSocket connection.
4. **It cuts 5 to 10 clips.** Each clip is 1080×1920 with a text hook, burned-in captions, a cover image, a pre-post
   checklist and a caption for each platform.
5. **You review.** Watch each clip, edit its captions, then press **Confirm** or **Decline**.
6. **Confirmed clips are posted, and checked 48 hours later.** A durable Lambda function handles each kept clip: it
   posts it (YouTube, Instagram, Facebook, TikTok and X arrive in phase 2; today clips wait as "waiting for the account
   connection"), waits 48 hours without running, reads the numbers, writes a short learning and remembers the clip in
   S3 Vectors, so the next jobs see "what worked before".
7. **Get the app.** **Get the app** in the sidebar (on a phone: in Settings) offers what fits your device: the Mac
   `.dmg`, the Windows `.exe`, the Android install button or the iPhone Add to Home Screen steps. Once the app is
   installed it stops asking.
8. **Always up to date.** After every update a bar at the bottom says what changed in a word or three
   (`Settings · Profile picture`). Press **Reload** and a quick, smooth progress bar brings in the new version.

## Architecture

Python for every backend, Terraform for every resource, and serverless only: CloudFront, S3 (web, media),
S3 Vectors, DynamoDB with Streams, three API Gateway APIs (HTTP for the app, WebSocket for live updates, REST for
platform webhooks), seven Lambdas (two of them durable functions), Amazon Bedrock AgentCore, Claude Fable 5.1 and
Titan embeddings on Bedrock, Transcribe, Cognito, SSM Parameter Store, CloudWatch and SNS. No servers, no containers to
run, no VPC. OpenSearch Serverless is drawn as an option, not deployed.

![Clip Factory Cloud on AWS](docs/architecture/aws-architecture.png)

The editable diagram is [docs/architecture/aws-architecture.drawio](docs/architecture/aws-architecture.drawio) (open
it in draw.io or at app.diagrams.net); [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) walks through every flow.

## Documentation

| Document | What it covers |
|---|---|
| [Business requirements](docs/BUSINESS_REQUIREMENTS.md) | Every requirement from the owner's brief, numbered, with acceptance criteria and open questions |
| [Contracts](docs/CONTRACTS.md) | The single source of truth: routes, data shapes, DynamoDB keys, S3 layout, names, outputs |
| [Architecture](docs/ARCHITECTURE.md) | AWS services and why, the durable job and clip flows, live updates, the learning memory, webhooks, sequence diagrams, failure handling, cost, limits |
| [Agent](docs/AGENT.md) | How the clip agent behaves: pipeline steps, tools, skills, prompts, the learnings loop |
| [UX design system](docs/UX_DESIGN_SYSTEM.md) | Colours, liquid glass, type, layout, navigation, sounds, motion, overflow rules, PWA, Get the app card, update bar and reload curve, kid-proof checklist |
| [Deployment](docs/DEPLOYMENT.md) | One-time AWS and GitHub setup (deploy role, Bedrock data retention, API Gateway logging role), what a deploy does, desktop downloads and their first open, release labels, first sign-in, rollback, tearing down |
| [Security](docs/SECURITY.md) | What is protected and how, token lifetimes, the owner's convenience-first stance |
| [Testing](docs/TESTING.md) | Every test suite, how to run it locally, what CI runs |
| [Decisions](docs/DECISIONS.md) | Why each major choice was made |
| [Roadmap](docs/ROADMAP.md) | Phase 2 social integrations and what comes after |
| [Git workflow](docs/GIT_WORKFLOW.md) | Feature branches, pull requests, automatic merge after green CI, branch clean-up, `Area:` lines for the update bar |

## Repository map

```
/                         GitHub Pages legal site (index.html, privacy.html, terms.html, style.css, .nojekyll) + this README
config/models.json        the only place model ids live
skills/<name>/SKILL.md    built-in skills (bundled into the agent and seeded for the owner)
docs/                     all documentation and the architecture diagram
web/                      the app: React 19 + Vite + TypeScript, installable PWA (web/areas.json: folder → update label)
desktop/                  the desktop app: a thin Tauri v2 window around the live web app (.dmg and .exe)
api/                      Python 3.13 Lambdas: HTTP API, durable job and clip flows, WebSocket (authorizer, connections,
                          broadcast), platform webhooks
agent/                    Python 3.13 AgentCore runtime (Claude Agent SDK, yt-dlp, ffmpeg) and its Dockerfile
infra/                    Terraform: envs/prod, modules (incl. flows, realtime, hooks, vectors) and bootstrap (deploy role)
scripts/                  deploy helpers (state bucket, image push, web config, release areas)
.github/workflows/        ci.yml (every push and pull request), deploy.yml (every push to main)
```

**The legal pages stay at the root on purpose.** GitHub Pages serves `index.html`, `privacy.html` and `terms.html`
from the root of this repository. The social platforms' developer programmes link to those exact URLs, so the files
must not move. The app itself is served by CloudFront, not by GitHub Pages.

## Run the web app locally

You need Node.js (the version in `web/`'s settings) and npm. No AWS account is needed: mock mode runs the whole app
on an in-memory fake API, with a fake signed-in owner and sample jobs and clips.

```bash
cd web
npm install
npm run dev:mock
```

Open <http://localhost:5173>. Details on the other test suites are in [docs/TESTING.md](docs/TESTING.md).

## How deploys happen

Every push to `main` deploys production through GitHub Actions ([deploy.yml](.github/workflows/deploy.yml)), using a
GitHub OIDC role, so no AWS keys are stored anywhere. Each deploy also writes `/version.json`, which makes open apps
show the update bar, and rebuilds the Mac and Windows downloads on GitHub's runners when the desktop app changed
([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#desktop-downloads)). Pushes that only change documentation do not deploy. Every push
and pull request runs [ci.yml](.github/workflows/ci.yml) first. Work happens on feature branches that merge to `main`
automatically once CI is green ([docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md)).

Before the first deploy the owner creates the OIDC deploy role (by hand or with `infra/bootstrap`), sets one variable
and one secret in GitHub, and opts the account in to Bedrock's `aws_review` data retention for Claude Fable 5.1. The
steps are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Status

| Phase | What | Status |
|---|---|---|
| 1 | Infrastructure (Terraform), CI/CD, Cognito sign-in, HTTP API, media uploads | Built; waits for the owner's OIDC role to deploy |
| 1 | AgentCore clip agent (download, transcribe, select, render, checklist, captions) | Built; waits for the first deploy |
| 1 | Web app: glass UI, phone tab bar, desktop sidebar, review, skills, settings, sounds, PWA | Built |
| 1 | Confirm and the durable clip flow (posts wait as "pending integration") | Built |
| 1 | 48-hour durable wait, learnings loop and S3 Vectors learning memory | Built; produces data once posting exists |
| 1 | Durable job flow with agent callback (replaces the watchdog) | Built |
| 1 | Live updates over the WebSocket API, polling as fallback | Built |
| 1 | REST API for platform webhooks and OAuth callbacks | Built; platforms connect in phase 2 |
| 1 | Get the app per device (Mac `.dmg`, Windows `.exe`, Android install, iPhone steps), hidden once installed | Added after the first build ([contracts §12](docs/CONTRACTS.md#12-get-the-app-updates-and-kid-proof-ux-added-by-the-owner-after-the-first-build)); downloads appear after the first deploy |
| 1 | Desktop app (Tauri v2) built on GitHub's macOS and Windows runners | Added after the first build; unsigned for now |
| 1 | Update bar with area labels and the smooth Reload | Added after the first build |
| 1 | Kid-proof screens (one next step, big buttons, Undo instead of "Are you sure?") | Added after the first build |
| 2 | Connect YouTube, Instagram, Facebook, TikTok, X and post confirmed clips | Planned ([roadmap](docs/ROADMAP.md)) |
| 2 | Real metrics for the 48-hour check | Planned |
| Later | Signed and notarized desktop builds | Planned ([roadmap](docs/ROADMAP.md#later)) |
