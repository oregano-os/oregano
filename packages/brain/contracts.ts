/** Company-neutral knowledge values; never Agent instructions or authority. */
export interface BrainDiagnostic {
  code: string;
  severity: "error" | "warning";
  path: string;
  message: string;
  row_num?: number;
}

export interface BrainPageType {
  directory: string;
  role: "content" | "person" | "company" | "evidence";
  search_weight: number;
}

export interface BrainConfiguration {
  version: 1;
  types: Record<string, BrainPageType>;
  relationships: Record<string, { relation: string; target_type: string }>;
  filing_guidance: string;
}

export interface BrainTake {
  row_num: number;
  claim: string;
  kind: "fact" | "take" | "bet" | "hunch";
  holder: string;
  weight: number;
  since_date?: string;
  until_date?: string;
  source: string;
  active: boolean;
}

export interface BrainLink {
  from: string;
  target: string;
  resolved?: string;
  relation: string;
  context: string;
}

export interface BrainPage {
  slug: string;
  path: string;
  type: string;
  title: string;
  lang: string;
  search_weight: number;
  aliases: string[];
  metadata: Record<string, unknown>;
  markdown: string;
  content_hash: string;
  /** Includes the optional source-of-truth Takes fence. */
  compiled_truth: string;
  timeline: string;
  /** The complete Takes fence is removed before ordinary full-text indexing. */
  search_text: string;
  takes: BrainTake[];
  links: BrainLink[];
  original_links: string[];
}

export interface BrainRevision {
  git_commit: string;
  configuration_digest: string;
  generation: string;
  sequence: number;
  indexed_at: string;
}

export interface BrainScope { instance_id: string; repository_id: string }
export interface BrainCorpus {
  pages: BrainPage[];
  diagnostics: BrainDiagnostic[];
}

export class BrainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "BrainError"; this.code = code; }
}
