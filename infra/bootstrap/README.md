# Bootstrap: the role GitHub Actions deploys with

`deploy.yml` signs in to AWS through GitHub's OpenID Connect provider and assumes the role named in the repository
variable `CF_DEPLOY_ROLE_ARN`. Nothing else in this repository creates that role, because it has to exist before the
first deploy. You set it up once, in one of two ways.

Only workflow runs on the `main` branch of `Lamo2real/clip-factory-legal` can assume it (pull requests and other
branches cannot).

## Option A: with Terraform (this folder)

Run with your own administrator credentials for the target account:

```bash
cd infra/bootstrap
terraform init
terraform apply                                   # creates the OIDC provider and the role
# The account already has the GitHub provider (only one is allowed per account)?
terraform apply -var create_oidc_provider=false
```

Copy the `deploy_role_arn` output into the repository variable `CF_DEPLOY_ROLE_ARN` and the `role_boundary_arn`
output into the repository variable `CF_ROLE_BOUNDARY_ARN` (Settings → Secrets and variables → Actions → Variables).

The stack is already deployed, from before the boundary existed? Switch over once, in this order (its roles do not
carry the boundary yet, and the enforced rule would refuse to change them):

```bash
terraform apply -var enforce_role_boundary=false  # 1. creates the boundary; the old rule stays for now
# 2. set CF_ROLE_BOUNDARY_ARN, then run the deploy (Actions → deploy → Run workflow): every cf-prod-* role gets it
terraform apply                                   # 3. from now on only roles with the boundary get permissions
```

State stays local (`terraform.tfstate` here, git-ignored). It holds a few IAM resources (the provider, the role, its
policies and the boundary policy); if it is lost, import them again or recreate them.

What the role may do:

* `PowerUserAccess`: every service the stack uses, but no IAM.
* IAM only on roles named `cf-prod-*` (the roles the stack creates), `iam:PassRole` of those roles to Lambda,
  AgentCore and API Gateway (the account's CloudWatch logging role `cf-prod-apigw-cloudwatch`) only, and creating
  service-linked roles on first use of a service.
* Permissions can be given to a `cf-prod-*` role (`CreateRole`, `PutRolePolicy`, `AttachRolePolicy`) only when the
  role carries the permissions boundary `cf-prod-role-boundary` (everything except IAM, Organizations and account
  settings), and the boundary can never be removed or changed by the deploy role. So the role cannot make itself an
  administrator by creating `cf-prod-x` with `AdministratorAccess` and assuming it: at most it reaches what
  `PowerUserAccess` already gives it. `tests/` checks this offline (`terraform test`).
* The deploy role's own name (`role_name`) may not start with `cf-prod-`, or the rule above would let it change
  itself; `terraform apply` refuses such a name.

## Option B: by hand in the IAM console

1. IAM → Identity providers → Add provider → OpenID Connect. Provider URL `https://token.actions.githubusercontent.com`,
   audience `sts.amazonaws.com`. Skip this if the provider is already listed.
2. IAM → Roles → Create role → Custom trust policy. Paste `github-oidc-trust-policy.json` and replace
   `<ACCOUNT_ID>` with your 12-digit account id.
3. Attach the permissions described above (the JSON for the boundary and the role's policy is in
   [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md), section 2), or `AdministratorAccess` if you accept a role that can do
   anything. Name the role, put its ARN in `CF_DEPLOY_ROLE_ARN` and the boundary's ARN in `CF_ROLE_BOUNDARY_ARN`.
4. Open the new role → Edit → Maximum session duration → **2 hours** → Save. The deploy asks for a 2-hour session
   (the first build of the agent image can take that long); with the default of 1 hour AWS refuses the role and
   the deploy stops at "Configure AWS credentials". Option A sets this for you.

## If the role is refused

GitHub can be set to send a customised subject claim (for example with repository and owner ids). If the deploy
fails with "Not authorized to perform sts:AssumeRoleWithWebIdentity", compare the `sub` in the trust policy with
the claim GitHub sends and make them match.
