# Install Oregano with Codex or Claude Code

This release-matched runbook supports Codex and Claude Code without a plugin.
The standard installer creates a private GitHub company repository, Vercel
Pro/Enterprise runtime, Neon database, and Oregano in Slack. It is experimental;
five minutes is a qualification target, not an achieved timing claim. Use the
[setup choices](docs/onboarding/setup-options.md) for existing resources,
advanced model recipes, or local authoring.

## Start the verified installer

The agent performs these steps. The human does not type terminal commands.
Record the time the start prompt was received, before downloads or tool setup.
Use one absolute, empty setup directory outside Oregano Core.

1. Resolve `https://api.github.com/repos/oregano-os/oregano/releases/latest`
   once. Require a published, non-prerelease, immutable Release and retain its
   numeric ID. Download its `release-manifest.json` using that Release's asset
   URL. Verify the bytes against the API asset's SHA-256 `digest`.
2. Require manifest schema `1`, stable status, an exact tag/version pair and
   40-character Core commit. Download `install-companyos.mjs` from the same
   Release and check its SHA-256 against
   `checksums["install-companyos.mjs"]`. Save it in the private setup directory;
   never execute a network stream directly.
3. Reuse Git, Node.js 24+, and GitHub CLI. Install a missing prerequisite with
   the platform's ordinary supported package manager when the host permits it.
   Do not ask an additional Oregano permission question for routine tool setup.
   Actual host-enforced permission requests remain the host's responsibility.
4. Invoke the verified installer with absolute paths, the recorded start time,
   and the exact numeric Release ID:

   ```bash
   node /absolute/setup/install-companyos.mjs \
     --directory /absolute/setup \
     --release-id <verified-release-id> \
     --started-at <prompt-received-ISO-time>
   ```

The installer verifies and acquires that platform's checksummed payload. It
contains exact Core source, Workbench, the required dependencies and pinned
Vercel/pnpm tooling. The standard client does not run a developer dependency
installation or replace a global package manager. The payload's available
platforms are in `setup_bundles`; no matching bundle means that platform is
not supported by this release's standard installer. Use the documented source
path deliberately, rather than silently falling back to a slower installation.

## Explicit unpublished test path

When the human explicitly requests a candidate test, follow
[the unpublished candidate instructions](docs/workbench/commands/setup.md#test-an-unpublished-candidate)
from the exact trusted Core checkout. Use its local bundle receipt with
`install-companyos.mjs --candidate <receipt> --directory <new-test-setup>`.
No public release or release tag is required; the exact source commit must be
available on GitHub for the first Workspace check. Display the candidate label
and automatically generated test-connector name in the single setup review.
Candidate sessions use a separate Slack connector even in an existing team. Resume the same acquired candidate and directory.
The normal release prompt above does not select an unpublished candidate.

## Let the CLI own the conversation

Render the returned event in the human's language. Keep technical identifiers,
revision hashes, local paths, and provider commands internal. Both harnesses
use the same session and event contract:

| Event | Agent action |
|---|---|
| `input` | Ask the company name, the only required free-text field when account selection is clear. |
| `choice` | Show actual account choices when ambiguous. For `model_provider`, ask **OpenAI or Anthropic** with no preselection, unless the human already explicitly supplied that choice. |
| `review` | Show the complete editable company, responsible person, GitHub/Vercel destination, database region, model and costs summary. Offer **Set up**, **Edit**, or **Cancel**. The single decision includes creating the listed new resources and the first production deployment. |
| `action` | Perform the returned routine action, open the required provider login/consent, or wait for the provider/check. Ask only for the human interaction that is actually necessary. |
| `recovery` | Explain the concrete problem, resolve it within the approved scope and retry the same session. Do not delete resources or invent receipts. |
| `complete` | Say Oregano is ready and show the returned Slack link. Detailed evidence is available when requested. |

Return answers using the same downloaded installer and directory with
`--reply '<JSON response>'`. The response is `{"action":"answer","values":{...}}`,
`{"action":"edit","values":{...}}`, `{"action":"confirm","revision":"..."}`,
`{"action":"retry"}`, or `{"action":"cancel"}`. Use a structured process
argument or correct shell quoting; never concatenate an answer into shell code.
For provider answers, use `values: {"model_provider":"openai"}` or
`values: {"model_provider":"anthropic"}`. Use the returned recipe model without
another question. Other models or providers are available only on explicit
request through `model` and/or a maintained `model_route`; do not add an Other
menu item or infer the provider from the coding agent or account logins. Gateway
is never selected automatically. The summary binds the direct provider, exact
model, pricing and Sensitive Production key destination. Handle the existing
`browser-secret-entry` action by opening its provider key page and Vercel page;
the human enters the API key there. Keep the key out of chat and local files.

The agent passes the returned revision only after the human selects Set up.
There is no unattended `yes` shortcut. Edit changes the review; a stale reply
cannot authorize a different setup. Repeating a response resumes the same
installation. No answers YAML, Workspace creation confirmation, activation PR,
merge confirmation, or second deployment confirmation belongs in this path.

For pending checks and provider receipts, wait with bounded backoff and submit
`retry`; do not ask the human to approve each wait or run technical commands.
Before inviting the first message, the agent checks Slack's saved Request URL
using steps 1–4 of [Slack delivery recovery](docs/workbench/commands/setup.md#slack-delivery-recovery).
Then open the returned Slack link and invite the human to send an ordinary first
message. No test phrase, nonce, channel ID, or copied response is required.
If a reply remains unverified, follow the returned delivery diagnostic and
[Slack delivery recovery](docs/workbench/commands/setup.md#slack-delivery-recovery)
before requesting another message. Use the browser where the human actually
signed into the selected Slack workspace. Vercel synchronization success does
not prove Slack URL verification: require Events On, the exact Connect intake
URL, `Verified`, `Save Changes`, and verification after reload. Never substitute
a URL challenge or a manually posted bot message for the real model reply.

## Accounts, consent, and completion

Vercel Pro is required; Enterprise also works. The installer reads the selected
team's plan automatically. Hobby returns the team's billing link and waits for
an upgrade by the human. Oregano never purchases or changes a subscription and
never asks about cron frequency. Scheduling is supplied by the release.
GitHub Free is sufficient; hosted protection is applied when available and
reported separately. Slack installation and identity consent occur in provider
flows. The original Workspace Steward is the authenticated installer shown in
the summary; the verified Slack identity is bound during that person's consent.
Credentials stay in provider flows and secret processes, outside chat and Git.
The Slack identity step uses the consenting CLI user with `identity.basic`;
the app entry link comes from verified connector metadata. Opening that link
is not completion evidence: the real reply and final verification must pass.
The health check uses a provider-confirmed production alias and verifies the
exact deployment ID; leave deployment protection enabled. Before inviting the
human to message Slack, setup verifies that incoming trigger forwarding is
enabled for the exact production project and webhook route.

The CLI generates the complete supervised, Tool-free operating Workspace as its
first version, including the non-secret `.companyos/instance.yaml` beside
its governance and compatibility files. The deployment build consumes that
committed declaration; setup state and secrets remain separate. See the
[format and migration reference](docs/reference/instance-configuration.md).
It checks the exact initial commit, prepares the database, builds
and deploys the Artifact, verifies health, and correlates the human's first
message with a real model response and persistence. It invokes
`companyos verify-live` internally. Announce completion only for `complete`;
local `companyos bootstrap verify` alone does not prove a live installation.

The Handbook remains ordinary Workspace Markdown. Setup provisions control,
Workflow and Records state under database manifest `companyos-postgres@3.0.0`.
It creates no Knowledge service or special Handbook roles. Existing Instances
use the [retirement procedure](docs/workbench/guides/retire-knowledge.md).

Later business capabilities and automation follow their own
change process. Only current schema-5 fresh setup sessions can resume. Retired schemas 1–4
and the old `--profile` installer are unsupported; retain their historical
receipts and never convert them into fresh setup authority.

## Qualification and source installation

Release CI builds the platform payloads and tests their executables. Live
qualification must still measure at least five cold runs per harness on each
advertised platform, starting with the original prompt. Include downloads,
provider interaction, GitHub checks, deployment, and the real Slack reply.
See the [implementation plan](docs/plans/2026-09-08-five-minute-setup.md) for the
acceptance criteria and timing report procedure.

Developers and advanced users can instead fetch one verified exact release,
install its locked dependencies with the exact `packageManager` pin, and invoke
`companyos setup` from that checkout. This is explicitly a source installation;
it is not substituted into a timed release-payload run.
