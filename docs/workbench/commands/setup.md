---
document_id: command.setup
title: companyos setup
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-08-24
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

Before each external create, setup records a non-secret write-ahead intent.
The immutable provider receipt is then stored immediately. Resume reconciles a
pending intent by provider identity and never repeats a create merely because a
name search is temporarily stale. Existing resources and production variables
without an Oregano receipt are treated as conflicts and are left unchanged.

The starter keeps the original human as its only Workspace Steward. The
installer binds that person's verified Slack principal to the existing roster
entry and never requests, creates, or invites a second reviewer.

## Maintained profile

`vercel-neon-slack` performs these bounded phases:

1. verify Git, GitHub CLI, the repository-pinned exact pnpm, Vercel CLI, and the
   maintained Vercel Runner;
2. authenticate GitHub in the browser;
3. initialize and push a private Company Workspace repository;
4. detect and preserve protection on an adopted GitHub repository, or
   automatically apply the solo-Steward protected `main` baseline to a new
   repository when available, recording either `enforced` or `advisory`
   without an upgrade prompt;
5. authenticate Vercel, create or adopt the exact project, and verify the
   maintained `packages/runner-vercel` Next.js root without changing a
   conflicting adopted project;
6. create or adopt a Neon Marketplace resource without pulling its connection
   string to disk;
7. create or adopt a Slack Vercel Connect resource and attach the verified
   `/api/webhooks/slack` trigger;
8. pause for a browser authorization with only `identity.basic`, request a
   short-lived Slack user token, call `auth.test`, retain only the canonical
   team and user IDs, and discard the credential;
9. preview and apply one supervised, Tool-free Oregano Agent and Slack workflow;
10. push the operating change through a required-check pull request and obtain
    the Workspace Steward's exact merge confirmation;
11. build one immutable production Artifact from clean exact Core and Workspace
    commits and create its Vercel environment values without `--force` or
    overwriting pre-existing production configuration;
12. deploy only after the exact production-candidate confirmation, retain the
    structured deployment receipt, wait for provider readiness, and poll the
    provenance health endpoint through temporary non-JSON responses; and
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

GitHub Free is sufficient. Hosted branch protection is useful defense in depth
and is applied automatically when supported, but it is not a second setup mode
or a completion requirement for this starter. Existing stricter organization
controls remain unchanged. Hosted enforcement must be established separately
before a later capability grants an unattended agent repository write, merge,
or deployment authority.

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
neon_plan: free_v3
neon_region: fra1
slack_connector_name: oregano
slack_connector_mode: create
slack_channel_id: ""
model: openai/gpt-5.4-nano
```

The example is a schema illustration, not default company data. Passwords,
provider credentials, database URLs, private keys, resolved Artifact content,
and short-lived Slack tokens are rejected from setup state.

The qualified Neon values in this example are provider identifiers, not a
promise about price or availability. Setup must show the current provider plan,
region, terms, and possible charges before consent. The maintained Slack
profile reserves connector name `oregano`; this keeps the installed Agent's
visible Slack name independent of the Company Workspace name. Provider resource
IDs remain separate and are recorded only in Instance setup evidence.
