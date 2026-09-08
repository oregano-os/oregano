---
document_id: command.setup
title: companyos setup
kind: command
status: implemented
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
    - command.create-workspace
    - architecture.company-instance
    - specification.company-instance-release-promotion-v0.1
  implements:
    - onboarding.company-workspace
---

# `companyos setup`

`companyos setup` starts or resumes the standard fresh installation in the
current setup directory. Codex and Claude Code invoke the same entry and render
its events. No required profile, answers, Workspace, or state argument is needed.

```bash
companyos setup --directory /absolute/setup --format json
companyos setup --directory /absolute/setup --reply '<structured response>' --format json
```

The default is GitHub + Vercel Pro/Enterprise + Neon + Slack, with the maintained
release's Gateway model. The command discovers logins and account choices,
derives names/language/timezone/responsibility, asks at most one company-name
field with unambiguous accounts, and shows one editable cost/resource overview.
The `confirm` response to that exact review covers all new resources and the
first production deployment. The session stores the decision privately.

The fresh state is schema `5`, flow `fresh-initialization`. It binds the session,
verified installer, provider scopes, release/template/configuration and costs.
After provider consent, setup creates a complete operating Workspace at version
`0.1.0`, checks its initial commit and attempts hosted protection, then builds,
deploys and verifies. It does not publish an authoring-only baseline or create
an activation PR. A normal first Slack message supplies model-backed persistence
evidence; there is no visible test nonce. Completion includes `verify-live`.

Slack consent uses the current Vercel CLI user without an explicit token subject
and requests only `identity.basic`. The adapter validates the nested team/user
response from Slack `users.identity`; `auth.test` is not that identity contract.
The app Messages link uses validated connector metadata, without requesting an
app-subject token from the personal CLI. Project linking and Neon creation run
in disposable private directories because the provider CLI can generate local
OIDC and skill files even with environment pulling disabled.

Vercel can protect a unique deployment URL even when its production domain is
public. Setup retains the immutable deployment receipt, checks the aliases
reported by its production inspection, and records a health URL only after
its response matches that exact deployment ID and Artifact provenance. It does
not follow login redirects, disable protection, or create bypass credentials.

Slack creation passes `--triggers` as well as attaching the trigger destination.
These are separate provider operations: attaching a destination cannot enable a
connector created without incoming events. The message gate and final verification
re-read forwarding, app identity, production-only attachment and exact route. An
older disabled connector needs explicit repair of its existing configuration;
registering the same destination again or repeating a Slack message cannot fix it.

### Slack delivery recovery

The agent checks steps 1–4 before inviting the first message; the connector
metadata check does not expose Slack's saved URL-verification state. The first
missing exchange returns the ordinary message invitation. If a later
retry still has no verified response, the installer returns a delivery diagnostic
with the exact Slack app settings and Vercel connector links. The agent handles
these technical steps before asking the human to repeat a message:

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

This recovery is a documented provider repair, not a promise that external
provider availability can be guaranteed. A repaired continuation does not
qualify a newly rebuilt installer; qualify that exact bundle with a fresh run.

Events are `input`, `choice`, `review`, `action`, `recovery`, `complete`, and
`cancelled`. Responses are `answer`, `edit`, `confirm`, `retry`, and `cancel`;
see the release runbook for their JSON fields. Revision IDs are machine transport,
not human questions. Ordinary retries reuse the decision; changed scope cannot.
Existing same-name resources are inspected before the review. A later race or
ambiguous creation needs provider evidence, never silent adoption.

The directory's private `.companyos-bootstrap` session is the resume handle.
The same installed release is required. Keep the directory after interruptions.
Local validation is reused only when the generated file digest is unchanged;
live plan, account and deployment evidence is checked at effect boundaries.
For a qualification run, the direct entry also accepts `--started-at <ISO>`,
`--timing-report <file>`, `--harness codex|claude-code`, and `--cache cold|warm`.
A report is written only after live completion. These are maintainer options.

See [Choose a setup](../../onboarding/setup-options.md) for source/release status,
explicit adoption, model variants, and local authoring. The new path is
experimental; live timing qualification is outstanding.

## Test an unpublished candidate

A public release is not required to test a new installer. This explicit maintainer
path uses the same standard setup session, resource review, provider lifecycle,
and first Slack-message verification. The ordinary install prompt still selects
an immutable stable release.

1. Commit the candidate in a clean Core checkout. Push that exact commit to a
   branch in `oregano-os/oregano` before attempting a hosted test: the generated
   Company Workspace check needs to check out that source. No tag, merge, or
   GitHub Release is required. Setup checks source availability before resources
   are created.
2. In that checkout, install its locked dependencies with `pnpm install
   --frozen-lockfile`, using its pinned pnpm. Build on the tester's platform:

   ```bash
   node scripts/build-setup-bundle.mjs /absolute/new-candidate-bundle
   ```

   Keep the resulting `oregano-setup-<platform>.tar.gz` and matching `.json`
   receipt together. The receipt fixes the source commit, platform, archive
   basename and SHA-256. Acquire the installer script from the same trusted
   checkout; a local checksum establishes consistency, not publisher identity.
3. Have Codex or Claude Code start it in a new setup folder:

   ```bash
   node /absolute/exact-core/scripts/install-companyos.mjs \
     --candidate /absolute/new-candidate-bundle/oregano-setup-<platform>.json \
     --directory /absolute/new-test-setup \
     --started-at <prompt-received-ISO-time>
   ```

   Both harnesses can use this prompt with the concrete paths filled in:

   ```text
   Test this unpublished Oregano candidate using the candidate instructions in
   docs/workbench/commands/setup.md from its exact Core checkout. Use the supplied
   bundle receipt and a new setup directory. Follow the standard setup events,
   show the single resource-and-cost review, then finish after my first real Slack
   reply and successful verification. Keep the candidate identity on resume.
   ```

The review labels the installation **Unpublished test candidate**. Use fresh test
resources and an appropriate Slack workspace. Each candidate session generates
its own `oregano-test-<session-digest>` connector, so it can coexist with the
ordinary `slack/oregano` installation in the same Vercel team. The reviewed name
is bound to creation, trigger attachment, deployment variables and verification.
It never attaches the test deployment to the existing Oregano connector. A
candidate is not a parallel Preview environment inside an existing production
project. Provider subscriptions,
usage charges, identity consent and the single setup decision still apply.

On subsequent calls, use the same installer and `--directory` with the ordinary
`--reply` response; `--candidate` is optional after acquisition. Its private receipt
pins the original candidate even if a newer release appears. Switching commit,
archive, platform, or distribution requires a new setup directory. Keep the bundle
for recovery if the installed payload is lost.

The generated GitHub workflow checks out the exact candidate commit and installs
its frozen dependency lock. It performs the same Workspace validation, inspection,
security and onboarding checks on the initial `main` push and subsequent PRs,
without looking up a release tag. The client still uses bundled dependencies.
Candidate CI's dependency installation is an intentional test-path difference;
its timing report records `distribution: candidate` and cannot satisfy stable
release timing qualification. Test results do not turn into release evidence by
renaming the report. Promotion to a released Core is a later ordinary change.

Local installer tests need no database. The real database integration suite needs
an isolated test database with its required bootstrap permissions; this candidate
path does not automatically run those tests or convert skipped tests into passes.

## Explicit advanced and legacy flow

The following contract is retained for existing states, deliberate adoption,
and explicit model choices. It is not part of the standard setup interview.
State versions 1–4 keep their existing authorization requirements; `setup`
never converts them to the fresh variant. Other infrastructure combinations
are not executable profiles yet.

The first maintained live profile extends the plugin-free Codex and Claude Code
runbook from a locally verified authoring Workspace to one supervised starter
Instance:

```bash
companyos setup \
  --profile vercel-neon-slack \
  --workspace <path> \
  --answers <yaml-or-json> \
  --state <file> \
  --plan \
  --format json

companyos setup \
  --profile vercel-neon-slack \
  --workspace <path> \
  --answers <yaml-or-json> \
  --state <file> \
  --apply <plan-confirmation-hash> \
  --format json

companyos setup \
  --profile vercel-neon-slack \
  --state <file> \
  --resume \
  [--operating-confirmation <hash>] \
  [--merge-confirmation <hash>] \
  [--production-confirmation <hash>] \
  --format json

companyos setup \
  --profile vercel-neon-slack \
  --state <file> \
  --status
```

`--plan` is read-only. It validates the exact release checkout, authoring
Workspace, bounded answers, resource modes, intended
provider mutations, costs and consent gates, rollback boundary, and state-file
placement. The returned hash binds the complete plan.

`--apply` creates a mode-0600 non-secret state file and advances until a browser
login, provider consent, exact operating-Workspace
confirmation, merge authorization, production confirmation, or Slack test is
required. A Hobby team first requires an upgrade in Vercel. `--resume` uses
that same evidence rather than chat history. A failed
or interrupted command does not delete resources and must not be replaced by a
second setup state.

Before each external create, setup records a non-secret write-ahead intent.
The immutable provider receipt is then stored immediately. Resume reconciles a
pending intent by provider identity and never repeats a create merely because a
name search is temporarily stale. Existing resources and production variables
without an Oregano receipt are treated as conflicts and are left unchanged.

The starter keeps the original human as its only Workspace Steward. The
installer binds that person's verified Slack principal to the existing roster
entry and never requests, creates, or invites a second reviewer.

## Maintained profile

`vercel-neon-slack` performs these bounded phases:

1. verify Git, GitHub CLI, the repository-pinned exact pnpm, Vercel CLI, and the
   maintained Vercel Runner;
2. authenticate Vercel when needed and automatically verify Pro or Enterprise
   on the selected team before any hosted resource creation, then authenticate
   GitHub in the browser;
3. initialize and push a private Company Workspace repository;
4. detect and preserve protection on an adopted GitHub repository, or
   automatically apply the solo-Steward protected `main` baseline to a new
   repository when available, recording either `enforced` or `advisory`
   without an upgrade prompt;
5. create or adopt the exact Vercel project and verify the
   maintained `packages/runner-vercel` Next.js root without changing a
   conflicting adopted project;
6. bind one explicit model recipe: use Vercel AI Gateway without a provider
   key, or pause for browser-only entry of the selected native or named
   compatible cloud provider key as a Sensitive Production variable and verify
   only its name, presence, and Sensitive classification;
7. create or adopt a Neon Marketplace resource without pulling its connection
   string to disk;
8. run `companyos database prepare` through the Vercel profile's
   non-persisting `vercel env run` process, select `bootstrap` for an absent
   database, `upgrade` for an existing older database, or `verify` for an
   already current database, and store only the read-only qualification
   receipt;
9. create or adopt a Slack Vercel Connect resource and attach the verified
   `/api/webhooks/slack` trigger;
10. pause for a browser authorization with only `identity.basic`, request a
   short-lived Slack user token, call `auth.test`, retain only the canonical
   team and user IDs, and discard the credential;
11. preview and apply one supervised, Tool-free Oregano Agent and Slack workflow;
12. push the operating change through a required-check pull request and obtain
    the Workspace Steward's exact merge confirmation;
13. build one immutable production Artifact from clean exact Core and Workspace
    commits and create its Vercel environment values without `--force` or
    overwriting pre-existing production configuration;
14. recheck the Vercel plan and deploy only after the exact production-candidate
    confirmation, retain the
    structured deployment receipt, wait for provider readiness, and poll the
    provenance health endpoint through temporary non-JSON responses; and
15. require a nonce-bound Slack message, a real selected-model response,
    non-secret model execution evidence, and the persisted assistant response
    in Neon before completion.

`companyos database prepare` detects the database baseline before mutation and
reports `bootstrap`, `upgrade`, or `verify`. `companyos database bootstrap` is
the explicit low-level additive operation; setup uses `prepare` so an adopted
database is never reported as a first installation. `companyos database
verify` is read-only. All commands consume the
bound `DATABASE_URL` only from their process environment. They return a bounded
qualification receipt containing the manifest identity and digest, exact table
counts, Core Page-type count, optional feature availability, and timestamp;
they never return the connection value. Runtime health invokes verification,
not bootstrap.

The current additive target is `companyos-postgres@1.9.0`. It retains the
immutable `1.8.0`, `1.7.0`, `1.6.0`, `1.5.0`, `1.4.0`, `1.3.0`, `1.2.0`, `1.1.0`, and `1.0.0` predecessors, qualifies 67 required
`companyos_knowledge` tables and 14 required `companyos_records` tables, and prepares durable Source event, ACL, receipt,
watermark, synchronization-lease, change-stream, lifecycle, compounding,
Claim-pair-proposal, grading-request, model-result-cache, spend-reservation,
execution-ledger, Retrieval V3 projection, benchmark, shadow-comparison,
productization-receipt, and atomic Sprint event, state, decision, and intent
state in addition to the fail-closed
authorization foundation. Setup does not treat that schema receipt as
permission to expose content; runtime authorization and Source ACL mapping
remain separate conformance gates.

On 2026-08-26 the linked `oregano-hq-companyos` Instance applied the additive
manifest through its production SecretRef transport and then passed a separate
read-only verification. The current run produced manifest digest
`6c0b3366540c8b1c0a3d889ef8c180c32d15d4e1bb92dbbbd8b10e94ddbce16c`,
12 Control tables, 55 required Knowledge tables plus the optional vector table,
and all 19 Core Page types. A subsequent `database verify` qualified `1.4.0`
while preserving every immutable predecessor through `1.3.0`.

On 2026-08-27 the same linked Instance applied additive manifest `1.5.0` and
passed separate read-only qualification with digest
`bb3dcef272ce2c33ae1a479171a648ea6e79ab01b04ca37dce998a5e0e404cea`,
12 Control tables, 59 required Knowledge tables plus the optional vector table,
and all 19 Core Page types. Every predecessor through `1.4.0` remains in the
immutable manifest ledger.

Later on 2026-08-27 the linked Instance applied additive manifest `1.6.0` and
passed separate read-only qualification with digest
`b9ba518e64d39e754e917348dd67b2bad7aa200d533af8343fba0c6f3774c4b1`,
12 Control tables, 62 required Knowledge tables plus the optional vector table,
and all 19 Core Page types. Every predecessor through `1.5.0` remains in the
immutable manifest ledger.

The command contract is independent from Vercel. A different qualified setup
profile wraps the same logical preparation command with its own secret-injection
mechanism. The current maintained implementation and live profile are qualified
for Neon/Postgres; another PostgreSQL driver requires separate conformance
evidence before being advertised as supported.

Create and adopt are explicit per resource. The setup refuses a create-name
collision and refuses adoption when the named resource cannot be found. It does
not delete, replace, transfer, or silently reuse an external resource.

The starter Agent has no business Tool grants and its workflow is supervised.
This narrow initial-installation profile is not the general Preview or Effect
Lane orchestrator. It records readiness as `validated`, not globally
`enforced`, and does not authorize an unattended workflow or external business
effect.

GitHub Free is sufficient. Hosted branch protection is useful defense in depth
and is applied automatically when supported, but it is not a second setup mode
or a completion requirement for this starter. Existing stricter organization
controls remain unchanged. Hosted enforcement must be established separately
before a later capability grants an unattended agent repository write, merge,
or deployment authority.

## Vercel plan prerequisite

The concrete profile requires Pro and also accepts Enterprise. The read-only
plan reports this prerequisite without reading a provider account. Execution
resolves the exact selected team via the Vercel API and reads `billing.plan`.
It records only team ID, slug, plan, and check time under
`resources.vercel_plan`. API response bodies and billing details are not
stored or printed. Resuming setup rechecks the plan before further resource
work; production deployment checks again, and `verify-live` uses fresh evidence.

Pro and Enterprise introduce no human gate. Hobby returns
`next_action.type: upgrade-vercel-plan` with that team's billing URL. The
human upgrades in Vercel and resumes the same state; Oregano never changes a
subscription. Unreadable, missing, or unknown plan evidence returns
`verify-vercel-plan` for access/plan correction, without assuming Hobby. The
phase and confirmed setup plan are preserved while waiting.

This also applies when resuming older setup states or verifying an older
completed state. An old success receipt does not bypass the current check.
There is no `vercel_plan` answer or cron-frequency question. Oregano owns the
profile's schedules; the maintained flow offers no Hobby scheduler fallback.

## Answer contract

The answers file contains non-secret company and resource-selection data only:

```yaml
change_date: "2026-08-20"
steward_email: anna@example.com
github_owner: example-company
github_repository: companyos
github_account_type: organization
github_repository_mode: create
vercel_scope: example-company
vercel_project: example-companyos
vercel_project_mode: create
neon_resource_name: example-companyos-db
neon_resource_mode: create
neon_plan: free_v3
neon_region: fra1
slack_connector_name: oregano
slack_connector_mode: create
slack_channel_id: ""
model_route: vercel-ai-gateway
model_credential_mode: platform
model: openai/gpt-5.4-nano
```

The example is a schema illustration, not default company data. Passwords,
provider credentials, database URLs, private keys, resolved Artifact content,
and short-lived Slack tokens are rejected from setup state.

Supported `model_route` values are generated from the maintained recipe registry
into the release manifest. Native recipes include `vercel-ai-gateway`,
`anthropic-direct`, `openai-direct`, and `google-direct`; named compatible cloud
recipes require their own exact release/provider qualification. Gateway requires `model_credential_mode: platform`. A direct
route requires a matching `provider/<model>` value and either `configure` or
`adopt`. In `configure` mode, setup opens the provider's key page and the
Vercel Environment Variables page, then waits while the human enters the key
under the recipe's documented Sensitive Production variable. In `adopt` mode,
setup requires that variable to exist and does not read or change it. Direct
routes bypass AI Gateway; Vercel remains only the runtime host and secret store.

For compatibility with setup answer files created before this selection
existed, omitting both `model_route` and `model_credential_mode` preserves the
former `vercel-ai-gateway` plus `platform` behavior. The explicit advanced flow records both fields. The standard flow derives them
from the release defaults without asking a model question. Deployment
materializes that answer as the default binding in
`COMPANYOS_MODEL_CONFIG_BASE64` and also retains the simple route/model
variables for compatible Runners.

The qualified Neon values in this example are provider identifiers, not a
promise about price or availability. Setup must show the current provider plan,
region, terms, and possible charges before consent. The maintained Slack
profile reserves connector name `oregano`; this keeps the installed Agent's
visible Slack name independent of the Company Workspace name. Provider resource
IDs remain separate and are recorded only in Instance setup evidence.
