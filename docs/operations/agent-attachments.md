---
document_id: operations.agent-attachments
title: Agent attachments and provider policies
kind: operations
status: approved
availability: experimental
implementation_scope: provider
providers: [openai, anthropic, slack]
authority: canonical
language: en
updated: 2026-09-13
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# Agent attachments and provider policies

Authenticated Agent conversations accept PDF, PNG, JPEG, WebP and UTF-8
Markdown attachments on qualified direct OpenAI and Anthropic models. The same
preparation applies to ordinary Agents, Builder, conversation coordination,
authorized handoffs, workflow conversations and interactive candidate tests.
PDFs and images use native API content; Markdown becomes attributed reference
text. File contents never become system instructions, grants or approval.

## Core policy

`packages/runner/attachment-policies.json` is the versioned configuration.
Each provider route declares model patterns, formats and representations,
per-format byte limits, total bytes, total Markdown bytes, count and a request
size budget. The common preparation and model adapter read this configuration;
there are no per-Agent numeric limits or Workspace activation switches.

The initial policy uses these conservative limits independently for both routes:

| Setting | Initial value |
|---|---|
| Attachments in one request, including retained files | 5 |
| Each PDF or image | 5 MiB |
| All original file bytes combined | 10 MiB |
| Each Markdown file and all Markdown combined | 64 KiB |
| Serialized model request budget, including base64, text and Tools | 24 MiB |

To adjust a provider, edit its policy entry, retain the documentation source
links, update `reviewedAt`, and run the attachment tests and Core inspection.
A reviewed Core build/deployment applies the changed data. This is not a
Workspace override or a mutable provider setting inferred from model output.
Model patterns deliberately qualify known families; an unlisted model fails
with a useful diagnostic instead of silently changing provider.

Adding another format or provider later extends `prepareAttachments` and its
transport qualification. Changing a JSON MIME entry alone cannot install a
converter. DOCX parsing, OCR, PDF rendering and arbitrary URL fetching are not
implemented.

## Admission and retained context

The host verifies the sender and conversation before reading files. It uses
only channel-authorized bytes or a reader supplied by the channel adapter.
Advertised count, size and format are checked before download; actual bytes,
file signatures and UTF-8 validity are checked afterwards. A rejected batch is
not partially passed to the Agent. Readers that return an entire buffer may
allocate that buffer before the actual-size check; no streaming downloader is
introduced by this change.

Original bytes remain in existing Instance chat state with a 30-day expiry;
conversation state holds small references. The latest 40 retained human turns
share file references across authorized Agents in that exact conversation.
Private Agent transcripts are not copied. Coordinator clarification preserves
the original message's references, including when the selected message is older
than the clarification reply. Every destination revalidates files against its
own selected provider/model. Expired files require a new upload. If the retained
files exceed the request limits, start a new thread with the required files.
No historical files are silently discarded to make a request fit.

Native request middleware checks combined history again on every generated or
streamed model step, including the current text and Tool definitions. Its
request budget leaves room for provider-specific envelopes; it is a conservative
estimate, not an exact provider token count. Dense or encrypted PDFs, excessive
page counts, unsupported image dimensions and context exhaustion may still be
rejected by the provider. Core does not claim that a small PDF necessarily fits
in the model context.

The `language.generate` contract also accepts optional inline `attachments`
with `name`, `mediaType`, `size`, base64 `data` and SHA-256 `digest`. These are
untrusted evidence supplied through existing authenticated Tool execution;
they grant no file access. Generation validates them under the owning Agent's
model policy. Preview conversation checks accept the same optional attachments
on user messages. Neither interface accepts attachment URLs or provider IDs.

## Coding worker

Builder binds the admitted originals into the immutable job input and request
fingerprint. The isolated worker validates them against its provider policy
and places them outside the proposal checkout under its temporary reference
area. They cannot be accidentally committed as Workspace content. Images and
Markdown are supplied as ACP image/text content; images require the adapter's
advertised support. The pinned coding adapters do not support native PDF blobs,
so PDFs are available as original local files to their file-reading Tools.
Whether a coding agent can read a PDF depends on those Tools; no Core conversion
or native ACP PDF support is claimed. Temporary worker copies are removed at
completion; job input retention follows the existing Builder job lifecycle.

## Provider evidence and qualification

The policy was reviewed on 2026-09-13. OpenAI permits individual PDF inputs
below 50 MB and up to 50 MB of files per request; PDF input requires a model
with vision support. See [OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs).
Anthropic limits the whole request to 32 MB and also applies PDF page and
context limits. See [Anthropic PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support)
and [vision constraints](https://platform.claude.com/docs/en/build-with-claude/vision).
The Core defaults deliberately stay below these maxima.

Synthetic tests capture the real SDK request shapes for both providers and
exercise size/count/encoding failures without provider calls. They establish
transport behavior, not live model quality, channel permission readiness or a
deployed Instance. Slack still needs its existing authorized file reader and
`files:read` scope; this change does not grant that scope.
