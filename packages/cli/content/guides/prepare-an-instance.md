---
document_id: guide.prepare-instance
title: Prepare a Company Instance
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-20
owners:
  - core-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Prepare a Company Instance

Assign a stable Instance ID and environment, then pin the exact Core and
Workspace revisions. Provision environment-specific infrastructure, secrets,
provider bindings, and durable state through the Platform Administrator—not
through committed files.

## Account and project checklist

For the maintained reference setup, the Platform Administrator verifies:

- a Vercel account or team controlled by the company or appointed custodian;
- one identified Vercel project and deployment identity per isolation decision;
- Vercel AI Gateway access, an approved usage budget, and confirmed access to
  the exact selected model for the runtime team's billing tier;
- a Neon/Postgres account and project when durable state is required;
- separate production and non-production credentials and state unless an
  explicit risk decision permits sharing;
- GitHub Actions secrets for deployment credentials and read-only access to the
  pinned Core; and
- provider accounts and installations for every declared connection, with
  minimum scopes, billing/recovery ownership, and a revocation path.

Vercel and Neon/Postgres are the reference providers. An alternative is valid
only when it preserves the Company Instance contracts for isolation, secrets,
provenance, evidence, state guarantees, observability, and rollback. An
`authoring-only` Workspace does not provision these accounts.

## Maintained first-installation profile

For a company that explicitly requests the complete Slack starter, use
`companyos setup --profile vercel-neon-slack` rather than assembling provider
commands from this Guide. Its read-only plan names the exact GitHub owner and
repository, Vercel scope and project, Neon resource, Slack connector, model,
create-or-adopt choice, cost or consent boundary, and rollback responsibility.
The plan hash must be confirmed before any provider mutation.

The state machine pauses for browser login and provider consent, derives the
consenting human's canonical Slack team and user IDs without retaining the
short-lived credential, and moves the Workspace from `authoring-only` to one
Tool-free supervised starter through a distinct preview and independently
reviewed pull request. It then builds one immutable Artifact and requests a
separate production-candidate confirmation before deployment.

Run `companyos verify-live --state <file>` after the human sends the requested
nonce in Slack. Success proves the exact deployment health and the persisted
human and assistant entries in Neon for scope `live-starter-instance`. It does
not certify a generic Effect Lane, an unattended workflow, or `enforced`
readiness.

Before release, run `companyos build` against clean exact repository checkouts
and a non-secret Instance declaration. The build records the Core and Workspace
commits, Workbench version, Workspace and Capability catalog hashes, resolved
ToolSet hash, roster, scoped agent material, and exact Connector bindings.
Production and non-production should not share secrets or state without an
explicit risk decision.

Deployment must consume generated company artifacts only after validation.
Those artifacts are disposable build outputs, not an additional source of truth.

## Reference Vercel Runner

The maintained Runner requires these Instance values:

| Value | Purpose |
|---|---|
| `SLACK_CONNECTOR` | Vercel Connect resource identifier for the environment-specific Slack installation |
| `DATABASE_URL` | isolated Neon/Postgres connection used by the `companyos` schema |
| `COMPANYOS_ARTIFACT_GZIP_BASE64` | gzip-compressed immutable Artifact built from clean exact checkouts |
| `COMPANYOS_PUBLIC_BASE_URL` | canonical deployment origin returned by real artifact-publication evidence |
| `COMPANYOS_MODEL` | explicit AI Gateway model identifier already verified for the runtime team's billing tier |
| `COMPANYOS_AGENT_ID` | Agent selected from the Artifact when it contains more than one Agent |

The Slack Connector trigger path is `/api/webhooks/slack`. Health is
`/api/health`. A release is not accepted until health reports the expected
Core commit, Workspace commit, Artifact hash, and resolved ToolSet hash; an
authorized roster member reaches the selected Agent; and an unknown identity
is blocked before model invocation.

The maintained Runner authenticates AI Gateway through the Vercel deployment
identity. It does not consume `ANTHROPIC_API_KEY` or another direct provider
key. Supporting a direct provider key requires a separately reviewed Runner
provider adapter; never place that key in the CompanyOS Artifact.

An artifact publication is served from `/artifacts/<artifact-id>` only after
the exact R3 request passes Core authorization and approval consumption. The
route applies a restrictive content-security policy. Paid-provider effects are
not inferred from a successful Runner deployment; each requires an exact real
Connector binding.
