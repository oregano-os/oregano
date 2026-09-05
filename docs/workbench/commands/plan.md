---
document_id: command.plan
title: companyos plan
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-09-05
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# `companyos plan`

Creates or validates a machine-readable Change Plan.

```bash
companyos plan --output change-plan.yaml --placement workspace
companyos plan --output .oregano/changes/change.yaml --placement core
companyos plan --check change-plan.yaml
```

Creating a plan is the only mutating action and refuses to overwrite an
existing file. The generated template is Change Plan version 3:

```yaml
version: 3
plan_id: ""
created: "2026-09-05"
title: ""
objective: ""
non_goals: []
placement: core
change_class: behavior
files_expected: []          # exact paths or bounded globs; packages/** is rejected
tests: []                   # real test file paths, checked for existence
documentation_impact:
  required: true
  affected_documents: []    # document IDs that the same diff must change
  reason_if_none: ""
architecture:               # required for Core behavior and security plans
  placement: { core: "", packages: "", workspace: "", instance: "" }
  mechanisms_extended: []   # only extended mechanisms; all others are reused
  new_core_mechanisms: []
  boundary_assertions:
    company_values_in_core: false
    secrets_in_git: false
    public_fixtures: synthetic-only
  core_reusability: ""
rollback: ""
```

A version 3 plan has no `status`, `author`, `approvals`, `required_approvals`,
or `validation` field, and `--check` rejects them. The pull request that
carries the plan is the approval; its merge through the required CompanyOS
check is the implementation record. Validation commands are the repository's
own `pnpm check`. Unknown fields are rejected so the format cannot grow back.

`proposal: true` marks a plan that describes work not contained in the same
pull request. Core inspection then allows only plan and documentation files in
the diff. The flag is removed by the pull request that ships the
implementation.

Version 1 plans dated on or before 2026-08-31 and version 2 plans dated on or
before 2026-09-05 remain valid historical evidence and are not rewritten.
