import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { attachmentPolicy, type AttachmentPolicyConfiguration, CORE_ATTACHMENT_POLICIES } from "../../../runner/attachment-policy.ts";
import { AttachmentInputError, checkAttachmentSizes } from "../../../runtime/attachments.ts";
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
    const metadata = files.map(file => {
      const format = Object.hasOwn(policy.formats, file.mediaType) ? policy.formats[file.mediaType] : undefined;
      if (!format || format.representation === "text") throw new AttachmentInputError("The selected model does not support this native file format.");
      if (file.data.type !== "data") throw new AttachmentInputError("Native file requests require authorized inline bytes; file URLs and provider IDs are not accepted.");
      const data = file.data.data;
      return { mediaType: file.mediaType, size: typeof data === "string" ? Buffer.byteLength(data, "base64") : data.byteLength };
    });
    for (const document of documents) {
      if (document.type !== "text") continue;
      const mediaType = String(document.providerOptions?.companyos?.attachmentMediaType);
      if (!Object.hasOwn(policy.formats, mediaType) || policy.formats[mediaType].representation !== "text") throw new AttachmentInputError("Unsupported attached text format.");
      metadata.push({ mediaType, size: Buffer.byteLength(document.text) });
    }
    checkAttachmentSizes(metadata, policy);
    // Count base64 expansion and the current text/tools together. This SDK-level estimate is rechecked on the serialized provider body at transport.
    const wireBytes = Buffer.byteLength(JSON.stringify(params, function (key, value) { const raw = this[key]; return raw instanceof Uint8Array ? Buffer.from(raw).toString("base64") : value; }));
    if (wireBytes > policy.maxRequestBytes) throw new AttachmentInputError("The model request with attachments is too large. Start a new conversation with less context.");
    return params;
  } };
}
export function withAttachmentLimits(model: LanguageModel, selection: ModelExecutionSelection): LanguageModel {
  if (typeof model === "string") return model;
  return wrapLanguageModel({ model, middleware: attachmentMiddleware(selection) });
}

/** Check the actual SDK-serialized JSON, including the provider envelope, before network I/O. */
export function attachmentPolicyFetch(selection: Pick<ModelExecutionSelection, "route" | "model">, fetcher: typeof fetch = (...args) => fetch(...args), configuration = CORE_ATTACHMENT_POLICIES): typeof fetch {
  return async (input, init) => {
    const policy = Object.hasOwn(configuration.providers, selection.route) ? configuration.providers[selection.route] : undefined;
    if (policy && typeof init?.body === "string" && Buffer.byteLength(init.body) > policy.maxRequestBytes) {
      throw new AttachmentInputError("The serialized provider request exceeds its configured request size limit.");
    }
    return fetcher(input, init);
  };
}
