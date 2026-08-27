---
document_id: guide.review-company-knowledge
title: Review Company Knowledge
kind: guide
status: building
authority: canonical
language: en
updated: 2026-08-25
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - specification.company-knowledge-v0.1
---

# Review Company Knowledge

Run `companyos knowledge review .` to preview at most three raw candidates.
Quarantined candidates require manual handling and remain outside active
knowledge. Check sources, duplicates, contradictions, freshness, intended
route, and access policy. Persisted candidate content is visible only to an
active human in the `companyos:knowledge-admin` roster group. Record an
attributable accept, reject, or supersede decision with that same subject.

An accepted candidate is only an authoring proposal. Review the resulting OKF,
Skill/Playbook, or Learning diff through normal Workspace governance. Merge it,
build a new bundle, verify the staged snapshot, and activate it explicitly.
For restricted content, add a negative retrieval, exact-get, and graph test for
every role that must not see it before activation. Review never widens inherited
Source policy; unresolved provider ACLs remain quarantined.
