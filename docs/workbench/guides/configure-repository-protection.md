---
document_id: guide.configure-repository-protection
title: Configure Repository Protection
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-23
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Configure Repository Protection

Local governance files describe the intended Git workflow and hosted-hardening
baseline. The maintained setup has one path: it always creates or adopts a
private repository, follows a checked pull-request process, and automatically
applies the following controls to `main` when GitHub supports them:

1. require a pull request before merging;
2. require zero GitHub approvals in the default `steward` review mode;
3. keep CODEOWNERS for ownership routing without making its review mandatory;
4. dismiss approvals when new commits change the reviewed diff;
5. require the `check` status from the expected GitHub Actions source;
6. require all review conversations to be resolved;
7. block force pushes and branch deletion;
8. grant no ruleset bypass to Human Contributors, Agent Contributors,
   deployment keys, or contributor bots.

The pull request, required check, and explicit Steward confirmation remain part
of the installer whether hosted enforcement is available or not. When GitHub
enforces the baseline it additionally protects history from accidental direct
pushes, force pushes, and deletion. An organization may explicitly select
`independent-review`; that review policy requires exactly one CODEOWNER approval
and declares `two_person_review: true` for security changes.

## One GitHub installation path

Every Human Contributor uses an individual GitHub account. A Platform
Administrator with `repository` scope needs admin access to the private Company
Workspace repository; the company or its appointed custodian must retain
billing and account recovery. Do not use a shared developer account.

GitHub Free is sufficient for the Tool-free supervised starter. The installer
does not ask the human to choose a protection mode or upgrade a plan. It first
reads existing hosted protection. A baseline that is at least as strict is
accepted unchanged. Any other existing provider policy is also left unchanged
rather than overwritten. An adopted repository is never mutated by this
hardening step. For a newly created repository without protection, the
installer attempts the solo-Steward baseline once.

The resulting status is evidence, not configuration selected by the user:

- `enforced` means GitHub reports the baseline or stricter controls as active;
- `advisory` means GitHub did not expose or confirm the requested controls, so
  the installer continues with its checked pull request and explicit Steward
  merge evidence; and
- `pending` means the external attempt has not yet been checked.

Professional organizations may enforce equivalent or stricter rules centrally.
Oregano detects and respects them. Hosted enforcement becomes mandatory before
an unattended agent receives repository write, merge, or deployment authority;
it is not a completion requirement for the supervised starter.

## Review modes

The generated Workspace declares `review_mode: steward`. Its protection
contract sets `required_approvals: 0`, `require_code_owner_review: false`, and
`bypass: none`. The Steward supplies CompanyOS authority through the recorded
Change Plan and the installer's explicit merge confirmation. GitHub supplies
mechanical evidence that the pull request and required check passed.

For a company that deliberately wants separation of duties, set
`review_mode: independent-review`, appoint the additional authorized person,
declare `two_person_review: true` and
`review_model: author-plus-one-independent-reviewer` on the security class, and
change repository protection to one required CODEOWNER approval. Change all of
these fields together through a security-class Change Plan. A second account
controlled by the same person is not independent.

Neither review mode grants a ruleset bypass. When hosted protection is active,
direct pushes, force pushes, and branch deletion remain blocked.

The intended baseline is also declared in
`.companyos/repository-protection.yaml`. `companyos validate`, `companyos
security`, and `companyos onboard` reject a weaker declared process. This keeps
the checklist, documentation, and CI contract aligned; it still does not turn
a repository file into proof of hosted enforcement.

## Who does what

- A Human Contributor or Agent Contributor may prepare CODEOWNERS, CI, the
  machine-readable protection contract, and the Change Plan.
- The maintained setup attempts hosted protection through the authenticated
  Platform Administrator only after the external setup plan is confirmed.
- The Workspace Steward supplies business authority for protected Workspace
  changes. GitHub administration alone does not grant that authority.
- The Workbench reports the hosted result as separate evidence. Validation never
  presents a local file as proof that GitHub enforces it.

## Optional manual hardening

No manual action is required during the maintained starter. A Platform
Administrator may establish or repair hosted enforcement later through an
organization policy, GitHub ruleset, branch protection UI, or REST API. After
the branch contains the required `check` workflow:

1. Open the repository's **Settings → Rules → Rulesets** page.
2. Create one branch ruleset, name it `CompanyOS main protection`, set it to
   active, and target the default branch `main`.
3. Enable the baseline rules listed above. Select the status check named
   exactly `check` from the expected GitHub Actions source.
4. Leave the bypass list empty for Contributors, administrators, bots, and
   deployment keys.
5. Save the ruleset, open a test pull request, and verify that a red or absent
   `check` prevents merge. In `independent-review` mode, also verify that the
   missing CODEOWNER approval prevents merge.
6. Record `verification.status`, `checked_at`, and `checked_by` in
   `.companyos/repository-protection.yaml` through the normal checked pull
   request process.

### Exact GitHub UI settings

Use these values for the current reference configuration:

- **Ruleset name:** `CompanyOS main protection`
- **Enforcement status:** `Active`
- **Target branches:** `Include default branch` (`main`)
- **Bypass list:** empty.
- **Restrict deletions:** enabled
- **Require a pull request before merging:** enabled
  - required approvals: `0` for `steward`, `1` for `independent-review`
  - dismiss stale approvals on new commits: enabled
  - require review from Code Owners: disabled for `steward`; enabled for
    `independent-review` when exposed by the plan/UI
  - require approval of the most recent reviewable push: disabled for this
    baseline
  - require conversation resolution: enabled
- **Require status checks to pass:** enabled, with the check named exactly
  `check`; require the branch to be up to date when GitHub offers that option
- **Block force pushes:** enabled

Leave restrict creations, restrict updates, deployment success, signed commits,
specific-team reviews, code scanning, code quality, code coverage, and automatic
Copilot review disabled unless a later approved policy explicitly adds them.
Deployment success must not be required when the production deployment starts
only after merging to `main`, because that would create a circular gate.

The maintained setup uses `PUT
/repos/{owner}/{repo}/branches/main/protection` for a new baseline. Keep the
bypass actor list empty and map the remaining YAML rules one-for-one. Read the
saved protection back through the API and run the same test pull request before
recording `verification.status: enforced`. If GitHub does not make hosted
protection available, record `verification.status: advisory`; do not block the
supervised starter, make the repository public, or ask for a plan upgrade.

If the repository belongs to a personal GitHub account, CODEOWNERS maps to the
Steward account. A visible organization team is useful once the repository
moves into an organization because role membership can then change without
editing every protected path.

## CODEOWNERS mapping

`CODEOWNERS` maps paths to GitHub users or teams; it does not create CompanyOS
authority. Protected Workspace paths normally map to a visible team that
represents the relevant Workspace Stewards. Process-specific paths may later
map to Process Steward teams. A Platform Administrator with `repository` scope
configures this mapping but does not gain business approval authority from
administration.

GitHub accepts an approval from any one owner listed for a path, so listing two
owners on one line does not require both of them. Protect `.github/` itself so
the proposal author cannot replace `CODEOWNERS` or CI without the same governed
pull request and required check.

## Additional Instance protection

Protect the production deployment environment separately and restrict its
secrets to the deployment identity and Platform Administrators with `instance`
scope. This is defense in depth, not a reason to complicate the initial branch
ruleset.

A Platform Administrator with `repository` scope records the verification time
and identity through the checked proposal process. `companyos security` checks
the local half and deliberately reports hosted enforcement as separate
evidence.

Official references: [GitHub ruleset rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
[GitHub branch protection REST API](https://docs.github.com/en/rest/branches/branch-protection), and
[GitHub CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).
