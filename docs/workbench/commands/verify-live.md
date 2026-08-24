---
document_id: command.verify-live
title: companyos verify-live
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-08-24
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - command.setup
    - architecture.company-instance
  implements:
    - onboarding.company-workspace
---

# `companyos verify-live`

```bash
companyos verify-live --state <file> [--format human|json]
```

This is the completion boundary for the full Codex and Claude Code starter
runbook. It fails unless fresh or recorded evidence proves:

- the GitHub Workspace repository is private and one hosted-protection attempt
  was recorded as `enforced` or `advisory`;
- the operating change passed the required check and the Workspace Steward authorized its merge;
- the named Vercel, Neon, and Slack resources are present in setup evidence;
- the Vercel project receipt records the maintained runner root, the Slack
  receipt records the exact trigger path and expected visible name `oregano`,
  and no unresolved provider create intent remains;
- the canonical Slack team and user principal is resolved without a stored credential;
- a structured Vercel deployment receipt is ready and current health matches
  the exact Artifact, Core commit, Workspace commit, selected Oregano Agent,
  empty ToolSet, selected model route, and exact model;
- direct Anthropic credential-presence and Sensitive-classification evidence
  exists when that route is selected, without a credential value in setup
  state; and
- the nonce-bound human Slack message and Oregano's exact
  `Setup-Test <nonce> successful.` response were persisted in the same Neon
  conversation with a non-secret response ID, response model, and token-count
  evidence from a real selected-model call.

Successful scope is exactly `live-starter-instance`, with readiness
`validated`. This scope proves one supervised starter deployment. It does not
authorize business Tools, provider effects, unattended execution, or a general
claim that every Company Instance enforcement control has been exercised.
Hosted GitHub protection is returned separately from readiness. Losing
previously verified protection produces a warning; unavailable protection on a
free plan produces informational evidence and does not fail this Tool-free
supervised scope.

`companyos bootstrap verify` remains the earlier `authoring-only-local`
checkpoint. It is intentionally insufficient for the live runbook.
