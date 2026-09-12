---
document_id: command.setup
title: companyos setup
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
  depends_on:
    - command.create-workspace
    - architecture.company-instance
    - specification.company-instance-release-promotion-v0.1
  implements:
    - onboarding.company-workspace
---

# `companyos setup`

The setup's reviewed operating Workspace includes `.companyos/instance.yaml`
beside governance and compatibility. The declaration records the exact target
Instance before the first commit. The deployment
phase reads it and refuses a conflicting target; it no longer creates a
separate editable YAML beside setup state. Only current schema-5 fresh sessions
can resume, using their exact installer release. See
[Instance configuration](../../reference/instance-configuration.md).

::: implementation-example

`companyos setup` starts or resumes the standard fresh installation in the
current setup directory. Codex and Claude Code invoke the same entry and render
its events. No required profile, answers, Workspace, or state argument is needed.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

```bash
companyos setup --directory /absolute/setup --format json
companyos setup --directory /absolute/setup --reply '<structured response>' --format json
```

::: implementation-example

The standard infrastructure is GitHub + Vercel Pro/Enterprise + Neon + Slack.
The command discovers logins and account choices, derives names, language,
timezone and responsibility, and asks at most one company-name field when
accounts are unambiguous. It requires a model-provider choice: **OpenAI** or
**Anthropic**, with neither preselected. Each uses its direct API and the
existing recipe's agent model. One editable cost/resource overview follows.
The `confirm` response to that exact review covers all new resources and the
first production deployment. The session stores the decision privately.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

The response field is `model_provider: openai|anthropic`. The agent must ask
when no provider has been explicitly selected; it must not infer the choice
from its own model or an existing login. Only on request, accept `model` as an
exact override, or `model_route` for another maintained route (with an exact
model where the recipe has no default). Do not display a third menu option or
the entire model catalog. Mismatched provider/model choices fail before writes.
Changing provider before confirmation resets an earlier model override and
invalidates the review. Retries keep the selection; confirmed sessions keep
their exact binding. Gateway requires an explicit request and is never a fresh
default. Direct keys use the existing Sensitive Production browser-entry step;
there is no additional setup approval or credential-mode interview.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

The fresh state is schema `5`, flow `fresh-initialization`. It binds the session,
verified installer, provider scopes, release/template/configuration and costs.
After provider consent, setup creates a complete operating Workspace at version
`0.1.0`, checks its initial commit and attempts hosted protection, then builds,
deploys and verifies. It does not publish an authoring-only baseline or create
an activation PR. A normal first Slack message supplies model-backed persistence
evidence; there is no visible test nonce. Completion includes `verify-live`.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

Slack consent uses the current Vercel CLI user without an explicit token subject
and requests only `identity.basic`. The adapter validates the nested team/user
response from Slack `users.identity`; `auth.test` is not that identity contract.
The app Messages link uses validated connector metadata, without requesting an
app-subject token from the personal CLI. Project linking and Neon creation run
in disposable private directories because the provider CLI can generate local
OIDC and skill files even with environment pulling disabled.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

Vercel can protect a unique deployment URL even when its production domain is
public. Setup retains the immutable deployment receipt, checks the aliases
reported by its production inspection, and records a health URL only after
its response matches that exact deployment ID and Artifact provenance. It does
not follow login redirects, disable protection, or create bypass credentials.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

Slack creation passes `--triggers` as well as attaching the trigger destination.
These are separate provider operations: attaching a destination cannot enable a
connector created without incoming events. The message gate and final verification
re-read forwarding, app identity, production-only attachment and exact route. An
older disabled connector needs explicit repair of its existing configuration;
registering the same destination again or repeating a Slack message cannot fix it.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

### Slack delivery recovery

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

The agent checks steps 1–4 before inviting the first message; the connector
metadata check does not expose Slack's saved URL-verification state. The first
missing exchange returns the ordinary message invitation. If a later
retry still has no verified response, the installer returns a delivery diagnostic
with the exact Slack app settings and Vercel connector links. The agent handles
these technical steps before asking the human to repeat a message:

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

1. Use the browser session signed into the selected Slack workspace. Open the
   recorded app's **Event Subscriptions**. Do not replace the app, connector,
   workspace, credentials or production destination.
2. Require **Enable Events: On** and the Request URL
   `https://connect.vercel.com/trigger/<recorded-connector-id>`.
   The Slack-facing URL is the Connect intake; the project's
   `/api/webhooks/slack` route is its separate forwarding destination.
3. If Slack reports that the URL did not respond, use **Retry**. Require
   **Verified**, choose **Save Changes**, then reload and confirm it stays
   verified. A Vercel `serviceSync.status=done` response does not establish
   this state. A verification failure is a delivery problem, not a reason to
   regenerate tokens or reinstall blindly.
4. Require the bot event `message.im` for direct messages. Explicit connector
   event selections without it fail setup and final verification. Provider
   default selections are not evidence that Slack has verified its Request URL.
5. Compare scopes before and after provider UI edits. Slack can automatically
   add `groups:read` and `mpim:read` when saving
   `member_joined_channel`. The supervised starter does not consume that
   event. If it causes extra scope requirements, remove that unused event in
   the existing connector and remove the unapproved scope additions; retain
   message subscriptions and approved scopes. Do not authorize broader access
   merely to dismiss a reinstall banner. Verify both provider configurations.
6. Inspect the connector's **Observability** after one new human message:
   no `Inbound Trigger` points to Slack delivery/subscription configuration;
   inbound without `Forward Trigger` points to Connect routing; a forwarded
   failure belongs in the exact project's runtime logs. A
   `url_verification` event proves only the handshake, not message handling.
7. Retry the same installation. Only the real authorized human message,
   delivered model response, persisted evidence and `verify-live` can complete
   it. Do not invent an event, copy a bot reply, or edit completion receipts.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

This recovery is a documented provider repair, not a promise that external
provider availability can be guaranteed. A repaired continuation does not
qualify a newly rebuilt installer; qualify that exact bundle with a fresh run.

Events are `input`, `choice`, `review`, `action`, `recovery`, `complete`, and
`cancelled`. Responses are `answer`, `edit`, `confirm`, `retry`, and `cancel`;
see the release runbook for their JSON fields. Revision IDs are machine transport,
not human questions. Ordinary retries reuse the decision; changed scope cannot.
Existing same-name resources are inspected before the review. A later race or
ambiguous creation needs provider evidence, never silent adoption.

::: implementation-example

The directory's private `.companyos-bootstrap` session is the resume handle.
The same installed release is required. Keep the directory after interruptions.
Local validation is reused only when the generated file digest is unchanged;
live plan, account and deployment evidence is checked at effect boundaries.
For a qualification run, the direct entry also accepts `--started-at <ISO>`,
`--timing-report <file>`, `--harness codex|claude-code`, and `--cache cold|warm`.
A report is written only after live completion. These are maintainer options.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

See [Choose a setup](../../onboarding/setup-options.md) for source/release status,
existing-resource limits, model variants, and local authoring. The new path is
experimental; live timing qualification is outstanding.

## Test an unpublished candidate

::: implementation-example

A public release is not required to test a new installer. This explicit maintainer
path uses the same standard setup session, resource review, provider lifecycle,
and first Slack-message verification. The ordinary install prompt still selects
an immutable stable release.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

1. Commit the candidate in a clean Core checkout. Push that exact commit to a
   branch in `oregano-os/oregano` before attempting a hosted test: the generated
   Company Workspace check needs to check out that source. No tag, merge, or
   GitHub Release is required. Setup checks source availability before resources
   are created.
2. In that checkout, install its locked dependencies with `pnpm install
   --frozen-lockfile`, using its pinned pnpm. Build on the tester's platform:

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

   ```bash
   node scripts/build-setup-bundle.mjs /absolute/new-candidate-bundle
   ```

::: implementation-example

   Keep the resulting `oregano-setup-<platform>.tar.gz` and matching `.json`
   receipt together. The receipt fixes the source commit, platform, archive
   basename and SHA-256. Acquire the installer script from the same trusted
   checkout; a local checksum establishes consistency, not publisher identity.
3. Have Codex or Claude Code start it in a new setup folder:

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

   ```bash
   node /absolute/exact-core/scripts/install-companyos.mjs \
     --candidate /absolute/new-candidate-bundle/oregano-setup-<platform>.json \
     --directory /absolute/new-test-setup \
     --started-at <prompt-received-ISO-time>
   ```

   Both harnesses can use this prompt with the concrete paths filled in:

::: implementation-example

   ```text
   Test this unpublished Oregano candidate using the candidate instructions in
   docs/workbench/commands/setup.md from its exact Core checkout. Use the supplied
   bundle receipt and a new setup directory. Follow the standard setup events,
   show the single resource-and-cost review, then finish after my first real Slack
   reply and successful verification. Keep the candidate identity on resume.
   ```

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

The review labels the installation **Unpublished test candidate**. Use fresh test
resources and an appropriate Slack workspace. Each candidate session generates
its own `oregano-test-<session-digest>` connector, so it can coexist with the
ordinary `slack/oregano` installation in the same Vercel team. The reviewed name
is bound to creation, trigger attachment, deployment variables and verification.
It never attaches the test deployment to the existing Oregano connector. A
candidate is not a parallel Preview environment inside an existing production
project. Provider subscriptions,
usage charges, identity consent and the single setup decision still apply.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

On subsequent calls, use the same installer and `--directory` with the ordinary
`--reply` response; `--candidate` is optional after acquisition. Its private receipt
pins the original candidate even if a newer release appears. Switching commit,
archive, platform, or distribution requires a new setup directory. Keep the bundle
for recovery if the installed payload is lost.

::: implementation-example

The generated GitHub workflow checks out the exact candidate commit and installs
its frozen dependency lock. It performs the same Workspace validation, inspection,
security and onboarding checks on the initial `main` push and subsequent PRs,
without looking up a release tag. The client still uses bundled dependencies.
Candidate CI's dependency installation is an intentional test-path difference;
its timing report records `distribution: candidate` and cannot satisfy stable
release timing qualification. Test results do not turn into release evidence by
renaming the report. Promotion to a released Core is a later ordinary change.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

Local installer tests need no database. The real database integration suite needs
an isolated test database with its required bootstrap permissions; this candidate
path does not automatically run those tests or convert skipped tests into passes.

## Maintained lifecycle and resumption

::: implementation-example

The standard flow is the only maintained setup entrypoint. It creates a new
private GitHub Workspace, Vercel project, Neon resource and Slack connector
under one scoped setup decision. Existing resources require their governed
operating change and release process; the installer does not adopt them.
`--profile` and saved live-state schemas 1–4 are rejected before provider work.
Retain old state files as historical receipts. Do not change their schema
number or manufacture fresh authorization to resume them.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

A current live state uses schema 5 and `fresh-initialization`. Resume it with
the same exact installer release and original setup directory. Current account,
plan, declared scope, template and resource evidence are checked again. Name
collisions cannot authorize adoption; interrupted creates need exact receipts.

The flow creates `.companyos/instance.yaml` before the checked initial Workspace
commit. The Artifact build requires that tracked file from the same clean
commit, with the reviewed Instance ID and production environment. No temporary
YAML, CLI override or hosted YAML environment copy supplies build configuration.

::: implementation-example

The state service creates one dedicated PostgreSQL resource. `database prepare`
runs through the host's secret-bound process and records only bounded schema
qualification evidence. Its bootstrap, additive upgrade and verification
operations remain maintained database mechanisms; removing setup receipt
compatibility does not remove database upgrade support.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

Model routes remain selections in the standard session. OpenAI and Anthropic
are the ordinary choices; another supported recipe requires an explicit request.
There is no implicit Gateway fallback. Secrets are entered only into the host's
Sensitive Production settings. Setup checks their presence and classification,
never records their values. The source-host protection attempt records either
`enforced` or `advisory` for this supervised, Tool-free starter.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

Setup compiles an immutable Artifact, deploys under the initial decision,
verifies a provider-confirmed production URL and completes only after an ordinary
authorized Slack message has a delivered model-backed response with matching
persisted evidence. `companyos verify-live` checks current health, exact version
identities, resource receipts, database qualification and the authorized exchange.
The installer never deletes resources automatically.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::
