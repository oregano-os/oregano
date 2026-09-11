import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { resolvePromptCachingMode, type ModelExecutionSelection } from "../../../runner/model-execution.ts";

type Options = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"]["providerOptions"];
const hasCacheControl = (options: Options): boolean =>
  options?.anthropic?.cacheControl != null || options?.anthropic?.cache_control != null;

/** Preserve explicit caller strategies; never mix their breakpoints or TTLs. */
export function promptCachingMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      if (hasCacheControl(params.providerOptions)
        || params.tools?.some(tool => tool.type === "function" && hasCacheControl(tool.providerOptions))
        || params.prompt.some(message => hasCacheControl(message.providerOptions)
          || (Array.isArray(message.content) && message.content.some(part => hasCacheControl(part.providerOptions))))) return params;

      const mark = (options: Options) => ({ ...options, anthropic: { ...options?.anthropic, cacheControl: { type: "ephemeral" } } });
      // The first system block is the stable Agent contract. Later system
      // blocks may contain current work, timestamps or retrieved evidence.
      const firstSystem = params.prompt.findIndex(message => message.role === "system" && message.content.trim().length > 0);
      const lastTool = params.tools?.reduce((last, tool, index) => tool.type === "function" ? index : last, -1) ?? -1;
      return {
        ...params,
        // Automatic conversation caching moves forward within each tool loop.
        // With tools and the stable system prefix this uses at most 3 slots.
        providerOptions: mark(params.providerOptions),
        prompt: params.prompt.map((message, index) => index === firstSystem
          ? { ...message, providerOptions: mark(message.providerOptions) } : message),
        ...(params.tools ? { tools: params.tools.map((tool, index) => index === lastTool && tool.type === "function"
          ? { ...tool, providerOptions: mark(tool.providerOptions) } : tool) } : {}),
      };
    },
  };
}

/** Model execution is shared by every Agent and communication adapter. */
export function withPromptCaching(model: LanguageModel, selection: ModelExecutionSelection): LanguageModel {
  if (resolvePromptCachingMode(selection) !== "auto" || selection.transport !== "anthropic-messages" || typeof model === "string") return model;
  // OpenAI already caches eligible prefixes. Gateway and compatible routes
  // retain native behavior until their own cache contracts are supported.
  return wrapLanguageModel({ model, middleware: promptCachingMiddleware() });
}
