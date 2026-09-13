import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { attachmentPolicy, type AttachmentPolicyConfiguration, CORE_ATTACHMENT_POLICIES } from "../../../runner/attachment-policy.ts";
import { AttachmentInputError } from "../../../runtime/attachments.ts";
import type { ModelExecutionSelection } from "../../../runner/model-execution.ts";

/** Runs again for every generated/streamed tool-loop step, before the provider call. */
export function attachmentMiddleware(selection: Pick<ModelExecutionSelection, "route" | "model">, configuration: AttachmentPolicyConfiguration = CORE_ATTACHMENT_POLICIES): LanguageModelMiddleware {
  return { specificationVersion: "v4", transformParams: async ({ params }) => {
    const direct = params.prompt.flatMap(message => typeof message.content === "string" ? [] : message.content.filter(part => part.type === "text" || part.type === "file"));
    const toolResults = params.prompt.flatMap(message => typeof message.content === "string" ? [] : message.content.filter(part => part.type === "tool-result"))
      .flatMap(part => part.output.type === "content" ? part.output.value.filter(value => value.type === "text" || value.type === "file") : []);
    const parts = [...direct, ...toolResults];
    const files = parts.filter(part => part.type === "file");
    const documents = parts.filter(part => part.type === "text" && typeof part.providerOptions?.companyos?.attachmentMediaType === "string");
    if (!files.length && !documents.length) return params;
    const policy = attachmentPolicy(selection, configuration);
    if (files.length + documents.length > policy.maxAttachments) throw new AttachmentInputError("The model request exceeds its configured attachment count.");
    let total = 0;
    for (const file of files) {
      const format = Object.hasOwn(policy.formats, file.mediaType) ? policy.formats[file.mediaType] : undefined;
      if (!format || format.representation === "text") throw new AttachmentInputError("The selected model does not support this native file format.");
      if (file.data.type !== "data") throw new AttachmentInputError("Native file requests require authorized inline bytes; file URLs and provider IDs are not accepted.");
      const data = file.data.data;
      const size = typeof data === "string" ? Buffer.byteLength(data, "base64") : data.byteLength;
      if (!size || size > format.maxBytes) throw new AttachmentInputError("A model attachment exceeds its configured file size limit.");
      total += size;
    }
    let textTotal = 0;
    for (const document of documents) {
      if (document.type !== "text") continue;
      const mediaType = String(document.providerOptions?.companyos?.attachmentMediaType);
      const format = Object.hasOwn(policy.formats, mediaType) ? policy.formats[mediaType] : undefined;
      const size = Buffer.byteLength(document.text);
      if (!format || format.representation !== "text" || !size || size > format.maxBytes) throw new AttachmentInputError("An attached text document exceeds its configured format or size limit.");
      total += size; textTotal += size;
    }
    if (textTotal > policy.maxTextBytes) throw new AttachmentInputError("Attached text exceeds its configured combined limit.");
    if (total > policy.maxTotalBytes) throw new AttachmentInputError("The model request exceeds its configured total attachment size.");
    // Count base64 expansion and the current text/tools together. Policy leaves provider-envelope headroom.
    const wireBytes = Buffer.byteLength(JSON.stringify(params, function (key, value) { const raw = this[key]; return raw instanceof Uint8Array ? Buffer.from(raw).toString("base64") : value; }));
    if (wireBytes > policy.maxRequestBytes) throw new AttachmentInputError("The model request with attachments is too large. Start a new conversation with less context.");
    return params;
  } };
}
export function withAttachmentLimits(model: LanguageModel, selection: ModelExecutionSelection): LanguageModel {
  if (typeof model === "string") return model;
  return wrapLanguageModel({ model, middleware: attachmentMiddleware(selection) });
}
