---
document_id: command.build
title: companyos build
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-09-09
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  implements:
    - architecture.company-instance
    - specification.tool-architecture
---

# `companyos build`

The required input is the tracked `.companyos/instance.yaml` in the selected
Workspace. Missing files and `--instance` overrides are rejected. The same path
is used by the hosted Builder in its exact checked Workspace commit. See the
[Instance configuration reference](../../reference/instance-configuration.md).
The build never creates or rewrites the declaration.

```bash
companyos build <workspace> --output <artifact.json>
```

The command compiles one exact CompanyOS pairing. Both the Oregano Core and
Company Workspace must be clean Git checkouts so their recorded 40-character
commit SHAs identify all material source.

The Instance declaration contains an Instance ID, environment, exact
Capability-to-Connector contract bindings, and optional non-secret runtime
Connector installation entries. Those entries may name exact resources,
destinations, permissions, logical field mappings, and environment SecretRefs.
It must not contain resolved credentials. Credential values remain in the
deployment environment and participate in neither Artifact content nor hashes.

The build validates Tool and Capability JSON Schemas, compiles restricted
Company Tools, resolves each agent grant against the Workspace allowlist and
Instance bindings, scopes agent material, embeds the roster, and writes one
content-addressed control Artifact. Ordinary Handbook Markdown is included only
where selected by the Agent's existing read scope. The structured roster
continues to provide identity and approval authority. The command fails
closed on unknown, duplicate, ambiguous,
unbound, forbidden, or invalid inputs.

The output path must not already exist. The artifact is a deployment input, not
a new source of operating truth. A successful build establishes reproducible
build evidence; it does not prove a
provider deployment or `enforced` Instance
readiness.

For executable `steps:` workflows, the control Artifact also contains validated,
content-addressed workflow manifests with exact resolved Tools, literal config,
Skill templates, calendars and execution constraints. Compilation does not yet
provide the pending generic runtime guard or durable engine. See the
[workflow contract](../../specifications/workflow-execution-v1-draft.md).

## Non-secret Records build inputs

`--records-build-inputs <file>` supplies a JSON object keyed by the SHA-256
digests declared as `configuration_snapshot_input` in the tracked Instance.
Values are non-secret Records templates produced by `recordsBuildTemplate`.
The compiler checks the digest, explicit identity placeholders, Instance identity,
credential exclusion and a 2 MB total size bound before constructing snapshots.
Keep this file outside Git because it can contain provider qualification receipts.
The output Artifact retains the complete resolved snapshot and exact build pair.
Missing or changed inputs fail; there is no environment fallback.
