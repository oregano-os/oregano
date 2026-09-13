import type { StateAdapter } from "chat";
import { attachmentPolicy } from "../../../runner/attachment-policy.ts";
import type { ModelExecutionSelection } from "../../../runner/model-execution.ts";
import { AttachmentInputError, checkAttachmentSizes, attachmentParts, prepareAttachments, validatePreparedAttachments, type AgentAttachment, type AttachmentReference, type PreparedAttachment } from "../../../runtime/attachments.ts";
import { sha256 } from "../../../runtime/canonical.ts";

type AttachmentStore = Pick<StateAdapter, "get" | "set">;
type Selection = Pick<ModelExecutionSelection, "route" | "model">;
interface RetainedAttachment { instanceId: string; source: string; messageId: string; file: PreparedAttachment }
const TTL = 30 * 24 * 60 * 60 * 1000;

/** Called only after ingress identity and conversation access are verified. */
export async function retainAttachments(args: {
  store: AttachmentStore; instanceId: string; source: string; messageId: string;
  attachments: readonly AgentAttachment[]; selection: Selection;
}): Promise<AttachmentReference[]> {
  if (!args.attachments.length) return [];
  const files = await prepareAttachments(args.attachments, attachmentPolicy(args.selection));
  const refs: AttachmentReference[] = [];
  for (const file of files) {
    const key = `agent-attachment:${sha256([args.instanceId, args.source, args.messageId, file.digest, file.name])}`;
    await args.store.set(key, { instanceId: args.instanceId, source: args.source, messageId: args.messageId, file } satisfies RetainedAttachment, TTL);
    refs.push({ key, name: file.name, mediaType: file.mediaType, size: file.size });
  }
  return refs;
}

/** References come from the authorized current message/history, never a model-selected key. */
export async function loadAttachments(args: { store: AttachmentStore; instanceId: string; references: readonly AttachmentReference[]; selection: Selection }): Promise<PreparedAttachment[]> {
  const refs = [...new Map(args.references.map(ref => [ref.key, ref])).values()];
  if (!refs.length) return [];
  const policy = attachmentPolicy(args.selection);
  checkAttachmentSizes(refs, policy);
  const files: PreparedAttachment[] = [];
  for (const ref of refs) {
    if (!/^agent-attachment:[a-f0-9]{64}$/.test(ref.key)) throw new AttachmentInputError("Invalid attachment reference.");
    const record = await args.store.get<RetainedAttachment>(ref.key);
    if (!record || record.instanceId !== args.instanceId || record.file.name !== ref.name || record.file.mediaType !== ref.mediaType || record.file.size !== ref.size) {
      throw new AttachmentInputError("A referenced attachment is no longer available. Please upload it again in a new thread.");
    }
    files.push(record.file);
  }
  // Includes integrity, actual size, current model support and aggregate history limits.
  validatePreparedAttachments(files, policy);
  return files;
}
export async function agentAttachmentContent(args: { text: string; store: AttachmentStore; instanceId: string; references: readonly AttachmentReference[]; selection: Selection }) {
  if (!args.references.length) return args.text;
  const files = await loadAttachments(args);
  return [{ type: "text" as const, text: args.text }, ...await attachmentParts(files, attachmentPolicy(args.selection))];
}

/** Human file references are shared by authorized Agents in this exact conversation, not private Agent transcripts. */
export const conversationAttachmentKey = (instanceId: string, conversationId: string) => `conversation-files:${sha256([instanceId, conversationId])}`;
export async function conversationAttachments(store: Pick<StateAdapter, "getList">, instanceId: string, conversationId: string): Promise<AttachmentReference[]> {
  const turns = await store.getList<{ attachments: AttachmentReference[] }>(conversationAttachmentKey(instanceId, conversationId));
  return [...new Map(turns.flatMap(turn => turn.attachments).map(ref => [ref.key, ref])).values()];
}
