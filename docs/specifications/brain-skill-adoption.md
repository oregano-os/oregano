---
document_id: specification.brain-skill-adoption
title: Experimental Brain Skill adoption and prompt qualification
kind: specification
status: draft
authority: canonical
language: en
updated: 2026-09-14
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# Experimental Brain Skill adoption and prompt qualification

This increment prepares reusable instruction assets and trusted generation
bindings. Brain storage, operations, import workflows and source delivery are
not implemented by this change. A static size check is not a passed live model
qualification, and these assets are not an installable runtime Blueprint yet.

`packages/blueprints/brain/adoption.json` pins ten MIT-licensed source files
from GBrain commit `a6be012a3bcfac42e279630aedec5cda4a450e29`. It records source
hashes, Git blob identities, adopted line ranges, exclusions with reasons,
adaptation descriptions, resulting section hashes and static phase assignments.
The adjacent license retains upstream attribution. The adopted sections preserve
source passages except for explicit Oregano operation, storage, model-role,
path and synthetic-example adaptations. Upstream personal storage, external
enrichment, autonomous extra Agents and provider-specific model defaults are
excluded. Review the pinned source ranges when changing an adaptation.

`scripts/materialize-brain-prompts.ts` exports `materializeBrainPrompts` for
build-time use. Supply an owning `agent_id`, a reviewed company `perspective`,
five directory mappings and the filing categories. All company values remain
in the consuming Workspace; the helper contains none. It returns complete
scoped Agent Markdown materials, trusted prompt bindings and a measurement
report. Incorporate those materials into the ordinary Workspace build before
binding the resulting Artifact. Ordinary Artifact compilation and connector
construction share scoped binding validation and reject missing, duplicate or
oversized prompts before any model call. The helper does not write to a Workspace, install
grants, follow instruction links or run during model execution.

The static sequence uses triage; meeting normalization; meeting-page preparation;
meeting entity updates; meeting verification; discussion extraction; discussion
entity updates; and a small bulk-trial check. Non-triage phases have separate
reasoning/deep bindings so evidence cannot choose a model tier. Every applicable
call contains the shared filing, quality, untrusted-content, lookup and model-role
rules. Meeting phases also carry the complete meeting contract. The entity
phase includes claim verification and the applicable enrichment procedure.

The synthetic default mapping measures 24,862 instruction units for the largest
phase, or 25,051 with the unchanged host wrapper. Each phase also carries its
bounded output contract; normalization references retained source segments
instead of echoing the whole transcript, and entity phases draft one target
page per call. The final serialization contract follows the procedure sections: page drafts begin with YAML frontmatter, have a sourced Timeline and contain no outer code fence. A complete `not_found` page-read receipt permits a new page; absent lookup evidence remains a gap. The connector ceiling is
30,000; generated bindings request only their actual measured length. The
unchanged default for other bindings remains 16,000. Alternate mappings are
measured afresh and may fail the ceiling. Missing sections, changed section
hashes, uncovered upstream ranges, unresolved mappings and oversized prompts
fail materialization. These checks establish integrity and declared coverage,
not semantic completeness; that requires review against the pinned sources.

The technical page serialization contract also preserves the seven-column Takes
format from pinned `src/core/takes-fence.ts` (lines 5–34): exact triple-dash
markers, stable row numbers and named fields. Oregano narrows the source column
to internal evidence links and the supported kinds/holder mappings. This explicit
output adaptation supplements the adopted holder guidance; a shorthand table is
not a valid page draft.

Before dependent runtime work claims feasibility, qualify the complete scoped
Artifact instructions with actual configured models and representative private
evidence. Record source/configuration identities, actual delivered instructions,
host wrapper and serialized evidence size, selected-model context limits, token
usage and available cost evidence, finish reason and elapsed time. Exercise the
largest applicable phase and preserve source/context/prior-result dependencies
across calls. The model has no Tools or write authority. Oversized evidence and
incomplete output are failures, not successful truncated drafts. Existing limits
remain 150,000 evidence units, at most 4,000 output tokens and 20,000 returned
units, 55 seconds generation and 65 seconds enclosing Tool time.

The automated tests use synthetic fixtures and model transports. A separate
protected model-only Preview qualified representative source triage, normalization,
meeting-page and largest entity/deep calls through the real Artifact path. Outputs
completed within the limits and repaired page formats passed citation/quote checks.
All three configured roles used the same model; this does not qualify distinct
model economics, full ingestion, database writes or production adoption. Private
source receipts and review findings remain outside public Core.
Requalify affected examples after prompt, mapping, binding or budget changes.
