---
document_id: plan.setup-integration-review
title: Setup Candidate Integration Review
kind: plan
status: draft
authority: canonical
language: en
updated: 2026-09-08
owners:
  - oregano-maintainers
audience:
  - human
  - agent
implementation_scope: provider
providers: [vercel, neon, slack, github, openai, anthropic]
---

# Setup candidate integration review

This records the initial read-only audit and subsequent isolated integration.
The setup change is on its own candidate branch; it has not merged into `main`.

## Compared states

- GitHub `main` was read directly with `git ls-remote` on 2026-09-08:
  `a8d114fccb0873b9494998eacea95c4057e99d2a`.
- The original working branch is `claude/change-plan-v3` at
  `95f1ddcdfaa385561111cab9dfa8b4c7e6861cbc`, two commits ahead and 60 behind `main`.
- The complete preceding working state was committed only in an isolated
  verification clone at `36f8cc74aeb75f03d2f4117a4a5e9d3ace46d869`.
  `git merge-tree --write-tree` compared this snapshot with `main` and local
  branch tips without modifying the original branch or any other worktree.
- All 13 reachable other worktrees had clean working directories. Three stale
  worktree entries were unavailable; they were not pruned or deleted.

## Conflicts with main

The complete snapshot has 13 conflict files:

- `.oregano/changes/2026-09-05-tool-sdk-template-literal-scanner.yaml`
- `docs/_generated/document-registry.json`
- `docs/_generated/navigation.json`
- `docs/onboarding/README.md`
- `docs/plans/2026-09-08-builder-workspace-activation-and-preview.md`
- `docs/specifications/company-instance-release-and-promotion-v0.1-draft.md`
- `docs/status/current.md`
- `docs/workbench/commands/verify-live.md`
- `docs/workbench/guides/prepare-an-instance.md`
- `packages/cli/content/guides/prepare-an-instance.md`
- `packages/runner-vercel/src/lib/bot.ts`
- `packages/testkit/tests/tool-sdk-security.test.ts`
- `packages/tool-sdk/source-inspector.ts`

The Runner conflict combines the new first-message setup proof with concurrent
Slack/Builder/Workflow work. Both behaviors need to survive integration. The
onboarding, verification, preparation and promotion documents need a combined
account of those capabilities. Generated documentation files should be rebuilt
after their source documents are reconciled.

The scanner implementation, scanner test and scanner plan conflicts arise from
the branch's earlier Tool SDK work, not the candidate installer. The local
Builder plan also overlaps a version now on `main`. These are reasons to prepare
a dedicated integration branch from current `main` with only the intended setup
changes, rather than merging every file from the old working snapshot.

## Other local branch tips

The following table covers local tips not ancestral to either `main` or the
setup verification snapshot. Historical branches can contain equivalent changes
merged under other commit IDs; their presence is not proof of outstanding work.
Counts are textual merge conflicts against the full setup snapshot, not a count
of independent product bugs. No branch was merged or reset.

| Local branch | Conflict files |
|---|---:|
| `codex/builder-acp-stage-0` | 33 |
| `codex/builder-hosted-startup-fix` | 13 |
| `codex/builder-live-workflow` | 9 |
| `codex/builder-v0.5.2-integration` | 31 |
| `codex/change-plan-v3-prerequisite` | 4 |
| `codex/company-knowledge-alignment` | 69 |
| `codex/company-knowledge-core` | 78 |
| `codex/company-records-foundation` | 28 |
| `codex/company-records-lifecycle` | 43 |
| `codex/company-records-production-runtime` | 22 |
| `codex/fix-durable-timer-jsonb-v0512` | 2 |
| `codex/fix-release-verification` | 1 |
| `codex/fix-sprint-refresh-chronology` | 1 |
| `codex/governed-agent-handoffs` | 18 |
| `codex/harden-install-bootstrap` | 22 |
| `codex/knowledge-answer-synthesis` | 6 |
| `codex/placement-reuse-planning-gate` | 12 |
| `codex/records-reconcile-concurrency` | 23 |
| `codex/release-v0.5.0` | 30 |
| `codex/release-v0.5.10` | 8 |
| `codex/release-v0.5.11` | 8 |
| `codex/release-v0.5.12` | 8 |
| `codex/release-v0.5.13` | 0 |
| `codex/release-v0.5.3` | 9 |
| `codex/release-v0.5.4-production-runtime` | 2 |
| `codex/release-v0.5.6` | 15 |
| `codex/release-v0.5.8` | 8 |
| `codex/release-v0.5.9` | 8 |
| `codex/shadow-runtime-without-provider-effects` | 15 |
| `codex/slack-agent-working-hotfix` | 5 |
| `codex/slack-channel-ingress-staging` | 2 |
| `codex/slack-markdown-publication` | 10 |
| `codex/slack-markdown-reports` | 10 |
| `codex/slack-records-sprint-replay` | 18 |
| `codex/sprint-blueprint` | 52 |
| `codex/sprint-connectors` | 44 |
| `codex/sprint-contracts` | 21 |
| `codex/sprint-domain` | 38 |
| `codex/sprint-instance-phase-6` | 53 |
| `codex/sprint-replay-timer-namespace-v0511` | 1 |
| `codex/sprint-runtime-hosting` | 30 |
| `codex/sprint-scenario-runner` | 0 |
| `codex/sprint-weekly-runtime-hosting` | 15 |
| `codex/stage0-preview-artifact` | 2 |
| `codex/tool-sdk-scanner-prerequisite` | 4 |
| `codex/typed-setup-providers` | 33 |
| `codex/vercel-connect-record-source-token` | 0 |
| `codex/workflow-conversations` | 11 |
| `codex/workflow-decision-buttons` | 10 |
| `codex/workflow-engine` | 10 |

## Integration outcome

The dedicated `codex/standard-setup-candidate` branch was subsequently rebased
without conflicts onto `05cb6b73d7be74d80a579f9843b7474b3e46a235` (Core `0.6.2`),
including the Builder Artifact retention and startup fix that landed during
verification. It applies only the setup changes, excludes
unrelated local Google Meet and Builder proposals, and preserves `main`'s scanner
implementation. The seven remaining conflicts in this scoped application were
resolved by retaining the current Builder release and Workflow behavior alongside
fresh setup, candidate acquisition, and normal first-message verification.
The Slack callbacks keep the current wrappers, including the new direct-message
registration, so SDK callback metadata cannot act as Builder continuation authority.
Generated documentation indexes were regenerated from the combined sources.

Candidate tests now use an automatically named `oregano-test-<session-digest>`
connector. Its exact name is part of the setup decision and later provider,
trigger, environment and verification evidence. An ordinary `slack/oregano`
connector can coexist in the selected team and cannot be adopted by this test.
The release and legacy setup continue to use their existing connector contract.

The isolated PostgreSQL 15.18 suite passed all 67 tests without skips. This covers
real transactions, durable restart/concurrency and schema preparation, using the
maintained Neon-driver test transport and a disposable loopback database. It does
not constitute Neon cloud availability or real Slack installation evidence.
The full Core checks and production Runner build passed on this combined
branch: 1,014 ordinary tests passed; 50 database opt-in cases in the ordinary
runner were covered by the separate required 67-test database run. The next hosted run uses separately selected fresh
resources and the ordinary single setup decision; its human consent, live result
and timing must be recorded independently. No public release is required.
