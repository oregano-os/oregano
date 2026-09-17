# Documents and extracted media

Adopted from GBrain media-ingest 1.1.0. The source adapter is responsible for
authorized fetching, transcription, OCR or repository extraction and original
preservation in Records. This Skill consumes the resulting complete text and
provenance; it cannot activate a missing extractor or call another provider.

1. Identify the source format from retained metadata. Check the original URL or
   file identity and existing coverage before creating a page. Reconcile a new
   version with the existing page and preserve prior citations and history.
2. Read the entire prepared content. Cross-check names from captions/OCR against
   canonical names, aliases and plausible existing Brain pages. Explicitly mark
   inaudible, illegible, uncertain or undiarized passages; never guess a speaker
   or proper noun. Large documents retain section/chapter boundaries and raw
   references; summaries must not pretend omitted source text was read.
3. File by primary subject in the supplied directories. Write a useful summary,
   source/format metadata, supported highlights (timestamps or chapter references
   when supplied), and linked people/companies. Do not dump the full transcript
   into the Brain. Do not introduce format-specific directories.
4. Resolve and enrich every relevant mentioned person/company. Add entity
   Timeline entries and backlinks to the content page, preserving unrelated
   current knowledge. Propagation is part of ingestion, not optional later work.
5. Check actual commit/index receipts and reread saved pages. Verify source
   fidelity, quotations, entity coverage and backlinks; correct concrete defects
   before completion. Do not report success for empty or metadata-only content.

No transcription/OCR retry, new provider call, publication expansion or Dream
is part of this source task. Unavailable extraction stops during preparation.
