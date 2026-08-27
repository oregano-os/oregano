---
document_id: guide.connect-knowledge-source
title: Connect a Repository Knowledge Source
kind: guide
status: implemented
authority: canonical
language: en
updated: 2026-08-26
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - specification.company-knowledge-v0.1
    - specification.company-knowledge-v0.2
    - command.knowledge
---

# Connect a Repository Knowledge Source

This procedure connects one read-only GitHub repository document source to the
existing Company Instance database. It does not add a second database, Agent
Tool surface, or publication path.

The repository files below use the supported V1 compatibility shape. Generic
source commands do not construct GitHub directly: the maintained Source
Connector registry resolves the exact V1 registration, normalizes it to the V2
contract, and runs the V2 durable ingestion pipeline while preserving the V1
Connector identity. New native V2 provider bindings separate installation,
SecretRef binding, qualification, and activation; only an exact qualified
`active` binding may ingest.

## 1. Declare the Workspace requirement

Add a protected `connections/*.md` file and review it as a security change:

```yaml
---
version: 1
type: knowledge-source
source_id: company-handbook-repository
kind: repository-documents
data_owner: human:knowledge-steward
retention: retain
legal_hold: false
data_class: business
personal_data: false
path_prefix: docs
include_extensions:
  - .md
max_object_bytes: 262144
stale_after_hours: 24
---
```

The compatibility shape accepts business Markdown and routes it to quarantine
for later processing and review. The native V2 contract also represents
confidential, restricted, personal, and sensitive sources, but such a binding
may become model-ready only after its fixed policy or provider-ACL mapping has
passed conformance. An unresolved mapping remains administrator-only
quarantine.

`retention: retain` means that fetched source content has no automatic deletion
deadline. If a governed source instead needs finite retention, declare
`retention_days: N` in place of `retention: retain`. A legal hold is an
independent temporary control and MUST NOT be used to simulate permanent
retention.

## 2. Declare the Instance binding

Keep the binding outside the Company Workspace. It is non-secret configuration
and contains only a SecretRef:

```yaml
version: 1
source_id: company-handbook-repository
connector: oregano/github-repository-source
connector_version: 1.0.0
secret_ref: env:COMPANY_KNOWLEDGE_GITHUB_TOKEN
owner: example-company
repository: shared-handbook
ref: main
required_scopes:
  - contents:read
```

Set the referenced environment variable in the Instance secret store. Give the
credential read-only repository contents access. Never paste its value into the
binding, Workspace, Artifact, receipt, or command output.

## 3. Verify, then synchronize

```bash
companyos knowledge source verify \
  --requirement connections/company-handbook.md \
  --binding /secure/instance/company-handbook.yaml

companyos knowledge source sync \
  --requirement connections/company-handbook.md \
  --binding /secure/instance/company-handbook.yaml \
  --workspace .
```

Verification checks repository identity and read access. Synchronization uses
GET only, bounded pagination, integrity-protected immutable-tree cursors,
durable Source Events, versioned Raw Evidence, ACL and sanity gates, receipts,
and completed watermarks. A truncated or changed inventory fails closed. Only
a complete fresh inventory may mark a missing object provider-deleted, and that
state change retains its stored payload.

Synchronization does not require an active Handbook snapshot. It populates the
Raw Evidence boundary only. Later extraction creates Page and Claim proposals;
later review or Handbook promotion remains a separate governed path.

## 4. Health and offboarding

```bash
companyos knowledge source health \
  --requirement connections/company-handbook.md \
  --binding /secure/instance/company-handbook.yaml

companyos knowledge source revoke \
  --requirement connections/company-handbook.md \
  --binding /secure/instance/company-handbook.yaml

companyos knowledge source delete-request \
  --requirement connections/company-handbook.md \
  --binding /secure/instance/company-handbook.yaml \
  --workspace . \
  --principal human:knowledge-steward \
  --object docs/obsolete.md \
  --reason "Approved removal request"

companyos knowledge source delete-restore \
  --requirement connections/company-handbook.md \
  --binding /secure/instance/company-handbook.yaml \
  --workspace . \
  --principal human:knowledge-steward \
  --request <request-id>
```

Revoke disables the local binding without deleting watermarks, receipts,
version provenance, decisions, or retained Raw Evidence. Revoke the provider
credential separately in GitHub. Restore access only through a new reviewed
binding and fresh verification. Provider deletion marks the Source Object
absent and never authorizes payload removal. An explicit deletion request has a
dependency preview and a 72-hour restoration window. `legal-hold --enabled
true` blocks deletion, while `delete-apply --request <request-id>` can redact
only an eligible approved request after the window. Lifecycle receipts and
content digests remain as durable evidence.

## 5. Native Granola meeting source

Granola uses a V2 `meeting`/`hybrid` profile. Declare either provider-wide
visibility with `provider_scope.kind: workspace` or an exact folder allowlist
with `workspace-containers`. Provider-wide means every note visible to the
bound API key; it is not an empty folder allowlist. Use a fixed reviewed
CompanyOS policy or quarantine. The public API does not expose per-note
principal ACL entries, so `provider-acl` is rejected rather than inferred.

```yaml
version: 2
type: knowledge-source
contract_version: 2.0.0
source_id: company-meetings
source_kind: meeting
delivery_mode: hybrid
data_owner: human:knowledge-steward
data_class: restricted
personal_data: true
retention: retain
legal_hold: false
stale_after_seconds: 21600
content:
  media_types: [text/markdown]
  max_inline_bytes: 262144
  max_asset_bytes: 10485760
access:
  mode: fixed-policy
  root_policy_id: policy:company-handbook
provider_scope:
  kind: workspace
  workspace_id: workspace:company
```

The Instance binding uses separate API-key and webhook-signing SecretRefs. The
setup workflow supplies the exact implementation digest and qualification
receipt; do not invent them manually.

```yaml
version: 2
contract_version: 2.0.0
source_id: company-meetings
installation_id: installation:granola-company
connector_id: oregano/granola-meeting-source
connector_version: 2.0.0
secret_refs:
  primary: env:GRANOLA_API_KEY
  webhook: env:GRANOLA_WEBHOOK_SECRET
required_scopes: [personal, public]
provider_identity:
  kind: workspace
  workspace_id: workspace:company
  api_base_url: https://public-api.granola.ai
state: active
qualification:
  qualified_at: <ISO timestamp>
  receipt_id: <qualification receipt ID>
  implementation_digest: <exact registry implementation digest>
```

The webhook receiver must pass the untouched request bytes and all three
Standard Webhooks headers to the generic durable webhook ingress. It should
acknowledge only after the reference event and receipt are stored; note and
transcript fetch happens asynchronously. A personal API key with `personal`
and `public` scopes covers the owner's private notes and all notes visible to
that key through public sharing. A Workspace API key uses the single
`workspace` scope instead. Reconciliation uses `updated_after` with a 24-hour
overlap, provider page size no greater than 30, durable leases, resumable
cursors, and completed watermarks. The provider documents these contracts in its
[API overview](https://docs.granola.ai/introduction) and
[webhook guide](https://docs.granola.ai/webhooks).

The provider API does not return an independently verifiable workspace ID. A
live binding therefore also needs an attributable administrator receipt
proving that the key, selected scope, and webhook belong to the declared
Instance source. Qualification calls the provider from the runtime without
exporting the key. Every fetch obtains the complete paginated transcript.
Content up to `max_inline_bytes` is stored directly in immutable Raw Evidence;
larger content is stored through the qualified durable Raw Asset adapter up to
`max_asset_bytes`. Both paths use the declared `retain` lifecycle and therefore
have no age-based deletion.

## 6. Exact local input

The maintained local Connector is `oregano/local-file-source@2.0.0`. Its
requirement uses `source_kind: local-file`, `delivery_mode: pull`, provider
scope `local-input` with `access: exact-input-only`, and either a fixed reviewed
policy or quarantine. Its Instance binding has provider identity `local`, no
SecretRefs, no provider scopes, and the exact active implementation
qualification.

```bash
companyos knowledge source ingest \
  --requirement connections/local-source.md \
  --binding /secure/instance/local-source.yaml \
  --input /exact/authorized/file.md \
  --object decision-record-2026-08-26 \
  --media-type text/markdown
```

The command calls `stat` and reads only the exact regular file. It does not
accept a directory, expand a glob, follow a configured crawl root, or persist
the local filesystem path as evidence. Stable identity, normalized bytes,
digest, policy, receipt, and change-stream state use the shared V2 pipeline.

## 7. Session Corpus and durable archives

Agent stop buffers are temporary bounded files. Transfer persists the
normalized content in Session Corpus idempotently, records a payload-free
receipt, and only then removes that exact stop buffer. A failed write leaves
the buffer recoverable. Abandoned buffers become eligible after seven days;
active Session Corpus payloads expire after 30 days unless legal hold changes
their lifecycle.

Temporary cleanup is not durable-knowledge deletion. Pages, Claims, retained
Source Objects, syntheses, decisions, and Handbook commits remain. If the raw
conversation itself must remain, run the explicit archive command before
expiry with a local Source requirement whose retention is `retain`:

```bash
companyos knowledge session archive \
  --corpus <corpus-id> \
  --requirement connections/local-archive-source.md \
  --binding /secure/instance/local-archive-source.yaml
```

The archive becomes durable Raw Evidence through the same Source pipeline.
Session Corpus cleanup may then remove only its temporary working copy.
