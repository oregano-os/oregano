# CompanyOS Workbench CLI

This package implements the versioned CompanyOS Workbench command line. Its
scope was pulled forward from Proof Ladder Stage 4 on 2026-08-14 because
multi-contributor Company Workspace governance now requires deterministic checks
before further product development.

Canonical documentation: `docs/workbench/overview.md`.

The CLI is deterministic and non-mutating by default. Commands that create a
plan or generated documentation require an explicit output/generate action.
`companyos onboard` combines the local readiness checks and leaves hosted Git
and Instance actions explicitly assigned to their accountable administrators.
`companyos bootstrap verify` is the local completion boundary used by the
shared Codex and Claude Code runbook as an internal checkpoint; it does not
claim hosted or Instance readiness. The maintained
`companyos setup --profile vercel-neon-slack` state machine then creates or
adopts the explicitly named private GitHub repository, Vercel project, Neon
resource, and Slack connection. It pauses for browser authentication,
checked Steward merge authorization, cost or provider consent, and exact
hash-bound production confirmation. `companyos verify-live` is the final
boundary for that narrow supervised starter scope.

The setup state is non-secret, mode `0600`, and resumable. Provider credentials,
database URLs, Artifact content, and short-lived Slack user credentials are
never stored in it. The initial Oregano Agent has no business Tool grants and
the starter Slack workflow remains supervised.
