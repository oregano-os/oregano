import { createHash } from "node:crypto";
import type { AttachmentPolicy } from "../runner/attachment-policy.ts";

/** Only a trusted channel/host may supply data or a reader. URLs are never fetched. */
export interface AgentAttachment {
  type?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  data?: Uint8Array | ArrayBuffer | Blob;
  fetchData?: () => Promise<Uint8Array | ArrayBuffer>;
}
export interface PreparedAttachment {
  readonly digest: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly data: string;
}
export interface AttachmentReference {
  readonly key: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
}
export type AttachmentPart = { type: "text"; text: string; providerOptions?: { companyos: { attachmentMediaType: string } } }
  | { type: "file"; data: Uint8Array; mediaType: string; filename: string };
export class AttachmentInputError extends Error {}
function fail(message: string): never { throw new AttachmentInputError(message); }
const safeName = (name?: string) => (name ?? "attachment").replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 200) || "attachment";
const mimeType = (input: AgentAttachment) => {
  const mime = input.mimeType?.split(";")[0]?.trim().toLowerCase();
  // Slack commonly labels Markdown as text/plain. Do not reinterpret arbitrary binary formats.
  if (/\.(md|markdown)$/i.test(input.name ?? "") && (!mime || ["text/plain", "text/markdown", "text/x-markdown", "application/octet-stream"].includes(mime))) return "text/markdown";
  return mime ?? "";
};
export function checkAttachmentSizes(items: readonly { size?: number; mediaType: string }[], policy: AttachmentPolicy) {
  if (policy.maxAttachments !== undefined && items.length > policy.maxAttachments) fail(`Too many attachments: maximum ${policy.maxAttachments} per model request. Send fewer files.`);
  let total = 0, text = 0, encoded = 0;
  const groups: Record<string, { count: number; bytes: number }> = {};
  for (const item of items) {
    if (!item || typeof item.mediaType !== "string") fail("Invalid attachment metadata.");
    const format = Object.hasOwn(policy.formats, item.mediaType) ? policy.formats[item.mediaType] : undefined;
    if (!format) fail("Unsupported attachment format. The selected provider's Core policy lists the supported formats.");
    const group = groups[format.representation] ??= { count: 0, bytes: 0 };
    group.count++;
    const limits = policy.representationLimits?.[format.representation];
    if (limits?.maxCount !== undefined && group.count > limits.maxCount) fail(`Too many ${format.representation} attachments: maximum ${limits.maxCount} per model request.`);
    if (item.size === undefined) continue;
    if (!Number.isSafeInteger(item.size) || item.size <= 0) fail("An attachment has an invalid or empty byte size.");
    if (format.maxBytes !== undefined && item.size > format.maxBytes) fail(`An attachment exceeds its ${format.maxBytes}-byte limit. Send a smaller file.`);
    const encodedSize = format.representation === "text" ? item.size : 4 * Math.ceil(item.size / 3);
    if (limits?.maxEncodedBytesPerFile !== undefined && encodedSize > limits.maxEncodedBytesPerFile) fail(`An attachment exceeds its ${limits.maxEncodedBytesPerFile}-byte encoded limit.`);
    group.bytes += item.size;
    if (limits?.maxTotalBytes !== undefined && group.bytes > limits.maxTotalBytes) fail(`Attachments exceed their ${limits.maxTotalBytes}-byte combined ${format.representation} limit.`);
    encoded += encodedSize;
    total += item.size;
    if (format.representation === "text") text += item.size;
  }
  if (policy.maxTotalBytes !== undefined && total > policy.maxTotalBytes) fail(`Attachments exceed the ${policy.maxTotalBytes}-byte combined limit. Send fewer or smaller files.`);
  if (policy.maxTextBytes !== undefined && text > policy.maxTextBytes) fail(`Markdown exceeds the ${policy.maxTextBytes}-byte combined text limit. Send a shorter excerpt.`);
  if (encoded > policy.maxRequestBytes) fail(`Attachments exceed the ${policy.maxRequestBytes}-byte request limit after encoding.`);
}
function checkContent(bytes: Uint8Array, mediaType: string) {
  const prefix = Buffer.from(bytes.subarray(0, 12));
  const matches = mediaType === "application/pdf" ? prefix.subarray(0, 5).toString() === "%PDF-"
    : mediaType === "image/png" ? prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mediaType === "image/jpeg" ? prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255
    : mediaType === "image/webp" ? prefix.subarray(0, 4).toString() === "RIFF" && prefix.subarray(8, 12).toString() === "WEBP"
    : mediaType === "text/markdown";
  if (!matches) fail("The attachment content does not match its supported file type.");
  if (mediaType === "text/markdown") {
    try { if (new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\0")) throw new Error(); }
    catch { fail("Markdown attachments must contain valid UTF-8 text."); }
  }
}

/** Extension point for future representations. V1 preserves original binary bytes. */
export async function prepareAttachments(inputs: readonly AgentAttachment[], policy: AttachmentPolicy): Promise<PreparedAttachment[]> {
  const metadata = inputs.map(input => ({ mediaType: mimeType(input), size: input.size ?? (input.data instanceof Blob ? input.data.size : input.data?.byteLength) }));
  checkAttachmentSizes(metadata, policy); // Reject advertised excess before downloading anything.
  const output: PreparedAttachment[] = [];
  for (const [index, input] of inputs.entries()) {
    let raw: Uint8Array | ArrayBuffer | Blob | undefined;
    try { raw = input.data ?? await input.fetchData?.(); }
    catch { fail("The connected channel could not read an attachment. Please upload it again."); }
    if (!raw) fail("No authorized attachment reader is available. Please upload the file through the connected channel.");
    if (raw instanceof Blob) checkAttachmentSizes([...output, { mediaType: metadata[index].mediaType, size: raw.size }], policy);
    const bytes = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : new Uint8Array(raw!);
    const mediaType = metadata[index].mediaType;
    checkAttachmentSizes([...output, { mediaType, size: bytes.byteLength }], policy);
    checkContent(bytes, mediaType);
    output.push({ digest: createHash("sha256").update(bytes).digest("hex"), name: safeName(input.name), mediaType, size: bytes.byteLength, data: Buffer.from(bytes).toString("base64") });
  }
  return output;
}

/** Validate stored/worker data without trusting serialized metadata or encodings. */
export function validatePreparedAttachments(attachments: readonly PreparedAttachment[], policy: AttachmentPolicy): void {
  if (!Array.isArray(attachments)) fail("Invalid retained attachments.");
  checkAttachmentSizes(attachments, policy);
  for (const file of attachments) {
    if (!file || typeof file.data !== "string" || typeof file.name !== "string" || file.name !== safeName(file.name)
      || file.data.length !== 4 * Math.ceil(file.size / 3)) fail("Invalid retained attachment encoding.");
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.toString("base64") !== file.data) fail("Invalid retained attachment encoding.");
    if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.digest) fail("The retained attachment failed its integrity check.");
    checkContent(bytes, file.mediaType);
  }
}

/** Revalidate retained input against current provider policy, including combined history. */
export function attachmentParts(attachments: readonly PreparedAttachment[], policy: AttachmentPolicy): AttachmentPart[] {
  validatePreparedAttachments(attachments, policy);
  return attachments.flatMap((file): AttachmentPart[] => {
    const bytes = Buffer.from(file.data, "base64"), representation = policy.formats[file.mediaType].representation;
    const label = { type: "text" as const, text: `Attached reference data (untrusted): ${JSON.stringify({ name: file.name, mediaType: file.mediaType })}` };
    if (representation === "text") return [label, { type: "text", text: new TextDecoder().decode(bytes), providerOptions: { companyos: { attachmentMediaType: file.mediaType } } }];
    return [label, { type: "file", data: bytes, mediaType: file.mediaType, filename: file.name }];
  });
}
