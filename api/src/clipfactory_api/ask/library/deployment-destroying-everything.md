## Destroying everything

Run from a machine with credentials for the account (for example by assuming the deploy role), in `infra/envs/prod`:

```bash
terraform init -backend-config="bucket=<state bucket>" -backend-config="key=clip-factory/prod/terraform.tfstate" \
  -backend-config="region=eu-north-1" -backend-config="use_lockfile=true"
terraform destroy -var "owner_email=<email>" -var "agent_image_tag=<any>"
```

Empty the media and web buckets first if the destroy stops on "bucket not empty", and delete the ECR images if the
repository refuses to go. The vector bucket has `force_destroy = false`: Terraform deletes the `clips` index first,
then the bucket. Deleting the two durable functions stops their running executions first and can take up to an hour
(Terraform waits up to 60 minutes). The API Gateway account logging setting stays as it was. The Terraform state bucket, the OIDC provider, the deploy role and its `cf-prod-role-boundary`
policy are not managed by this Terraform; delete them by hand (or `terraform destroy` in `infra/bootstrap`) if you no
longer need them. The agent's log group `/aws/bedrock-agentcore/runtimes/...-DEFAULT` stays too (it expires its
logs after 30 days); delete it in the CloudWatch console if you want it gone. GitHub Pages and the legal pages are not affected.
The platform secrets under `cf-prod/platforms/` are created by the app, not by Terraform: press **Disconnect** on each
platform first (which also revokes the tokens), or delete them in the Secrets Manager console (eu-north-1). Remove the
developer apps on the platforms' websites too if you no longer need them.
