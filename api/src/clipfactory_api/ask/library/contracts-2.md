## 2. Repository layout

```
/                           GitHub Pages legal site (do not move) + README.md
config/models.json          the only place model ids live
config/platforms.json       per-platform stats refresh intervals, batch sizes and rate budgets (§16.4)
skills/<name>/SKILL.md      built-in skills, bundled into the agent image and seeded for the owner
docs/                       BUSINESS_REQUIREMENTS, ARCHITECTURE, CONTRACTS (this), AGENT, UX_DESIGN_SYSTEM,
                            DEPLOYMENT, SECURITY, TESTING, DECISIONS, ROADMAP; docs/architecture/aws-architecture.drawio
web/                        React 19 + Vite + TypeScript PWA (own package.json)
api/                        Python 3.13 Lambdas, standard library + vendored boto3 + vendored
                            aws-durable-execution-sdk-python only (uv project "clipfactory-api"; §14.10)
agent/                      Python 3.13 AgentCore runtime + its Dockerfile (uv project "clipfactory-agent")
infra/                      Terraform: envs/prod + modules/*
scripts/                    ensure-state-bucket.sh, push-image.sh, write-web-config.sh, build helpers
.github/workflows/          ci.yml (every push and PR), deploy.yml (push to main)
```
