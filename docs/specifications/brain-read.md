---
document_id: specification.brain-read
title: Governed Brain documents and operations
kind: specification
status: building
authority: canonical
language: en
updated: 2026-09-16
owners: [oregano-maintainers]
audience: [human, agent]
availability: experimental
relations:
  depends_on: [vision.companyos, reference.glossary]
---

# Governed Brain documents and operations

The experimental Brain reads ordinary company knowledge from `brain/` in the
Company Workspace. Git is authoritative. An Instance-scoped database projection
is disposable and rebuildable. Handbook policy, identity, Tool authority and
operating definitions remain governed separately. Retrieved prose never becomes
Agent instructions or permission to act.

The implementation provides checking, synchronization and seven governed Tools,
including bounded writes and change continuation. Automatic source ingestion
and completed live adoption remain later increments. See the [maintained implementation](../operations/brain-read.md)
for adapter bounds, migration and qualification evidence.

## Explicit Workspace adoption

`.companyos/brain.yaml` declares version 1, one to 64 page types, up to 32
frontmatter relationship mappings and optional filing guidance. Types choose a
directory, a semantic role (`content`, `person`, `company`, `evidence`) and a
search weight above zero and at most one. Relationships map a metadata field to
a relation and target type. These are content conventions, never authority.
`filing_guidance` is trusted, reviewed Workspace configuration compiled into
every Agent with Brain grants. Review it as Agent instructions under the
security change policy; imported knowledge cannot supply or change it.

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
    - oregano:brain/delta
    - oregano:brain/remember
    - oregano:brain/forget
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
Ordinary YAML metadata such as bounded tags, source-event `date`, page
`created` and page `updated` is retained for inspection and display. It is
not an authorization grant or a claim source. `date` and `created` refer to
different events; missing historical creation dates must not be guessed.
Company-specific tag vocabularies and directory mappings belong to the
Workspace, while Core validates the generic page and evidence contracts.

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
| `delta` | Content-free indexed changes, including removals. At most 100 entries per page; default 2,000 and maximum 8,000 estimated tokens for serialized entries, excluding the fixed envelope/cursor. No model. |

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
repository, selected names and resolved page identities, and projection generation/sequence. Contents
and cursor come from the same successful read snapshot. It is a position marker,
not an access credential. `delta` preserves selected page identities after
deletion or alias changes. An old cursor with an unresolvable alias requires
refresh instead of silently losing a removal.

`delta` accepts a cursor or an inclusive ISO `since` timestamp for index time.
Omitting both establishes a current baseline; omitting entities for a new
baseline selects all pages. Ordering uses sequence and slug, so identical
timestamps cannot skip entries. Pagination freezes an upper revision and
advances only past delivered entries. Later changes are available after that
sequence is drained. Entries contain stable change IDs, page IDs, change kinds,
indexed Git/time references and current path/hash references, never deleted text
or a semantic replay of intermediate knowledge.

An undersized budget returns `has_more` and `minimum_budget_tokens` without
skipping the next entry. Changed entity scope, foreign Instance, invalid cursor
or missing generation returns `refresh_required`. A configuration change, rebuild
or retention dropping history changes the generation. Retain the next cursor in existing
conversation or Workflow state after durable receipt; replay can repeat IDs.
No automatic Agent polling or new session store is created.

## Bounded writes and recovery

`remember(changes, provenance, operation_key, dry_run?)` supplies at most 16
distinct page changes and 400,000 changed UTF-16 text units. Each page selects
complete `markdown` or `timeline_add: {date, summary, detail?, evidence}`. Complete
replacements carry the previously read content hash, or null for creation.
Timeline additions require an existing page and its exact hash, a real YYYY-MM-DD
event date, a single-line summary (500 units), optional single-line detail (2,000
units), and one to 16 canonical evidence slugs also declared in provenance.
Core edits dated Markdown deterministically without a model call. It preserves
frontmatter, current knowledge, Takes and unrelated history, normalizes recognized
legacy Timeline separators, and inserts before the first older/equal dated bullet
(or at the end when none exists) without reordering existing prose. Exact repeated
entries are unchanged; operation-key replay also prevents duplicate commits.
Source corrections and changed current assertions use full page replacement or
explicit unique-passage withdrawal. They must not append contradictory events.
Provenance identifies source, version, processing action and internal evidence
pages linking to originals. Validate the complete resulting corpus before one
atomic commit. A newer branch head is accepted only while every selected page
still matches its precondition; unrelated edits survive. A changed target or
commit race returns a conflict for rereading and semantic reapplication. The exact maintained write Tools preserve typed Brain validation errors across the isolated Tool worker, including `write_conflict` and `invalid_batch`; custom Company Tool wrappers do not acquire this transport behavior from a matching name alone.

`forget(target, reason, operation_key, dry_run?)` withdraws a page, unique exact
prose passage or Take row. Prose targets exclude frontmatter and Takes fences.
The caller reviews derived assertions and supplies up to 32 exact dependent
withdrawals within the same file/text bounds. Mechanical checks reject ambiguity
and an exact remaining Take restatement; they cannot detect every paraphrase.
Source review remains necessary. Git history, originals and backups survive.

Existing Take claim/holder/kind identities remain immutable; supersession keeps
the inactive row and appends above the previous maximum. Whole-page withdrawal
retains only its Take high watermark under a scoped existing effect identity
before Git dispatch. Recreated pages must allocate above that watermark, even
after projection rebuild. These content-free identity checkpoints share the
existing control-state backup/recovery requirements and introduce no table.

Writes are R1 effects, subject to tighter normal Workspace policy. Roster,
effective grants, bindings and repository policy remain active. `dry_run`
validates without Git publication, identity changes or sync. Writes use existing
durable repository leases and effects scoped to Instance, repository, branch
and operation key. Input digests bind exact requests and configuration. Actor,
Agent, paths, before/after hashes and commit proof are retained; replacement or
removed prose and raw withdrawal reasons are not copied into effect logs.

A preparation checkpoint precedes dispatch; a verified Git receipt precedes
sync. Results separate `saved_commit` from `indexed_revision`; `sync_status` is
`indexed`, `current_head_indexed` or `pending`. Pending means saved knowledge
still needs indexing. New receipts include `page_results` with resulting content
hashes (null for deleted pages), including unchanged remember targets. These hashes
belong to the saved operation's result, not a possibly newer indexed head. Verify
actual page reads after the final write against these hashes. Legacy checkpoints
remain replayable without this optional field; full-replacement consumers may
compare the saved Markdown instead. Narrow changes cannot complete without a hash
receipt. Replay resumes sync without another commit. A lost receipt
is recovered only from exact provider proof matching operation, input, parent
and contents. Missing proof never authorizes another dispatch. A retained claim
that was never dispatched can resume through an authorized invocation;
read-only reconciliation itself cannot initiate it.

Only exact maintained Brain passthrough Tools may reconcile outer runtime
effects through the trusted Connector. Recovery rechecks current subject/grant
and compares status/input/evidence atomically. It cannot mutate Git; Company
Tool text cannot enable this path. A Workflow retains its original run/input
and waits on existing durable timers for read-only receipt/index recovery for
up to 15 minutes, then blocks for operator review. Other unknown effects retain
their existing fail-closed behavior.

Writes and sync cannot compile, stage or promote code. Repository-required
review is respected. Large backfills use reviewable batches through the existing
review route; the write Tools provide no bypass.

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

The Brain prompt Blueprint materializes source correction and correction verification
phases from the existing pinned filing, quality and enrichment UPDATE sections.
They preserve original versions, unrelated knowledge, stable Takes and earlier
Timeline entries; a low-value incoming version does not waive reconciliation.
These are proposal-only reasoning/deep phases under the unchanged generation
bounds. Workspace execution and live correction qualification remain separate.
