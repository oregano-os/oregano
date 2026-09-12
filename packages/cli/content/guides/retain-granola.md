---
document_id: guide.retain-granola
title: Preserve Granola during Knowledge retirement
kind: guide
implementation_scope: provider
providers:
  - Granola
status: implemented
authority: canonical
language: en
updated: 2026-09-11
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# Preserve Granola during Knowledge retirement

Retiring Brain does not require uninstalling Granola. Preserve the existing
provider installation, approved scope, Workspace connection declaration,
Instance configuration, API key and webhook signing secret. Keep resolved
credentials in their existing secret store. Do not revoke or copy them into Git.
In particular, an existing `COMPANYOS_GRANOLA_SOURCE_CONFIG_BASE64` binding and
its SecretRefs are retained configuration, not a cleanup target.

The provider client remains in `packages/connectors/granola/client.ts`, detached
from the retired Knowledge pipeline. It retains explicit workspace/folder
scope, bounded note pagination, complete transcript fetching with the existing
HTTP 413 fallback, bounded retries, content limits and webhook signature/replay
validation. Provider reachability does not independently establish workspace
ownership or per-note user access. Preserve the existing administrator-approved
scope and require a future consumer to enforce its own authorization.

The client has no database, queue, scheduler, ingestion pipeline or Agent Tool
grant. No new runtime capability is activated by keeping it. The old Knowledge
webhook consumer, reconciliation and extraction jobs are retired with Brain.
Existing Granola provider data and configuration remain available for a future
separately defined consumer. Do not acknowledge webhook deliveries as ingested
when there is no active consumer.

Mark the Workspace connection as retained and inactive after cutover. Keep the
provider-specific declaration and historical scope evidence; remove claims
that data is still automatically imported into the deleted Brain. A later
activation must select its destination and processing behavior explicitly.
