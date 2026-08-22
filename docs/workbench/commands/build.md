---
document_id: command.build
title: companyos build
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
  implements:
    - architecture.company-instance
    - specification.tool-architecture
---

# `companyos build`

```bash
companyos build <workspace> --instance <instance.yaml> --output <artifact.json>
```

The command compiles one exact CompanyOS pairing. Both the Oregano Core and
Company Workspace must be clean Git checkouts so their recorded 40-character
commit SHAs identify all material source.

The Instance declaration contains only an Instance ID, environment, and exact
Capability-to-Connector contract bindings. It must not contain resolved
credentials. Secrets, accounts, and provider configuration remain in the
deployment environment.

The build validates Tool and Capability JSON Schemas, compiles restricted
Company Tools, resolves each agent grant against the Workspace allowlist and
Instance bindings, scopes agent material, embeds the roster, and writes one
content-addressed artifact. It fails closed on unknown, duplicate, ambiguous,
unbound, forbidden, or invalid inputs.

The output path must not already exist. The artifact is a deployment input, not
a new source of operating truth. A successful build establishes reproducible
build evidence; it does not prove a provider deployment or `enforced` Instance
readiness.
