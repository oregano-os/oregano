# Contributing to Oregano

Thank you for contributing. Read `AGENTS.md` and `docs/README.md` before making
a change. Core behavior and security changes require a Change Plan under
`.oregano/changes/`, architecture inspection, documentation validation, and
the relevant tests.

Use fictional Company Workspaces and synthetic identifiers in public fixtures.
Do not submit customer material, credentials, private URLs, internal product
plans, or production evidence.

When a change originates from private research or a real Company Workspace,
reimplement only the generic capability on a branch of this repository. Do not
copy the source document or combine Git histories. Review the complete public
diff, run `pnpm public:check` and `pnpm check`, then merge through a pull request.

By submitting a contribution, you agree that it is licensed under Apache-2.0.
