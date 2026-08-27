import { sha256 } from "../runtime/canonical.ts";
import type {
  KnowledgeSourceBinding,
  KnowledgeSourceConnector,
  KnowledgeSourceRequirement,
  SourceHealth,
  SourceObjectDescriptor,
  SourcePage,
  SourceReceipt,
  SourceVerification,
} from "../knowledge/source-contracts.ts";

const CONNECTOR_ID = "oregano/github-repository-source" as const;
const API_VERSION = "2026-03-10";

interface TreeCursor {
  version: 1;
  treeSha: string;
  offset: number;
  checksum: string;
}

interface GitTreeEntry {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
  size?: number;
}

const receipt = (input: Omit<SourceReceipt, "receiptId">): SourceReceipt => ({
  receiptId: sha256({
    sourceId: input.sourceId,
    operation: input.operation,
    cursor: input.cursor ?? null,
    objectId: input.objectId ?? null,
    objectVersion: input.objectVersion ?? null,
    evidence: input.evidence,
  }),
  ...input,
});

const encodeCursor = (sourceId: string, treeSha: string, offset: number): string => {
  const value: TreeCursor = { version: 1, treeSha, offset, checksum: sha256({ sourceId, treeSha, offset }) };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
};

const decodeCursor = (sourceId: string, value: string): TreeCursor => {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("Knowledge source cursor is malformed."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Knowledge source cursor is malformed.");
  const cursor = parsed as Partial<TreeCursor>;
  if (cursor.version !== 1 || typeof cursor.treeSha !== "string" || !/^[0-9a-f]{40,64}$/i.test(cursor.treeSha) ||
    !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 ||
    cursor.checksum !== sha256({ sourceId, treeSha: cursor.treeSha, offset: cursor.offset })) {
    throw new Error("Knowledge source cursor failed integrity validation.");
  }
  return cursor as TreeCursor;
};

export interface GitHubKnowledgeSourceOptions {
  requirement: KnowledgeSourceRequirement;
  binding: KnowledgeSourceBinding;
  resolveSecret(reference: string): string | Promise<string>;
  fetch?: typeof globalThis.fetch;
  now?: () => string;
  retryDelay?: (milliseconds: number) => Promise<void>;
}

export class GitHubKnowledgeSourceConnector implements KnowledgeSourceConnector {
  readonly id = CONNECTOR_ID;
  readonly version = "1.0.0" as const;
  readonly sourceId: string;
  readonly #requirement: KnowledgeSourceRequirement;
  readonly #binding: KnowledgeSourceBinding;
  readonly #resolveSecret: GitHubKnowledgeSourceOptions["resolveSecret"];
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => string;
  readonly #retryDelay: (milliseconds: number) => Promise<void>;

  constructor(options: GitHubKnowledgeSourceOptions) {
    if (options.requirement.sourceId !== options.binding.sourceId) throw new Error("Knowledge source requirement and binding source_id values differ.");
    if (options.binding.connector !== CONNECTOR_ID || options.binding.connectorVersion !== this.version) throw new Error("Unsupported Knowledge Source Connector binding.");
    if (!/^env:[A-Z][A-Z0-9_]+$/.test(options.binding.secretRef)) throw new Error("Knowledge Source Connector credentials must be supplied through an env:NAME SecretRef.");
    if (options.requirement.personalData || options.requirement.dataClass !== "business") throw new Error("The shared Knowledge source connector accepts business data without personal data only.");
    const apiBaseUrl = options.binding.apiBaseUrl ?? "https://api.github.com";
    const parsed = new URL(apiBaseUrl);
    if (parsed.protocol !== "https:") throw new Error("Knowledge source api_base_url must use HTTPS.");
    this.sourceId = options.binding.sourceId;
    this.#requirement = options.requirement;
    this.#binding = { ...options.binding, apiBaseUrl: apiBaseUrl.replace(/\/$/, "") };
    this.#resolveSecret = options.resolveSecret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#retryDelay = options.retryDelay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async verify(): Promise<SourceVerification> {
    const repository = await this.#request(`/repos/${encodeURIComponent(this.#binding.owner)}/${encodeURIComponent(this.#binding.repository)}`) as Record<string, unknown>;
    const identity = String(repository.full_name ?? "");
    const expected = `${this.#binding.owner}/${this.#binding.repository}`;
    if (identity.toLocaleLowerCase("en") !== expected.toLocaleLowerCase("en")) throw new Error(`Repository identity mismatch: expected '${expected}', received '${identity || "unknown"}'.`);
    const observedAt = this.#now();
    const verificationReceipt = receipt({
      sourceId: this.sourceId,
      operation: "verify",
      observedAt,
      evidence: { repository_identity: identity, ref: this.#binding.ref, required_scopes: this.#binding.requiredScopes },
    });
    return {
      ok: true,
      sourceId: this.sourceId,
      connector: this.id,
      repositoryIdentity: identity,
      ref: this.#binding.ref,
      requiredScopes: [...this.#binding.requiredScopes],
      receipt: verificationReceipt,
    };
  }

  async enumerate(input: { cursor?: string; pageSize?: number } = {}): Promise<SourcePage> {
    const prior = input.cursor ? decodeCursor(this.sourceId, input.cursor) : undefined;
    const treeish = prior?.treeSha ?? this.#binding.ref;
    const tree = await this.#request(`/repos/${encodeURIComponent(this.#binding.owner)}/${encodeURIComponent(this.#binding.repository)}/git/trees/${encodeURIComponent(treeish)}?recursive=1`) as Record<string, unknown>;
    if (tree.truncated === true) throw new Error("Repository tree enumeration was truncated; source synchronization stopped to avoid a partial inventory.");
    const treeSha = String(tree.sha ?? "");
    if (!/^[0-9a-f]{40,64}$/i.test(treeSha)) throw new Error("Repository tree response has no valid immutable SHA.");
    if (prior && prior.treeSha !== treeSha) throw new Error("Knowledge source cursor tree no longer matches the enumerated immutable tree.");
    const prefix = this.#requirement.pathPrefix ? `${this.#requirement.pathPrefix}/` : "";
    const rawEntries = Array.isArray(tree.tree) ? tree.tree as GitTreeEntry[] : [];
    const objects = rawEntries
      .filter((entry) => entry.type === "blob" && typeof entry.path === "string" && typeof entry.sha === "string" && typeof entry.size === "number")
      .filter((entry) => !entry.path!.startsWith("/") && !entry.path!.includes("\\") && !entry.path!.split("/").includes("..") && entry.path!.length <= 1_000)
      .filter((entry) => !prefix || entry.path!.startsWith(prefix))
      .filter((entry) => this.#requirement.includeExtensions.some((extension) => entry.path!.toLocaleLowerCase("en").endsWith(extension)))
      .filter((entry) => entry.size! <= this.#requirement.maxObjectBytes)
      .map((entry): SourceObjectDescriptor => ({
        providerObjectId: entry.path!,
        providerVersion: entry.sha!,
        path: entry.path!,
        mediaType: "text/markdown",
        size: entry.size!,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const pageSize = Math.max(1, Math.min(input.pageSize ?? 100, 1_000));
    const offset = prior?.offset ?? 0;
    if (offset > objects.length) throw new Error("Knowledge source cursor offset is beyond the current immutable inventory.");
    const pageObjects = objects.slice(offset, offset + pageSize);
    const nextOffset = offset + pageObjects.length;
    const complete = nextOffset >= objects.length;
    const nextCursor = complete ? undefined : encodeCursor(this.sourceId, treeSha, nextOffset);
    const observedAt = this.#now();
    const enumerationReceipt = receipt({
      sourceId: this.sourceId,
      operation: "enumerate",
      observedAt,
      cursor: input.cursor,
      evidence: { tree_sha: treeSha, offset, page_size: pageSize, returned: pageObjects.length, inventory_count: objects.length, complete },
    });
    return { objects: pageObjects, nextCursor, complete, receipt: enumerationReceipt };
  }

  async fetch(descriptor: SourceObjectDescriptor, cursorOrEventId: string) {
    if (descriptor.mediaType !== "text/markdown" || descriptor.size > this.#requirement.maxObjectBytes) throw new Error("Knowledge source object exceeds its declared content boundary.");
    const blob = await this.#request(`/repos/${encodeURIComponent(this.#binding.owner)}/${encodeURIComponent(this.#binding.repository)}/git/blobs/${encodeURIComponent(descriptor.providerVersion)}`) as Record<string, unknown>;
    if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error(`Source object '${descriptor.path}' is not a base64 Git blob.`);
    const bytes = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
    if (bytes.byteLength > this.#requirement.maxObjectBytes || bytes.byteLength !== descriptor.size) throw new Error(`Source object '${descriptor.path}' failed its declared size boundary.`);
    const boundedText = bytes.toString("utf8").replace(/\r\n?/g, "\n");
    if (boundedText.includes("\uFFFD")) throw new Error(`Source object '${descriptor.path}' is not valid UTF-8 text.`);
    const observedAt = this.#now();
    const contentDigest = sha256(boundedText);
    const fetchReceipt = receipt({
      sourceId: this.sourceId,
      operation: "fetch",
      observedAt,
      objectId: descriptor.providerObjectId,
      objectVersion: descriptor.providerVersion,
      evidence: { path: descriptor.path, bytes: bytes.byteLength, content_digest: contentDigest },
    });
    return {
      envelope: {
        sourceId: this.sourceId,
        providerObjectId: descriptor.providerObjectId,
        providerVersion: descriptor.providerVersion,
        observedAt,
        mediaType: "text/markdown" as const,
        contentDigest,
        ownerOrAccount: `${this.#binding.owner}/${this.#binding.repository}`,
        cursorOrEventId,
        deletionState: "present" as const,
        receiptMetadata: { receipt_id: fetchReceipt.receiptId, path: descriptor.path, bytes: bytes.byteLength },
        boundedText,
      },
      receipt: fetchReceipt,
    };
  }

  async health(): Promise<SourceHealth> {
    const checkedAt = this.#now();
    try {
      await this.verify();
      return { ok: true, sourceId: this.sourceId, status: "healthy", checkedAt };
    } catch (error) {
      return { ok: false, sourceId: this.sourceId, status: "error", checkedAt, reason: error instanceof Error ? error.message : "Unknown source health error." };
    }
  }

  async revoke(): Promise<SourceReceipt> {
    return receipt({ sourceId: this.sourceId, operation: "revoke", observedAt: this.#now(), evidence: { local_binding_revoked: true } });
  }

  async #request(path: string): Promise<unknown> {
    const token = await this.#resolveSecret(this.#binding.secretRef);
    if (!token) throw new Error(`SecretRef '${this.#binding.secretRef}' resolved to an empty value.`);
    let lastStatus = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await this.#fetch(`${this.#binding.apiBaseUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "oregano-company-knowledge",
        },
      });
      lastStatus = response.status;
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 3) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1_000, 1_000) : Math.min(100 * (2 ** (attempt - 1)), 1_000);
      await this.#retryDelay(delay);
    }
    throw new Error(`Knowledge source request failed after bounded retry (HTTP ${lastStatus}).`);
  }
}
