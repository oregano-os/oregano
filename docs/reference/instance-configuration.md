---
document_id: reference.instance-configuration
title: Workspace Instance Configuration
kind: reference
status: implemented
authority: canonical
language: en
updated: 2026-09-10
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - architecture.company-instance
    - architecture.company-workspace
    - command.build
---

# Workspace Instance Configuration

The canonical non-secret build declaration is `.companyos/instance.yaml` in
the Company Workspace, directly beside `governance.yaml` and
`compatibility.yaml`. There is no `instances/` directory. One file declares
one exact Instance and environment; this format defines no environment map,
overlay, inheritance, provider switch or automatic environment selection.

Instance is the correct architectural name: this is the configuration of one
deployed Core/Workspace pairing, not only its server or hosting provider.
Physical storage in the Workspace does not transfer runtime authority to a
Workspace author. Existing `.companyos/**` security review and CODEOWNERS
protection cover the file. Review, merge, deployment, Tool grants and per-effect
approval remain separate controls.

## Versioning and discovery

Commit the file to company Git. Its history records exact reviewed values with
the Workspace revision. `version: 1` is the format version, not a counter to
increment for each edit. Core and Workspace release versions remain governed
by the [versioning policy](../governance/versioning-policy.md); Core pins stay
in `.companyos/compatibility.yaml` and exact commits in Artifact provenance.

`companyos build <workspace> --output <artifact.json>` reads this exact path
relative to the selected Workspace, regardless of the current directory. The
Core and Workspace checkouts must be clean, and the canonical file must be
tracked. A missing file is an actionable error, never a synthesized empty
configuration. An authoring-only Workspace may still pass local
validation without it; prepare the declaration before its normal build.

There is no alternate input path or deployment-variable copy. `--instance` is
rejected. To change configuration, change the reviewed Workspace file.

The maintained setup creates the declaration before the initial commit. It
preserves an existing declaration and refuses a conflicting setup identity or
environment. The deployment build reads the committed file and does not rewrite
it. Only the current fresh setup state (schema 5) can be resumed; retired setup
states are historical receipts, not inputs to the current installer.

## Version 1 format

This complete minimal example is synthetic and grants no provider capability:

```yaml
version: 1
instance_id: example-company-production
environment: production
bindings: []
```

| Field | Required | Meaning |
|---|---|---|
| `version` | Yes | The number `1`, identifying this file format. |
| `instance_id` | Yes | Stable non-empty identity of this installation. |
| `environment` | Yes | Non-empty environment identity, checked against the deployment by its Runner. |
| `bindings` | Yes | List of exact Capability-to-Connector implementations; `[]` is valid when none are required. Each entry needs `capability`, `contract_version`, `connector`, `connector_version`. |
| `connectors` | No | Exact Connector installation entries: `id`, `connector`, `connector_version`, provider-specific non-secret `configuration`. |
| `default_agent` | No | Explicit default Agent when no exact route or authorized assignment selects another. |
| `agent_bindings` | No | Exact incoming communication routes. Each entry needs `id`, `agent`, `surface`, `account_id`, `channel_id`. |
| `builder` | No | Coding execution, coding profile, repository bindings and optional bounded test resources. |
| `workflow_bindings` | No | `direct_recipients` entries containing `binding`, `member_id`, `destination_binding`. |

Unknown top-level fields are rejected. YAML keys use the names above; provider
configuration follows the chosen Connector's contract. Quote numeric provider
identifiers so they remain strings. Workspace validation checks present files
using the same parser as builds, including the credential scanner. The full
build additionally resolves Agents, Tools, Capabilities and deployment inputs.

::: implementation-example

For example, this optional section selects Builder for one exact Slack route:

See the [maintained host profile](../operations/maintained-host-profile.md).

:::

::: implementation-example

```yaml
agent_bindings:
  - id: slack-builder
    agent: builder
    surface: slack
    account_id: T012345
    channel_id: C012345
```

See the [maintained host profile](../operations/maintained-host-profile.md).

:::

::: implementation-example

This is incoming Agent selection. Outgoing channel or DM destinations belong
to the Slack entry in `connectors`. Neither declaration grants a Tool or starts
a coding job. See [Operate the Builder](../workbench/guides/operate-builder.md)
for its complete execution, repository and test-resource format.

See the [maintained host profile](../operations/maintained-host-profile.md).

:::

## Stored values and external dependencies

::: implementation-example

Allowed values include exact company account, board, channel, user and
repository identifiers; Connector and contract versions; resource and
destination mappings; declared scopes; and SecretRefs such as
`env:MONDAY_API_TOKEN`. These identifiers belong only in the responsible
Company Workspace, never real-company examples in public Core or Packages.

See the [maintained host profile](../operations/maintained-host-profile.md).

:::

Actual credentials, database URLs containing credentials, private keys,
provider receipts, mutable runtime state and generated Artifacts remain
outside Git. `env:...` names a runtime value; the file never contains its
resolved credential. No code or provider SDK belongs in this declaration.

The declaration does not yet centralize every non-secret runtime setting.
For example, the Records Connector can refer to
`env:COMPANYOS_RECORDS_CONFIG_GZIP_BASE64`; model recipes, host deployment
bindings and other runtime settings retain their documented contracts.
Record Source operation-binding files use separate
schemas and CLI arguments; do not paste them into this build declaration or
assume this placement change changes their storage and qualification rules.

The hosted Builder reads the same tracked file directly from its exact checked
Workspace checkout. Only the expected configuration digest is passed alongside
the source commit. Before compilation, the normalized file must match the
running Artifact's configuration digest and production identity. Compilation
results are checked again before release. A later Instance-binding change
requires an authorized deployment; a coding proposal cannot rebind itself.

## Build, hosting and rollback

The build combines Core, Workspace content and the declaration into an
immutable Artifact. Artifact provenance includes the normalized Instance
configuration digest. The Runner consumes that Artifact, not a live YAML file
or Git checkout. Editing or merging the file does not change a running
installation until the corresponding Artifact is deployed.

::: implementation-example

Slack bindings remain the same when only hosting changes. A different runtime
host requires a qualified adapter and setup profile; adding `provider:
hetzner` or `provider: railway` is not a supported migration. Builder worker
hosting is separate: `builder.execution.adapter: vercel-sandbox` may remain
when the normal runtime moves to another qualified host.

See the [maintained host profile](../operations/maintained-host-profile.md).

:::

To migrate an existing installation, copy its exact non-secret declaration
into `.companyos/instance.yaml`, validate and review the diff, and build from
the resulting clean commit. Preserve all bindings; moving the file is not
authorization to change them or deploy. Use the Workbench that implements this canonical-file contract for new builds.
Use the prior immutable Artifact for a runtime rollback. Reverting Git alone
does not undo external effects or restore mutable database state.


## Builder test inactivity

The optional `builder.test_inactivity_days` integer (1–90, default 7) controls how
long an interactive candidate test remains open without activity. It does not
delete a build or its results. Expiry is enforced on use; the requester can ask
Builder to resume an available saved build. Keep this field inside the existing
Builder declaration alongside execution, coding-agent and repository bindings.
New test threads select a candidate per Instance and authenticated user; exact
communication destinations still come from `builder.test_resources` and the
corresponding Connector configuration. No additional app or Preview is required.

## Immutable Records build inputs

Hosted workflows require a retained Records configuration snapshot. A tracked
Instance may declare `configuration_snapshot_input: <sha256>` as the only
configuration key of its `oregano/company-records` Connector. This digest pins
a separately supplied, non-secret Records build template. Provider qualification
receipts stay outside Git. The template retains source declarations, bindings,
qualifications, source confirmations and roster content; it contains only
SecretRefs, never credentials.

`recordsBuildTemplate` replaces only Core ref/version, Workbench version and
Workspace ref with explicit `$build.*` identity placeholders. The trusted
compiler validates the input digest and Instance identity, substitutes its exact
accepted build identities and writes the full `configuration_snapshot` into
the immutable Artifact. The Instance configuration digest continues to identify
the original tracked declaration. No caller may substitute different source
content under the same digest. Qualification and fresh reads remain separate.

The CLI accepts the digest-keyed input map via `--records-build-inputs <file>`.
Later governed Builder compilations reconstruct the same approved templates from
the running Artifact's retained snapshots and pass them to the isolated compiler.
They do not read mutable deployment configuration or discover new provider access.
Changing the pinned input requires the existing Instance review and adoption path.
