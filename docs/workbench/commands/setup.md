---
document_id: command.setup
title: companyos setup
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - command.create-workspace
    - architecture.company-instance
    - specification.company-instance-release-promotion-v0.1
  implements:
    - onboarding.company-workspace
---

# `companyos setup`

The first maintained live profile extends the plugin-free Codex and Claude Code
runbook from a locally verified authoring Workspace to one supervised starter
Instance:

```bash
companyos setup \
  --profile vercel-neon-slack \
  --workspace <path> \
  --answers <yaml-or-json> \
  --state <file> \
  --plan \
  --format json

companyos setup \
  --profile vercel-neon-slack \
  --workspace <path> \
  --answers <yaml-or-json> \
  --state <file> \
  --apply <plan-confirmation-hash> \
  --format json

companyos setup \
  --profile vercel-neon-slack \
  --state <file> \
  --resume \
  [--operating-confirmation <hash>] \
  [--merge-confirmation <hash>] \
  [--production-confirmation <hash>] \
  --format json

companyos setup \
  --profile vercel-neon-slack \
  --state <file> \
  --status
```

`--plan` is read-only. It validates the exact release checkout, authoring
Workspace, bounded answers, resource modes, intended
provider mutations, costs and consent gates, rollback boundary, and state-file
placement. The returned hash binds the complete plan.

`--apply` creates a mode-0600 non-secret state file and advances until a browser
login, provider consent, exact operating-Workspace
confirmation, merge authorization, production confirmation, or Slack test is
required. `--resume` uses that same evidence rather than chat history. A failed
or interrupted command does not delete resources and must not be replaced by a
second setup state.

The starter keeps the original human as its only Workspace Steward. The
installer binds that person's verified Slack principal to the existing roster
entry and never requests, creates, or invites a second reviewer.

## Maintained profile

`vercel-neon-slack` performs these bounded phases:

1. verify Git, GitHub CLI, the repository-pinned exact pnpm, Vercel CLI, and the
   maintained Vercel Runner;
2. authenticate GitHub in the browser;
3. initialize and push a private Company Workspace repository;
4. apply and verify the solo-Steward protected `main` baseline;
5. authenticate Vercel and create or adopt the exact project;
6. create or adopt a Neon Marketplace resource without pulling its connection
   string to disk;
7. create or adopt a Slack Vercel Connect resource and attach the verified
   `/api/webhooks/slack` trigger;
8. request a short-lived Slack user authorization, call `auth.test`, retain only
   the canonical team and user IDs, and discard the credential;
9. preview and apply one supervised, Tool-free Oregano Agent and Slack workflow;
10. push the operating change through a required-check pull request and obtain
    the Workspace Steward's exact merge confirmation;
11. build one immutable production Artifact from clean exact Core and Workspace
    commits and inject it into Vercel as a sensitive environment value;
12. deploy only after the exact production-candidate confirmation; and
13. require a nonce-bound Slack message and persisted assistant response in
    Neon before completion.

Create and adopt are explicit per resource. The setup refuses a create-name
collision and refuses adoption when the named resource cannot be found. It does
not delete, replace, transfer, or silently reuse an external resource.

The starter Agent has no business Tool grants and its workflow is supervised.
This narrow initial-installation profile is not the general Preview or Effect
Lane orchestrator. It records readiness as `validated`, not globally
`enforced`, and does not authorize an unattended workflow or external business
effect.

## Answer contract

The answers file contains non-secret company and resource-selection data only:

```yaml
change_date: "2026-08-20"
steward_email: anna@example.com
github_owner: example-company
github_repository: companyos
github_account_type: organization
github_repository_mode: create
vercel_scope: example-company
vercel_project: example-companyos
vercel_project_mode: create
neon_resource_name: example-companyos-db
neon_resource_mode: create
neon_plan: free
neon_region: aws-eu-central-1
slack_connector_name: example-company-oregano
slack_connector_mode: create
slack_channel_id: ""
model: openai/gpt-5.4-nano
```

The example is a schema illustration, not default company data. Passwords,
provider credentials, database URLs, private keys, resolved Artifact content,
and short-lived Slack tokens are rejected from setup state.
