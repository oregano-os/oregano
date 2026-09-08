---
document_id: onboarding.setup-options
title: Choose a CompanyOS Setup
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-09-08
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - onboarding.company-workspace
    - architecture.boundaries
    - command.setup
    - command.verify-live
    - status.current
---

# Choose a CompanyOS setup

CompanyOS currently implements one complete infrastructure setup profile:
GitHub + Vercel Pro (or Enterprise) + Neon/Postgres + Slack. You can choose how its model calls
are served, create or explicitly adopt compatible resources, or create only
a local authoring Workspace. Other hosting, database, and communication
combinations are extension possibilities, not available installers.

All live choices below remain experimental. The
[current status](../status/current.md) records a successful earlier pilot and
an outstanding fresh external qualification of the hardened setup revision.
Implemented code and passing simulated provider tests do not establish that
every new account or released candidate has completed a live installation.

## Available choices

The [five-minute standard setup plan](../plans/2026-09-08-five-minute-setup.md)
documents the implemented experimental flow: automatic defaults, one resource/cost summary
including the first deployment, direct operating initialization, and CLI-owned
recovery. The release installer and CLI share this flow. Fresh external timing
qualification remains outstanding; five minutes is not yet a measured promise.

| Choice | What it sets up | Entry and completion | Availability |
|---|---|---|---|
| Standard live starter | Private GitHub Workspace, Vercel Runner, Neon/Postgres and Slack; required choice of OpenAI or Anthropic using its direct API | Shared Release runbook; `companyos setup`; one provider choice and one resource/cost review; `companyos verify-live` before completion | Implemented, experimental; the human supplies a provider API key in Vercel Sensitive Production settings |
| Another model or provider on request | The same infrastructure with an explicitly requested, release-supported model recipe | Standard session accepts `model` or `model_route` on request; adoption retains the advanced flow | Maintained routes remain available, including Gateway; there is no automatic Gateway fallback |
| Local authoring Workspace | Company files and local checks; no hosted runtime, database, or Slack assistant | `companyos create workspace`, then `companyos bootstrap verify` | Implemented, experimental; not a live installation |
| Alternative infrastructure | For example a container host, another PostgreSQL service, or another communication surface | No selectable full setup profile or complete installation runbook exists | Requires implementation and qualification before it can be offered |

Selecting `create` or `adopt` changes resource handling within the same live
profile. Adoption is not permission to overwrite an arbitrary project or to
use a provider absent from the profile. The maintained live path targets one
production Instance; it is not a staging-and-production installer.

## Test before releasing

Maintainers can [test an unpublished candidate](../workbench/commands/setup.md#test-an-unpublished-candidate)
with the same standard onboarding and a locally packaged exact commit. The commit
must be pushed for GitHub checks, but a tag, merge and public release are unnecessary.
The test uses fresh resources and an automatically named separate Slack connector,
keeps one resource/cost review, and is labeled as a candidate. It does not create an isolated Preview environment in an existing setup.
Candidate timing remains separate from stable release qualification.

## Start with Codex or Claude Code

Both agents use the same ordinary chat-and-terminal workflow. No agent-specific
plugin or duplicate installation implementation is required. Start in an empty
setup folder and use this prompt for the standard live starter:

```text
Set up Oregano using the verified release installer described here:
https://github.com/oregano-os/oregano/releases/latest/download/INSTALL-COMPANYOS.md
Guide me in my language. Ask whether I want OpenAI or Anthropic. Use the other
standard defaults, show one editable setup
summary, and handle routine work yourself. Finish after my first real Slack
reply and successful verification.
```

OpenAI and Anthropic are the two ordinary choices; the recipe model is filled
in automatically. Other models or providers require an explicit request, using
`model` or `model_route` in the same session. Deliberate resource adoption uses
the [advanced setup contract](../workbench/commands/setup.md#explicit-advanced-and-legacy-flow).
Adoption answers and separate activation/deployment decisions remain supported.
Adoption is an optional destination, never a preliminary simple/advanced question.
Supported native and named compatible cloud routes are enumerated from the
same recipe registry in `supported_model_routes`; individual provider/model
availability and live qualification must be established for the chosen release.
A recipe does not imply another infrastructure profile. Direct keys are entered
only into the runtime host's Sensitive environment through provider pages.

For local authoring, follow
[Create a Workspace](../workbench/commands/create-workspace.md) and
[Bootstrap verification](../workbench/commands/bootstrap.md) in the exact
Workbench checkout. Its completion scope is `authoring-only-local`, so do not
use the full live prompt and announce success at this earlier checkpoint.

## What the maintained profile connects

| Responsibility | Current binding | Setup behavior |
|---|---|---|
| Source and review | GitHub | Fresh: publish one checked operating initial commit under the setup decision. Advanced/adoption: retain Steward merge authorization. Attempt hosted protection in both flows |
| Runtime hosting | Vercel Pro or Enterprise | Detect the selected team's plan before creating hosted resources, then verify the Next.js root `packages/runner-vercel`, include source files outside that root, bind environment values, deploy, and verify health |
| Durable state | Neon/Postgres through Vercel Marketplace | Create or adopt a dedicated resource without pulling credentials to disk; prepare and qualify CompanyOS schemas through the runtime's secret environment |
| Communication | Slack through Vercel Connect | Use `slack/oregano`, attach `/api/webhooks/slack`, resolve the consenting human, and verify a persisted model-backed round trip |
| Model execution | Separate model recipe | Bind the exact route and model; request a Sensitive provider credential only for routes that require one |

The Neon phase currently links the resource to production, preview, and
development environments. Those environment links do not prove isolated
databases or a separately qualified Preview Instance. Environment isolation
must be established through the relevant
[Company Instance contract](../architecture/company-instance.md).

Vercel documents the underlying
[Marketplace provisioning](https://vercel.com/docs/cli/integration) and
[Connect attachment and authorization](https://vercel.com/docs/cli/connect)
operations. Their availability does not replace testing the exact Oregano
profile and pinned provider CLI together.

## Vercel prerequisite and automatic scheduling

The maintained Runner's `packages/runner-vercel/vercel.json` includes cron
schedules that run every minute, every fifteen minutes, and multiple times
per day, including optional Builder, Records, Sprint, and Knowledge handlers.
These schedules are present in the deployed configuration even when the
starter grants no business Tools.

As checked on 2026-09-08, Vercel documents that Hobby allows only daily cron
execution and rejects more frequent schedules at deployment. The unchanged
Runner configuration therefore requires Pro or Enterprise. GitHub Free
remains sufficient for the supervised starter.
See [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

The maintained profile declares Pro as its minimum and accepts Enterprise.
After Vercel login, setup resolves the selected team and reads its current
billing plan before creating any hosted resources. It checks again when setup
resumes and immediately before production deployment. No human plan answer or
cron-frequency choice is needed; Oregano manages background scheduling.

Pro and Enterprise continue automatically. Hobby returns the selected team's
billing link and waits; after the human upgrades in Vercel, the same setup
state resumes without another setup-plan confirmation. An unreadable or
unknown plan returns an access/plan diagnostic instead of an upgrade claim.
Oregano never changes subscriptions automatically or substitutes reduced
schedules. `verify-live` also reads the current plan rather than trusting an
older receipt. Setup retains only team ID, slug, plan, and check time.

See [Vercel Pro pricing](https://vercel.com/docs/plans/pro-plan) for current
subscription and usage charges. Provider login or a required billing action
can extend installation time; a universal five-minute completion is not yet
qualified. This preflight checks the declared plan prerequisite, not every
possible provider entitlement or the execution of every scheduled handler.

## Known limits of the current setup

### Release metadata and qualification

`setupReleaseMetadata()` generates the standard profile, model, and supported
model-route list from the maintained setup registry. Release assets include
checksummed platform bundles and the identical Codex/Claude installer. Source
metadata is explicitly a template; only immutable released assets install.
The current implementation has local and simulated provider coverage. Neither
those tests nor the earlier pilot qualify the new cold five-minute journey.

## Extending the setup catalog

Future choices should use a common installation flow with a small guide for
each implemented profile, shared by Codex and Claude Code. This is extension
guidance, not a claim that a multi-profile dispatcher already exists.

A new infrastructure choice needs provider lifecycle operations, profile
selection in the CLI, compatible state and resume handling, an actual Runner
and transport, a profile-aware verifier, and a release-matched guide. It must
also have fresh end-to-end installation evidence before being presented as a
qualified alternative. Keep unsupported combinations outside the installable
choices and label their status explicitly.

Do not duplicate the entire common runbook for each model provider. Model
variants remain selections within an infrastructure profile. The status,
commands, guide, and qualification evidence for each offered choice must agree.
