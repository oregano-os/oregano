---
document_id: specification.brain-read
title: Governed Brain documents and read operations
kind: specification
status: building
authority: canonical
language: en
updated: 2026-09-14
owners: [oregano-maintainers]
audience: [human, agent]
availability: experimental
relations:
  depends_on: [vision.companyos, reference.glossary]
---

# Governed Brain documents and read operations

The experimental Brain reads ordinary company knowledge from `brain/` in the
Company Workspace. Git is authoritative. An Instance-scoped database projection
is disposable and rebuildable. Handbook policy, identity, Tool authority and
operating definitions remain governed separately. Retrieved prose never becomes
Agent instructions or permission to act.

This increment implements documents, checking, synchronization and four reads.
Writes, change continuation, automatic ingestion and live company adoption are
later increments. A starting cursor is returned now; no `delta` Tool is promised
until its continuation handler exists. See the [maintained implementation](../operations/brain-read.md)
for adapter bounds, migration and qualification evidence.

## Explicit Workspace adoption

`.companyos/brain.yaml` declares version 1, one to 64 page types, up to 32
frontmatter relationship mappings and optional filing guidance. Types choose a
directory, a semantic role (`content`, `person`, `company`, `evidence`) and a
search weight above zero and at most one. Relationships map a metadata field to
a relation and target type. These are content conventions, never authority.

```yaml
version: 1
types:
  person: {directory: people, role: person}
  company: {directory: companies, role: company}
  topic: {directory: topics, role: content}
  source: {directory: sources, role: evidence, search_weight: 0.5}
relationships:
  employer: {relation: works_at, target_type: company}
filing_guidance: Preserve attribution and identify missing source context.
```

Adoption also requires existing `.companyos/governance.yaml` to declare:

```yaml
runtime:
  brain_reading: company-wide
  common_tool_grants:
    - oregano:brain/recall
    - oregano:brain/entity
    - oregano:brain/context_pack
    - oregano:brain/synthesize
```

Only explicitly declared company-wide content reading is supported in this
increment. Missing policy and narrower unsupported modes fail closed. An active
member of the existing roster, the calling Agent's effective grant, the
Workspace capability allowlist and an Instance binding are all required.
Common grants apply to present and future Agents through the existing ToolSet
resolver, with policy path/digest provenance. A company can omit any Tool;
Instance enablement does not restore it. Shared guidance describes only the
operations available to that Agent.

## Readable documents and evidence

Only ordinary, non-executable Markdown files below `brain/` are knowledge.
Absolute paths, traversal, hidden directories, configuration/instruction files,
symlinks, hardlinks and submodules are rejected at the relevant adapter boundary.
A page has one YAML frontmatter block with declared `type` and nonempty `title`,
optional language and aliases, followed by Compiled Truth. The optional
`<!-- timeline -->` boundary starts a human-readable prose Timeline. Compatible
upstream separators are understood; ordinary body horizontal rules survive.
Timeline entries have no separate IDs, event kinds or date-filter API.

Takes use exactly seven columns, between `<!--- gbrain:takes:begin -->` and
`<!--- gbrain:takes:end -->`: `#`, `claim`, `kind`, `who`, `weight`, `since`,
`source`. Positive row numbers are stable identity. Kind is `fact`, `take`,
`bet` or `hunch`. Holder is `world`, `brain`, or a reference to a person or
company page under the declared role mapping; a holder is not the claim's subject.
Weights normalize to the 0.05 grid, with a visible warning when changed. Dates
accept ISO month/day values and ordered ranges. Struck claims remain inactive
history. Current retrieval indexes active Takes separately and removes the entire
Takes fence from ordinary page search, preventing withdrawn claims from leaking
through prose excerpts. Entity inspection deliberately includes inactive history.

Every Timeline entry and Take must link to an existing internal evidence page;
that page must link to an original source. Ordinary unresolved or ambiguous
references produce diagnostics. Invalid evidence chains prevent indexing. Body
and mapped frontmatter links form outgoing relationships; backlinks are derived.
The checker never creates stub pages. Mechanical validity does not prove factual
accuracy or that an attendee page is meaningful; source-based review remains
necessary when preparing or ingesting knowledge.

## One rebuildable projection

Synchronization obtains the existing Records synchronization lease, reads the
current bound repository head, checks the prospective corpus, and atomically
publishes pages, Takes, links, removal metadata and its checkpoint. The checkpoint
contains Git commit, configuration digest, generation, sequence and indexing time.
A stale expected revision or lost lease cannot overwrite the current projection.
Invalid source material preserves the preceding successful checkpoint. An
unchanged commit/configuration is a no-op. Non-Brain Git changes do not advance
the knowledge sequence when the content is identical.

All reads check the same expected revision, including empty query results. A
concurrent sync retries the read up to three times; it never repeats a model call.
An incompatible deployed configuration fails before model preparation. Read
results identify their indexed revision, which may differ from the deployed
operating Artifact's Workspace commit. Brain content is excluded from compiled
Agent materials, source inventories and the operating-content hash. Knowledge
sync does not compile, stage or promote an Artifact.

## Shared reads and synthesis

| Operation | Behavior and bound |
|---|---|
| `recall` | Full-text page/active-Take retrieval; optional type or one entity plus direct neighbors; default 10, maximum 50 combined hits. |
| `entity` | Exact slug first, then aliases/titles; structured not-found or ambiguity; current page, readable Timeline, Takes and up to 100 graph edges. No model. |
| `context_pack` | Up to eight selected entities; current knowledge first, then active Takes, Timeline and source context; default 4,000, maximum 8,000 estimated tokens at four characters/token. Reports omitted blocks and unresolved names. No model. |
| `synthesize` | Shared retrieval followed by one bounded `brain.synthesize` call using the existing `reasoning` model profile. No Tools or writes inside composition. |

Synthesis gathers up to eight primary pages and eight linked pages within a
120,000-character evidence bound. It preserves holders, low-confidence/hunch
qualifiers, conflicts, original sources and gaps. Output citations must name
gathered pages and active row IDs and appear inline; a page's existence does not
validate an invented row. Retrieval failure remains an error. Missing model
configuration remains an explicit error. No evidence returns
`insufficient_evidence`. A failed composition or citation check returns labelled
`extractive_fallback` excerpts. Provider-reported usage is retained; unavailable
monetary cost is not asserted to be zero.

A context pack includes a content-free starting cursor bound to Instance,
repository, selected entity names and projection generation/sequence. Contents
and cursor come from the same successful read snapshot. It is a position marker,
not an access credential. Continuation is not available in this increment.

## Pinned upstream adoption

The MIT-licensed source pin is GBrain
[`a6be012a3bcfac42e279630aedec5cda4a450e29`](https://github.com/garrytan/gbrain/tree/a6be012a3bcfac42e279630aedec5cda4a450e29).
The local upstream directory retains its license.

| Pinned material | Adoption and reason for differences |
|---|---|
| `src/core/markdown.ts`, Timeline split helpers | Same separator recognition, including compatible older layouts; local serialization uses the canonical marker. |
| `src/core/fence-shared.ts`, pipe/escape/strike helpers | Retained parsing helpers. The local seven-column Takes contract rejects malformed rows instead of guessing. |
| `src/core/takes-fence.ts` | Stable row identity, attribution, inactive history and 0.05 weights. Company-declared directories replace personal vocabulary; unsupported calibration columns are excluded. |
| `src/core/ops/facts.ts`, `src/core/verbs.ts` | Retained lookup/synthesis/session routing and parameter intent. Descriptions state the actual bounded text search, supported filters, response fields and granted subset. Unsupported stores, Tools and date/kind filters are removed. |
| `src/core/think/prompt.ts` | Retained citation, hunch, conflict, gaps and no-advice rules with the structured output contract; evidence comes from shared governed reads, personal examples become synthetic. |
| `src/mcp/instructions.ts`, `skills/conventions/brain-first.md` | Shared reference-data and session-boundary guidance, scoped to the effective ToolSet. No imported provider access or personal authority. |

The [Skill adoption specification](brain-skill-adoption.md) covers the separately
qualified import prompt foundation. Neither wording reuse nor passing parser
tests proves equivalent semantic quality on real company material.
