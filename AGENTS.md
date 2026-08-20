# Agent entrypoint

This file is a bootstrap, not a source of product truth.

Before changing this repository:

1. Read `docs/README.md`.
2. Read `docs/vision.md` and `docs/glossary.md`.
3. Follow `docs/governance/agent-working-agreement.md`.
4. For a new or newly received Company Workspace, read `docs/onboarding/` and
   run `companyos onboard` before proposing operating automation.
5. Create a Core Change Plan under `.oregano/changes/` for behavior or security
   changes.
6. Run `pnpm companyos inspect-core --plan <file>`, `pnpm docs:check`, and the
   relevant checks before handoff.

All engineering artifacts written by Agent Contributors MUST be in English. Runtime
communication may use the language configured by a Company Workspace.

Canonical project documentation lives exclusively under `docs/`. Do not add
architecture, status, or product requirements to this file.
