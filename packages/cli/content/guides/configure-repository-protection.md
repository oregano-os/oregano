---
document_id: guide.configure-repository-protection
title: Configure Repository Protection
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-21
owners:
  - core-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Configure Repository Protection

Local governance files describe required controls; a Platform Administrator
with `repository` scope enforces them on the Git host. The normal Company
Workspace baseline is one active branch ruleset targeting `main` with these
controls:

1. require a pull request before merging;
2. require zero GitHub approvals in the default `steward` review mode;
3. keep CODEOWNERS for ownership routing without making its review mandatory;
4. dismiss approvals when new commits change the reviewed diff;
5. require the `check` status from the expected GitHub Actions source;
6. require all review conversations to be resolved;
7. block force pushes and branch deletion;
8. grant no ruleset bypass to Human Contributors, Agent Contributors,
   deployment keys, or contributor bots.

This baseline lets one Workspace Steward operate CompanyOS alone while retaining
a pull request, a required check, explicit merge confirmation, and protected
history. An organization may explicitly select `independent-review`; that mode
requires exactly one CODEOWNER approval and declares `two_person_review: true`
for security changes.

## GitHub account and plan prerequisite

Every Human Contributor uses an individual GitHub account. A Platform
Administrator with `repository` scope needs admin access to the private Company
Workspace repository; the company or its appointed custodian must retain
billing and account recovery. Do not use a shared developer account.

GitHub's documented private-repository paths are:

- a personal repository on GitHub Pro for an initial personal-account setup; or
- an organization repository on GitHub Team or Enterprise for visible teams,
  delegated administration, and the preferred multi-person operating model.

The provider's actual enforcement result is authoritative. A saved ruleset and
`Active` label are insufficient while GitHub displays a banner saying the rule
will not be enforced. Keep verification `blocked` until the banner is gone and
an adversarial test pull request proves enforcement. Never make a Company
Workspace public merely to avoid a plan prerequisite.

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

Neither mode permits a ruleset bypass. Direct pushes, force pushes, and branch
deletion remain blocked.

The desired baseline is also declared in
`.companyos/repository-protection.yaml`. `companyos validate`, `companyos
security`, and `companyos onboard` reject a weaker local declaration. This
keeps the checklist, documentation, and CI contract aligned; it still does not
turn a repository file into proof of hosted enforcement.

## Who does what

- A Human Contributor or Agent Contributor may prepare CODEOWNERS, CI, the
  machine-readable protection contract, and the Change Plan.
- A Platform Administrator with `repository` scope applies the ruleset in
  GitHub because that action changes hosted access control.
- The Workspace Steward supplies business authority for protected Workspace
  changes. GitHub administration alone does not grant that authority.
- The Workbench checks the local half and reports the hosted step as `manual`.
  An explicit administrator action may use the GitHub UI or REST API; validation
  never silently uses a developer's GitHub credentials.

## Activate the ruleset in GitHub

After the protected branch contains the required `check` workflow:

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
6. Record the ruleset ID, verification time, and Platform Administrator acting
   with `repository` scope in `.companyos/repository-protection.yaml` through a
   protected pull request.

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

The equivalent REST operation is `POST /repos/{owner}/{repo}/rulesets`. Keep
the bypass actor list empty and map the remaining YAML rules one-for-one. Read
the saved ruleset back through the API and run the same test pull request before
changing `verification.status` to `verified`.

GitHub rulesets for a private repository require a GitHub plan that supports
private-repository rulesets. A provider refusal is an external onboarding
blocker; record `verification.status: blocked` with the provider reason, check
time, and administrator identity. Never make a company repository public merely
to avoid it.

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
the proposal author cannot replace `CODEOWNERS` or CI without the same review.

## Additional Instance protection

Protect the production deployment environment separately and restrict its
secrets to the deployment identity and Platform Administrators with `instance`
scope. This is defense in depth, not a reason to complicate the initial branch
ruleset.

A Platform Administrator with `repository` scope records the configured ruleset
identifier and verification date outside the mutable proposal branch.
`companyos security` checks the local half and deliberately reports that hosted
enforcement still requires external verification.

Official references: [GitHub ruleset rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
[GitHub ruleset REST API](https://docs.github.com/en/rest/repos/rules), and
[GitHub CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).
