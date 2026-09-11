# CompanyOS Workbench CLI

This package implements the versioned CompanyOS Workbench command line. Its
scope was pulled forward from Proof Ladder Stage 4 on 2026-08-14 because
multi-contributor Company Workspace governance now requires deterministic checks
before further product development.

Canonical documentation: [Workbench overview](../../docs/workbench/overview.md).

The CLI is deterministic and non-mutating by default. Commands that create a
plan or generated documentation require an explicit output/generate action.
`companyos onboard` combines the local readiness checks and leaves hosted Git
and Instance actions explicitly assigned to their accountable administrators.
`companyos bootstrap verify` is the local authoring completion boundary; it
does not claim hosted or Instance readiness. The maintained
[`companyos setup`](../../docs/workbench/commands/setup.md) session creates a
fresh private GitHub repository, Vercel project, Neon resource, and Slack
connection under one scoped setup decision. It checks the initial operating
Workspace commit and completes only after `companyos verify-live` proves the
supervised starter. The retired `--profile` flow and state schemas 1–4 are
unsupported; resume current schema-5 sessions with their exact installer.

The setup state is non-secret, mode `0600`, and resumable. Provider credentials,
database URLs, Artifact content, and short-lived Slack user credentials are
never stored in it. The initial Oregano Agent has no business Tool grants and
the starter Slack workflow remains supervised.
