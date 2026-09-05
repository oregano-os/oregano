---
document_id: specification.company-record-normalization-v1
title: Company Record Normalization v1
kind: specification
status: implemented
authority: canonical
language: en
updated: 2026-09-05
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - specification.company-records-sprint-v0.1
  related:
    - specification.company-records-query-v1
    - guide.connect-company-record-source
---

# Company Record Normalization v1

Record Sources map provider fields into typed evidence before projection.
The maintained normalization path is shared by ordinary ingestion, complete
snapshot synchronization and reconciliation. No Company Tool obtains provider
access or parses messages as a substitute for this path.

## Field contracts

`fields[].source` is a literal, own-property path in the normalized provider
object. Array indexing, expressions, prototype properties and unsafe path
segments are rejected. Targets are distinct top-level names. Missing or null
optional values are omitted; required values fail normalization. False, zero
and empty arrays remain actual values. Values are copied without coercion or
aliasing the provider object.

| `value_type` | Runtime value |
|---|---|
| `string`, `status`, `identity` | String; an identity value does not authenticate anybody |
| `number`, `boolean` | Exact JSON type |
| `timestamp` | ISO timestamp with timezone, preserving provider fractional precision |
| `url` | Absolute HTTP(S) URL without embedded credentials |
| `json` | JSON value |
| `string_list`, `identity_list` | At most 10,000 strings |
| `json_list` | At most 10,000 entries satisfying the mandatory `item_schema` |

An `item_schema` is a self-contained JSON Schema, with no `$ref`, `$dynamicRef`
or `$id`, and at most 16 nested levels. It is only valid on `json_list`.
Object identity is a nonempty provider string or finite number, never a
parser result. An ingestion event must name the same object. Invalid input
does not consume the event's deduplication identity.

## Roster identity resolution

An `identity` or `identity_list` mapping may set `resolve_identity: true`.
Its input must contain complete provider principals such as
`chat:account-1:user-1`; names and bare provider user IDs are rejected. The
normalizer resolves exact principals against a frozen `RecordIdentityDirectory`
built from the reviewed Workspace roster. Two provider principals explicitly
assigned to one roster member resolve to that member's stable ID.

Duplicate roster IDs and ambiguous principal ownership fail before execution.
Unknown principals, members without stable IDs and non-human principals remain
explicit `unresolved:<principal>` values. These cannot collide with roster IDs,
which cannot contain colons. Inactive human identities can still identify
historical evidence; this lookup does not authorize their present activity.
Roster participation, current status, groups and approval rights remain the
responsibility of their existing authorization controls. Parsed text cannot
request identity resolution.

The directory is copied, bounded to 1,000 members and digested independently of
member, principal and group order. Normalized versions include that digest in
their source receipt. For sources using resolution, synchronization proof's
`source_digest` binds both the source and directory. Changing the roster
therefore requires new synchronization evidence for a completeness query.
Sources without resolution retain their original declaration-only digest.
Missing directory configuration fails even for an empty source inventory.

The CLI freezes `handbook/roster.md` when planning a source operation and
includes the directory digest in its confirmation. Execution uses those frozen
bytes and rejects a changed directory. Hosted Records configuration can carry
bounded `roster_markdown` from the exact configured Workspace commit; it is
covered by the existing configuration/confirmation digest. The subsequent
workflow Artifact integration must supply the same reviewed content. No
external roster, name matching or Records-derived authorization is introduced.

## Reviewed sectioned text

A source may declare one `parser` using `kind: sectioned-text`, `version: 1`,
a provider text `source`, a literal `starts_with` prefix and ordered
`sections`. The declaration is reviewed source content and is included in its
digest. It is not inferred from prose or a referenced message template.

```yaml
parser:
  kind: sectioned-text
  version: 1
  source: text
  starts_with: DELIVERY UPDATE
  sections:
    - id: current
      heading: CURRENT WORK
      required: true
      fields:
        - id: obstacle
          prefixes: ["Obstacle:"]
          required: true
      links:
        hosts: [boards.example.test]
        path: /boards/*/items/{id}
        id_field: item_id
        required: false
```

The first nonempty line must start with the configured prefix at a word
boundary. Heading matching ignores case and surrounding Markdown emphasis
or heading markers. Required sections must occur once, in declared order.
Fields use non-overlapping literal prefixes; a required field needs a
nonempty value. Duplicate fields, headings and recognized link identities
make the message malformed. Heading names, labels and URL structure contain
all company-specific vocabulary. The parser executes no user regex or code.

Link matching accepts HTTPS links on exact declared hosts and paths.
`*` matches one nonempty path segment; exactly one `{id}` captures a segment.
Credentials, extra path segments and encoded path separators are rejected.
Slack angle links, Markdown links and plain URLs are recognized. Query and
fragment parts do not alter a path identity. All URL occurrences are retained;
unknown links in a section with a link declaration make it malformed.
Additional recognized identities remain in the output so a Workspace Tool
can compare the submitted set with its actual expected set. The parser does
not consult a board or restrict output to previously known work items.

The bound is 65,536 input UTF-16 code units, 1,000 links, 32 sections,
32 fields per section, eight prefixes per field and 16 hosts per link
declaration. Overflow fails ingestion and therefore cannot advance complete
synchronization evidence. These are explicit limits, not silent truncation.

## Output and trust boundary

The parser always produces `parsed.matched`, `parsed.well_formed`,
`parsed.issues` and `parsed.sections.<id>`. Each declared section has:

- `text`: the section content;
- `fields.<id>`: the extracted string, or an empty string;
- `ids`: every recognized identity, including extra and duplicate values;
- `links`: every encountered URL, including unrecognized URLs;
- `items`: recognized links with the declared identity field, `url` and `text`.

Nonmatching messages have `matched: false`, `well_formed: false` and empty
section outputs. Malformed matching messages retain their parsed evidence and
issue codes. A projection may select `matched: true` but should retain
malformed answers when the workflow must report missing formatting.
`recordTextParserOutputSchema` supplies the exact output field schema;
undeclared parser paths and incompatible outer field types fail validation.
Nested `item_schema` constraints are also enforced on every actual item.

`parsed` is reserved for the computed result and replaces any provider-supplied
field of that name. It cannot overwrite raw provider fields. Sender, author
kind, channel, thread and provider time must be mapped separately. The
parser does not resolve a person, select a run, grant access, approve an effect
or prove that a source has synchronized through a cutoff. A workflow still
needs trusted source identity, exact thread assignment and complete-source
evidence. Optional exact principal resolution is implemented as described
above; provider principal emission, role-board aggregation and the generic
workflow engine remain integration work.

## Compatibility and evidence

Existing source shapes remain valid; values that contradicted their declared
type now fail. Correct invalid mappings and re-sync retained provider evidence
before adopting a new Artifact. Do not rewrite historical versions or audit
receipts. This contract belongs to the upcoming minor Core release.

`record-normalization.test.ts` exercises the real normalization, registry,
ingestion and synchronization path. Its synthetic fixture proves typed
mapping, output schemas, malformed answers, extra and duplicate references,
text/identity separation, bounds and failed-ingestion retry. CLI tests reject
invalid declarations. These checks do not establish hosted source coverage,
cross-provider identity or end-to-end workflow acceptance.
