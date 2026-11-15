# Deployment

Production deploys from GitHub Actions on every push to `main`, through an IAM role that GitHub assumes with OIDC.
There are no AWS access keys anywhere. This page covers the one-time setup, what a deploy does, the first sign-in,
rolling back and tearing everything down.

| Setting | Where | Required | Value |
|---|---|---|---|
| `CF_DEPLOY_ROLE_ARN` | GitHub → Settings → Secrets and variables → Actions → **Variables** | yes | ARN of the deploy role below |
| `CF_OWNER_EMAIL` | same page → **Secrets** | yes | The owner's email: the only login. A secret so it is masked in the logs of this public repository. |
| `CF_REGION` | Variables | no | Default `eu-north-1` |
| `CF_STATE_BUCKET` | Variables | no | Default `lamo-labs-state-bucket` (state key `clip-factory/prod/terraform.tfstate`) |

## One-time setup

### 1. GitHub OIDC identity provider (once per AWS account)

Skip this if the account already has `token.actions.githubusercontent.com` under IAM → Identity providers.

IAM console → Identity providers → Add provider → OpenID Connect:
- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

Or with the AWS CLI, signed in to the target account:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

### 2. The deploy role

Create a role named, for example, `cf-github-deploy` with this trust policy. Replace `<ACCOUNT_ID>`. Only workflows
running on `main` of `Lamo2real/clip-factory-legal` can assume it; pull requests and other branches cannot.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GitHubClipFactoryMainOnly",
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:Lamo2real/clip-factory-legal:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

If the deploy job uses a GitHub environment, GitHub sends `repo:Lamo2real/clip-factory-legal:environment:<name>`
as the subject instead; add that string to the `sub` list as well. If the organisation has customised its OIDC subject
format, the failing step's error ("Not authorized to perform sts:AssumeRoleWithWebIdentity") means the `sub` above
does not match; compare it with the format in the organisation's settings.

**Permissions.** The role creates and updates everything in [ARCHITECTURE.md](ARCHITECTURE.md). The simplest choice,
in line with the owner's convenience-first stance, is the AWS managed policy `AdministratorAccess`, since only `main`
of this repository can assume the role. A narrower policy that still works:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ServicesClipFactoryUses",
      "Effect": "Allow",
      "Action": [
        "s3:*", "cloudfront:*", "cognito-idp:*", "apigateway:*", "lambda:*", "dynamodb:*", "sqs:*",
        "scheduler:*", "events:*", "bedrock-agentcore:*", "bedrock:Get*", "bedrock:List*",
        "ecr:*", "logs:*", "cloudwatch:*", "sns:*", "acm:Describe*", "acm:List*",
        "sts:GetCallerIdentity", "tag:GetResources"
      ],
      "Resource": "*"
    },
    {
      "Sid": "OwnRolesOnly",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:TagRole", "iam:UntagRole",
        "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy",
        "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:ListInstanceProfilesForRole", "iam:PassRole",
        "iam:CreateServiceLinkedRole"
      ],
      "Resource": [
        "arn:aws:iam::<ACCOUNT_ID>:role/cf-prod-*",
        "arn:aws:iam::<ACCOUNT_ID>:role/aws-service-role/*"
      ]
    }
  ]
}
```

What each group is for: S3 (web, media and state buckets), CloudFront (distribution, Origin Access Control,
invalidations), Cognito (user pool, client, the owner), API Gateway (HTTP API), Lambda, DynamoDB, SQS, EventBridge
Scheduler and rules, AgentCore (runtime), Bedrock (read model and profile details), ECR (repository, image push),
CloudWatch Logs and alarms, SNS (alarm topic), IAM (the `cf-prod-*` roles the functions and runtime use).

Copy the role's ARN.

### 3. GitHub settings

In `Lamo2real/clip-factory-legal` → Settings → Secrets and variables → Actions:
1. Variables → New repository variable: `CF_DEPLOY_ROLE_ARN` = the role ARN.
2. Secrets → New repository secret: `CF_OWNER_EMAIL` = your email.
3. Optional: `CF_REGION`, `CF_STATE_BUCKET`.

Until `CF_DEPLOY_ROLE_ARN` and `CF_OWNER_EMAIL` are set, the deploy workflow stops at its first step and says which
one is missing. CI keeps running on every push.

### 4. Bedrock model access

Anthropic models on Bedrock need a one-time use-case form per AWS account. Open the Bedrock console in `eu-north-1`
→ Model access (or Model catalog), find Claude Fable 5.1 and submit the form if asked. Without it the agent's first
model call fails with an access error.

## What a deploy does

Triggered by a push to `main` ([deploy.yml](../.github/workflows/deploy.yml)) or by hand (Actions → deploy → Run workflow).

1. **Test and build** in parallel: web tests and the production build; Python lint, types and tests; the Lambda
   package `api/dist/lambda.zip`.
2. **Assume the role** through OIDC.
3. **State bucket**: [scripts/ensure-state-bucket.sh](../scripts/ensure-state-bucket.sh) creates the Terraform state
   bucket if it does not exist (versioned, encrypted, private).
4. **Agent image**: [scripts/push-image.sh](../scripts/push-image.sh) builds the ARM64 image and pushes it to ECR,
   tagged with a hash of the agent's sources, so unchanged code is not rebuilt.
5. **Terraform** `init` (S3 backend with lockfile), `plan`, then `apply` of exactly that plan. No manual approval
   (the owner's choice).
6. **Web**: [scripts/write-web-config.sh](../scripts/write-web-config.sh) writes `config.json` from the Terraform
   outputs; the build is synced to the web bucket and CloudFront is invalidated.
7. **What's new**: `scripts/release-areas.sh <prev-sha> <new-sha>` turns the commits since the live version into up to
   three area labels ([how to write them](GIT_WORKFLOW.md#area-lines-what-the-update-bar-says)), and the deploy writes
   `/version.json` last, never cached. Open apps show the update bar within 5 minutes
   ([ARCHITECTURE.md flow 8](ARCHITECTURE.md#8-updates-versionjson-release-areas-and-the-update-bar)).
8. **Smoke test**: `GET /v1/health` must answer `{ "ok": true }`.
9. **Desktop app** (job `desktop`, only when needed): see [Desktop downloads](#desktop-downloads).

The run summary shows `app_url`. The first deploy into an empty account takes about 15–20 minutes (CloudFront and
the AgentCore runtime are the slow parts); later deploys take a few minutes. A deploy that rebuilds the desktop app
adds about 10–15 minutes on the macOS and Windows runners, in parallel, after the web is already live.

## Desktop downloads

The Mac `.dmg` and Windows `.exe` offered by **Get the app** are built by the `desktop` job in
[deploy.yml](../.github/workflows/deploy.yml) ([CONTRACTS.md §12.3](CONTRACTS.md#123-desktop-wrapper-desktop-tauri-v2),
[ARCHITECTURE.md flow 9](ARCHITECTURE.md#9-get-the-app-and-the-desktop-wrapper)).

| | Mac | Windows |
|---|---|---|
| Runner | `macos-latest` | `windows-latest` |
| Build | Tauri v2, target `universal-apple-darwin` (Apple silicon and Intel in one file) | Tauri v2, NSIS installer (installs for the current user, no admin prompt; fetches WebView2 if the PC lacks it) |
| File in the web bucket | `downloads/Clip-Factory.dmg` | `downloads/Clip-Factory-Setup.exe` |
| Signed | No (see below) | No (see below) |

**When it runs.** After the web deploy, only if one of these is true; otherwise the job is skipped in seconds:
- something under `desktop/` changed,
- the app icon changed,
- a download is missing from `downloads/` in the web bucket (for example the first deploy).

The app address is read from the Terraform output `app_url` and built into the app. The same deploy role (OIDC) uploads
the files, then rewrites `downloads/manifest.json`
(`{ "version", "files": { "mac": { "path", "size" }, "windows": { "path", "size" } } }`) with no caching and
invalidates `/downloads/*` in CloudFront, so nobody gets an old file under the same name.

**Forcing a rebuild** (for example after a custom domain changes `app_url`): delete the two files from `downloads/` in the
web bucket, then run the deploy by hand (Actions → deploy → Run workflow). Until it finishes, Get the app offers the
browser install, never a broken link.

**If the desktop job fails**, the web app is already live; the previous downloads and manifest stay. Fix and push again.

### Unsigned builds and the first open

There are no Apple or Microsoft code-signing certificates yet ([ADR-19](DECISIONS.md#adr-19-unsigned-desktop-builds-for-now)),
so both systems warn once. The Get the app card shows the hint; these are the full steps:

| System | What you see | What to do (only the first time) |
|---|---|---|
| macOS 14 and earlier | "Clip Factory can't be opened because Apple cannot check it for malicious software." | Drag the app to Applications, then right-click (or Control-click) it → **Open** → **Open**. |
| macOS 15 and later | "Apple could not verify Clip Factory is free of malware." | Press **Done**. Open **System Settings → Privacy & Security**, scroll down, press **Open Anyway** next to Clip Factory, confirm with your password. |
| Windows 10 and 11 | "Windows protected your PC" (SmartScreen) | Press **More info** → **Run anyway**. Some browsers also ask to **Keep** the download first. |

After the first open the app starts normally. Signing and notarization are on the [roadmap](ROADMAP.md#later).

### Release labels ("Area:" lines)

The update bar says in a word or three what changed, for example `Settings · Profile picture`. Those words come from
lines like this at the end of a commit message:

```
feat: let the owner pick a profile picture

Area: Settings
Area: Profile picture
```

Rules, examples and the squash-merge detail are in [GIT_WORKFLOW.md](GIT_WORKFLOW.md#area-lines-what-the-update-bar-says).
Without `Area:` lines the labels come from the changed folders (`web/areas.json`), and failing that the bar says
"Improvements".

## First sign-in

1. On the first deploy, Cognito emails `CF_OWNER_EMAIL` a temporary password (from `no-reply@verificationemail.com`;
   check spam).
2. Open `app_url` (the `https://dxxxx.cloudfront.net` address from the run summary).
3. Sign in with your email and the temporary password, then choose your own password.
4. Install the app: press **Get the app** in the sidebar (on a phone: Settings, or the banner on Home). It offers the
   `.dmg` on a Mac, the `.exe` on Windows, the install button on Android and the Add to Home Screen steps on iPhone.

The temporary password is valid for 7 days. If it expires, an AWS admin can reset it: Cognito console → user pool
`cf-prod-users` → Users → your email → Reset password.

You stay signed in as long as you open the app at least once every 30 days ([SECURITY.md](SECURITY.md)).

## Rollback

- **Code**: revert the bad commit on `main` (`git revert <sha>` in a branch, pull request, automatic merge). The next
  deploy rebuilds and applies the previous state. The agent image tag is a hash of its sources, so the old image is
  reused if it is still in ECR.
- **Infrastructure state**: the state bucket is versioned; an older state version can be restored if a run is
  interrupted. Prefer fixing forward with a new commit.
- **Data**: DynamoDB point-in-time recovery restores the table to any second in the last 35 days (into a new table).
  Clips in S3 are not versioned; declined clips are deleted on purpose.

## Destroying everything

Run from a machine with credentials for the account (for example by assuming the deploy role), in `infra/envs/prod`:

```bash
terraform init -backend-config="bucket=<state bucket>" -backend-config="key=clip-factory/prod/terraform.tfstate" \
  -backend-config="region=eu-north-1" -backend-config="use_lockfile=true"
terraform destroy -var "owner_email=<email>" -var "agent_image_tag=<any>"
```

Empty the media and web buckets first if the destroy stops on "bucket not empty", and delete the ECR images if the
repository refuses to go. The Terraform state bucket, the OIDC provider and the deploy role are not managed by this
Terraform; delete them by hand if you no longer need them. GitHub Pages and the legal pages are not affected.
