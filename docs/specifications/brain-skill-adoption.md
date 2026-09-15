---
document_id: specification.brain-skill-adoption
title: Experimental Brain Skill adoption and prompt qualification
kind: specification
status: draft
authority: canonical
language: en
updated: 2026-09-15
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
qualification, and inspection or materialization does not install or activate runtime authority.

`packages/blueprints/brain/adoption.json` pins ten MIT-licensed source files
from GBrain commit `a6be012a3bcfac42e279630aedec5cda4a450e29`. It records source
hashes, Git blob identities, adopted line ranges, exclusions with reasons,
adaptation descriptions, resulting section hashes and static phase assignments.
The adjacent license retains upstream attribution. The adopted sections preserve
source passages except for explicit Oregano operation, storage, model-role,
path and synthetic-example adaptations. Upstream personal storage, external
enrichment, autonomous extra Agents and provider-specific model defaults are
excluded. Review the pinned source ranges when changing an adaptation.

The adjacent declarative Workflow is now part of the inspectable `oregano/brain`
Blueprint. `scripts/materialize-brain-workflow.ts` composes this prompt helper
with the generic Workflow and separate restricted Workbench Tool templates.
All company choices remain required Workspace inputs. See the
[import authoring contract](brain-import.md#reusable-authoring-assets) for
materialization, grants, source declarations and activation boundaries.

`scripts/materialize-brain-prompts.ts` exports `materializeBrainPrompts` for
build-time use. Supply an owning `agent_id`, a reviewed company `perspective`,
five directory mappings and the filing categories. All company values remain
in the consuming Workspace; the helper contains none. It returns complete
scoped Agent Markdown materials, trusted prompt bindings and a measurement
report. Generated phase bindings set `conversation_context: false`: the normal
Agent chat does not pay to inline every import phase, while each generation call
receives its complete selected instructions. Incorporate those materials into the ordinary Workspace build before
binding the resulting Artifact. Ordinary Artifact compilation and connector
construction share scoped binding validation and reject missing, duplicate or
oversized prompts before any model call. The helper does not write to a Workspace, install
grants, follow instruction links or run during model execution.

The static sequence uses triage; meeting normalization and a bounded resolution pass after authorized candidate reads; meeting-page preparation;
meeting entity updates; meeting verification; discussion extraction; discussion
entity updates; and a small bulk-trial check. Non-triage phases have separate
reasoning/deep bindings so evidence cannot choose a model tier. Every applicable
call contains the shared filing, quality, untrusted-content, lookup and model-role
rules. Meeting phases also carry the complete meeting contract. The entity
phase includes claim verification and the applicable enrichment procedure.

The synthetic default mapping measures 24,995 instruction units for the largest
phase, or 25,184 with the unchanged host wrapper. Materialized Skills include
valid YAML frontmatter and pass the ordinary Workspace Markdown validator. Each phase also carries its
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

The meeting-normalization phase has an explicit JSON serialization contract for
provisional meetings, attendee/subject candidates, lookup requests and gaps. Exact
unique line-start excerpts identify split boundaries; the host derives contiguous
source ranges while retaining every original character. This is an execution
adaptation of the pinned normalization and split procedure, not a replacement
rubric. A first call without page-read evidence cannot finalize identities or
deduplication. The owning Workflow must execute its requested lookups and subsequent
verification before filing. Malformed output or ambiguous boundaries fail visibly.

The separate resolution binding reuses the unchanged normalization procedure with a
receipt-aware output contract. Complete candidate pages accompany each retained
meeting chunk; ambiguous names and duplicate candidates cannot become accepted
identities from search excerpts. Unresolved issues remain explicit. Existing
meeting matches still require original-source comparison before any merge.

The verification phase serializes the unchanged V1–V6 checklist into six unique verdicts with supporting explanations, visible gaps and required repairs. A passed model verdict is not a write receipt or an automatic waiver. The meeting page output places speaker attribution and citations outside blockquotes so a host can compare every complete quoted passage with retained source text; it does not permit paraphrasing or silent quote deletion. Dependent Workflows must supply complete meeting/entity drafts and the relevant prior reads, validate coverage and block before writes on failed checks. This serialization requires fresh live qualification before full ingestion is claimed.
