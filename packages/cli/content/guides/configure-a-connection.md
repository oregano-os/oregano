---
document_id: guide.configure-connection
title: Configure an External Connection
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Configure an External Connection

Put the declarative external-system binding in `connections/<system>.md`. It
may name the provider, required capability, non-secret resource identifiers,
data classification, allowed operations, and responsible steward.

Credentials, tokens, signing material, and environment-specific endpoints live
in the Company Instance's secret and configuration stores. Never commit them to
the Workspace. Generic provider adapter code belongs in Oregano Core; business
rules that use it belong in the Workspace.

Connections are security-class changes. Validate least privilege, failure and
revocation behavior, audit evidence, and the non-production test path.
