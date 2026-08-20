# schema — Which files and fields are valid?

**Trigger: validation control plane (active since 2026-08-14).** The former
Stage 4 restriction no longer applies to validation. The first executable
rules currently live in `packages/cli`; reusable versioned schemas graduate
into this package when their contracts stabilize.

Machine definitions cover the convention: mandatory frontmatter, contracts,
roster references, governance, and risk defaults.

CompanyOS validation enforces repository conventions through declarative
contracts, JSON Schemas, deterministic documentation checks, and invariant
tests. This package remains the graduation point when internal schemas become
stable reusable public contracts.
