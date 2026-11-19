## ADR-26 Python for every backend, Terraform for every resource, serverless only

- **Context.** The owner: "I guess you are using Python for backend, and you are using Terraform for the infrastructure
  as code language ... the entire infrastructure should be serverless."
- **Decision.** All backend code is Python 3.13: the Lambdas in `api/` (standard library plus vendored `boto3` and
  `aws-durable-execution-sdk-python`, one zip) and the agent in `agent/`. Every AWS resource is Terraform in `infra/`
  (AWS provider `>= 6.68, < 7`), including the optional bootstrap of the deploy role. Only managed, pay-per-use
  services: CloudFront, S3, S3 Vectors, DynamoDB, API Gateway (HTTP, WebSocket, REST), Lambda (plain and durable),
  AgentCore Runtime, Bedrock, Transcribe, Cognito, SSM, CloudWatch, SNS, ECR. No EC2, no ECS, no VPC. The web app and
  the desktop wrapper are front-end code (TypeScript, Rust), not backend.
- **Alternatives.** CloudFormation, CDK or SAM (the owner chose Terraform); TypeScript Lambdas (the owner chose Python).
- **Consequences.** One language for the backend and its tests (pytest, ruff, mypy), one tool for infrastructure and
  its tests (`terraform test` with mock providers). Durable functions run on `python3.13`, which the Lambda runtime
  supports.
