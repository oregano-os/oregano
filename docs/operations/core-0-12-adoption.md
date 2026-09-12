---
document_id: operations.core-0-12-adoption
title: Adopt the integrated Core 0.12.0
kind: guide
status: draft
authority: canonical
language: en
updated: 2026-09-11
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - reference.instance-configuration
    - specification.company-instance-release-promotion-v0.1
---

# Adopt the integrated Core 0.12.0

Core 0.12.0 combines the maintained Builder with declared Workflow Engine
execution, concern-scoped conversation coordination, selective participation,
and checked coordinator completion. The release candidate contains current
main-line Core behavior and the workflow development line. The version string
alone does not identify that integration: review and test its exact commit.

## Workspace migration

Compare the current operating Workspace with the reviewed development source
before choosing the release content. Development may already include selected
production instructions and newer adaptations despite a lower version label.
Preserve the intended latest workflow behavior, business authority and provider
boundaries; assess remaining production-only differences individually. Neither
branch ancestry nor the version label proves that one tree supersedes the other.

Replace legacy Sprint execution with equivalent reviewed declared workflows,
Skills and Company Tools. The canonical `.companyos/instance.yaml` must use the
supported `workflow_bindings` contract. `sprint_runtimes` is rejected, and the
Runner refuses Artifacts containing legacy Sprint execution. Removing only the
configuration field drops behavior and is not a migration. Keep bounded Builder
proof workflows, when part of the intended release, independent of the retired
Sprint executor. Their absence from a narrower test profile does not by itself
justify reintroducing them.

The exact Workspace Core pin and its CI checkout must agree. After the Core
release commit is merged, adopt that immutable SHA and rerun the relevant
Workspace checks. A successful check on an earlier feature branch does not
qualify a materially different integration or merge result.

## Instance and state transition

Validate the candidate on the existing isolated test surface with its reviewed
channels, recipients and provider resources. Real conversation delivery and
Builder coding/release readiness remain distinct from compilation or health.
Keep scheduled production work disabled until the complete Instance is ready.

Before production adoption, inspect pending legacy Sprint events, decisions,
intents and timers. Resolve or drain them explicitly: legacy execution state is
not converted into new Workflow Engine runs. Preserve its evidence. Prepare the
production Instance declaration with the exact production identity, qualified
sources, destinations and recipients; do not relabel a preview Artifact.

The database manifest advances from 2.0.0 to 2.1.0. The migration adds durable
conversation state and stops creating or requiring retired Sprint tables; it
does not delete existing legacy tables or rows. Use the maintained preparation
and qualification commands against the exact target database. Validate an actual
2.0.0-to-2.1.0 upgrade on disposable state before production preparation. A
fresh-database test alone does not prove the upgrade path.

## Release evidence and recovery

The release review must identify the exact Core and Workspace commits, canonical
Instance configuration digest, Artifact hash, test outcomes, state preparation
evidence, destination qualification, and bounded human acceptance. Build from
clean source. Stage and verify the production-target Artifact before promotion.
No source merge, version update, preview success or release tag by itself grants
production authority.

Retain the prior immutable Artifact and deployment. Existing 2.0.0 schema entries
and relations remain available for the prior runtime's read-only qualification.
The prior preparer rejects unknown newer schema history; do not rerun an old
database preparation command as a rollback operation. Verify the previous runtime
against the upgraded database before promising deployment rollback.

An old deployment cannot resume new workflow runs. Before rollback, account for
pending workflow actions and new provider effects. Source or Artifact rollback
does not rewind state, cancel escaped effects or transfer an approval to another
candidate. Recovery must preserve recorded evidence and prevent duplicate work.
