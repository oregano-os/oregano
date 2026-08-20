# state-postgres — Neon/Postgres implementation

Implements `state-store/interface.ts` against the isolated `companyos` schema in
`schema.sql`. Effect claims use a unique idempotency key; approval consumption
and effect claiming are one atomic database operation. The schema also contains
generic Chat SDK state and published-artifact storage used by the maintained
Vercel Runner. It contains no company or paid-provider business tables.
