---
document_id: command.monday-qualify
title: companyos monday qualify
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-08-31
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - architecture.company-instance
    - specification.company-records-sprint-v0.1
---

# `companyos monday qualify`

This command performs the first read-only Company Instance qualification for a
maintained Monday Connector. It does not provision an external Agent, retain a
human OAuth credential, synchronize records, write to a board, or materialize a
Company Workspace.

Plan the exact consent and discovery boundary first:

```bash
companyos monday qualify \
  --workspace <company-workspace> \
  --client-id <non-secret-monday-app-client-id> \
  --redirect-uri http://127.0.0.1:43127/callback \
  --board <test-board-id> \
  --board <second-read-only-board-id> \
  --state <outside-workspace-state-file> \
  --plan
```

The plan binds the clean exact Core identity, Company Workspace location,
Monday OAuth client ID, loopback callback, API version `2026-07`, scopes
`boards:read` and `me:read`, exact board IDs, non-secret state path, consent
effect, and credential-disposal rules. Confirm its hash before applying:

```bash
companyos monday qualify <same-options> --apply <confirmation-hash>
companyos monday qualify --state <state-file> --resume
companyos monday qualify --state <state-file> --status
```

The Monday app MUST use the new OAuth 2.1 flow with S256 PKCE and MUST register
the exact loopback redirect URI shown in the plan. Its configured and consented
scopes MUST be exactly `boards:read` and `me:read`. Qualification fails closed
when Monday grants another scope, returns an incomplete board set, denies the
request, changes OAuth state, or does not provide the OAuth 2.1 refresh
credential. The refresh credential proves the new flow is active; it is not
retained.

`MONDAY_OAUTH_CLIENT_SECRET` is an Instance secret. Enter it only into the
selected runtime host's Sensitive secret surface, then inject it into this
command's process using the host's secret-bound execution mechanism. Do not put
it in chat, Git, a Workspace file, a setup answers file, qualification state,
or a command argument. The maintained Vercel profile uses `vercel env run` for
that injection; another qualified runtime host may use an equivalent
non-persisting mechanism.

During `--resume`, the Workbench starts the exact loopback receiver, generates
one random OAuth state and S256 PKCE verifier, and displays the official Monday
authorization URL. The human reviews the account and two scopes in the browser.
The authorization code, verifier, app secret, access token, and refresh token
remain in process memory only. The access token is used once to query `me` and
the selected boards' metadata. Both tokens are then discarded.

The mode-0600 state file records only the exact Core identity, public app and
resource selection, consenting actor and account identifiers, reported scopes,
API/request evidence, board names and permissions, group IDs and titles,
column IDs/types/settings, a deterministic discovery digest, and an explicit
`credentials_retained: false` assertion. It contains no items, updates, column
values, provider effects, or credentials.

This receipt is input for later human review. A separate approved effect plan
is required to create an external Monday Agent, store its one-time Agent token
and signing secret, deploy a callback, grant a test board, activate the Agent,
or perform a write. Production resources and the Company Workspace remain
unchanged until their own review and confirmation gates pass.
