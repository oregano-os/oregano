---
document_id: operations.maintained-host-profile
title: Maintained Hosting and Communication Profile
kind: guide
status: approved
authority: canonical
language: en
implementation_scope: provider
providers: [vercel, neon, slack, github, openai, anthropic]
updated: 2026-09-13
owners: [oregano-maintainers]
audience: [human, agent]
availability: experimental
---

# Maintained hosting and communication profile

The maintained implementation combines the Vercel Runner, Neon/PostgreSQL state,
GitHub source and Slack via Vercel Connect. These are concrete adapters for the
provider-neutral Instance, authorization, conversation and release contracts.
Another adapter must satisfy those contracts; company business behavior must not
assume these provider names or physical identifiers.

The standard installer currently provisions this profile with an explicitly chosen
direct OpenAI or Anthropic model recipe. A coding-agent profile (Claude Code or
Codex through ACP) is a separate execution choice. Neither model selection nor
coding-agent selection changes the employee's human approval rights. See
[setup choices](../onboarding/setup-options.md) and the
[setup command](../workbench/commands/setup.md).

The tracked Instance declaration contains exact non-secret Connector bindings and
SecretRefs. Credentials remain in the host's selected environment. GitHub changes,
Vercel deployment identity, database readiness and actual Slack delivery are distinct
pieces of evidence. A merged commit alone does not establish a working deployment.
See the [Instance declaration](../reference/instance-configuration.md),
[Builder operation](../workbench/guides/operate-builder.md) and
[staged Slack delivery](vercel-slack-event-staging.md).

Vercel Connect selects destinations by project and environment or branch metadata.
A manually assigned domain alias does not prove that Connect resolves that target.
Reuse an already qualified custom test environment when practical. Inherit its
assigned credentials and preserve its isolated database, retained Artifacts and
scheduler targets. Verify channel and direct-recipient ownership before admitting
messages; a shared Slack installation must not cause both production and the test
runtime to answer. See [Connect qualification](vercel-connect-workflow-interactions.md).

Declared workflows use the generic engine, Records, communication and work-item
Connectors. They do not require the retired hard-coded Sprint executor. The
maintained host's routes, historical Artifact lookup, record synchronization and
human decision checks are described in the [Runner guide](vercel-workflow-runner.md).
A source test, health response or outgoing test card does not replace an actual
provider delivery and human acceptance of the bounded result.

PostgreSQL qualification checks the exact manifest and required catalog objects;
it does not create a new database or authorize a schema migration. Records readers
retain their declared projection, provenance and freshness contracts. Provider
credentials cannot expand an Agent's ToolSet or bypass per-effect authorization.

Retained workflow Record snapshots may still select Slack Record Source `0.1.3`.
The maintained registry keeps that exact profile alongside `0.1.4`; the older
profile retains its stricter bot-identity rule. Historical bindings, qualification
receipts and projection identities are not rewritten to impersonate a newer version.

## Exact Core identity at deployment

The CLI build checks the Workspace compatibility pin against the actual Core
checkout; the hosted Builder checks the pin against its accepted build image.
The Runner checks Artifact provenance against the host-provided
`VERCEL_GIT_COMMIT_SHA` when loading an Artifact in a hosted environment.
Missing or different source identity rejects startup. The health endpoint also
requires this equality before any readiness checks and returns HTTP 503 instead
of ready when it cannot prove it, including when the source identity is missing.
`coreCommit` reports the Artifact identity and `sourceCoreCommit` reports the
independent host identity. Operators compare both with the reviewed Workspace
pin; a claimed Artifact SHA alone is not deployment proof. Local unhosted Artifact
inspection remains possible, but cannot report deployment readiness without an
exact host source identity. No existing deployment is upgraded by changing Git.
