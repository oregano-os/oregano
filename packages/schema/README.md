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

The first versioned Company Records and Sprint declarations are:

- `company-record-source-v1.schema.json` for provider-neutral source mappings;
- `company-record-projection-v1.schema.json` for rebuildable, access-scoped
  projections; and
- `sprint-domain-v1.schema.json` for company policy consumed by the pure Sprint
  domain.

These schemas intentionally contain logical binding names, not provider
resource identifiers, credentials, grants, or deployment state. Exact
resources and secrets remain Company Instance concerns.
