import { Plan, StreamingPlan, type StateAdapter, type StreamChunk, type Thread } from "chat";

export interface SlackAgentExperienceConfiguration {
  enabled: boolean;
  streamingEnabled: boolean;
  workingStatus: "Working";
}

const VALIDATED_RESPONSE_MIN_CHUNK_SIZE = 160;
const VALIDATED_RESPONSE_MAX_CHUNKS = 16;
const VALIDATED_RESPONSE_CHUNK_INTERVAL_MS = 160;

function validatedResponseChunks(response: string): string[] {
  const chunkSize = Math.max(
    VALIDATED_RESPONSE_MIN_CHUNK_SIZE,
    Math.ceil(response.length / VALIDATED_RESPONSE_MAX_CHUNKS),
  );
  if (response.length <= chunkSize) return [response];
  const chunks: string[] = [];
  for (let offset = 0; offset < response.length; offset += chunkSize) {
    chunks.push(response.slice(offset, offset + chunkSize));
  }
  return chunks;
}

/**
 * Streams only an already-validated presentation. Fixed-size slicing preserves
 * the exact response bytes while giving Slack several paced native append
 * events for longer answers. The short interval prevents Slack clients from
 * visually batching every append into one final update. The dynamic size caps
 * the added presentation time for unusually long answers. Chat SDK heals
 * incomplete Markdown in intermediate renders.
 */
export function validatedSlackResponsePlan(
  response: string,
  options?: { readonly suspended?: boolean },
): StreamingPlan {
  const stream = (async function* (): AsyncGenerator<StreamChunk> {
    const chunks = validatedResponseChunks(response);
    for (const [index, text] of chunks.entries()) {
      yield { type: "markdown_text", text };
      if (index < chunks.length - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, VALIDATED_RESPONSE_CHUNK_INTERVAL_MS));
      }
    }
  })();
  return new StreamingPlan(stream, {
    sessionStatus: options?.suspended ? "suspended" : "active",
  });
}

function toolProgressTitle(toolName: string): string {
  const words = toolName
    .replace(/^oregano_/u, "")
    .replace(/^companyos_/u, "")
    .split(/_+/u)
    .filter(Boolean)
    .join(" ");
  return words ? `Run ${words}` : "Run CompanyOS tool";
}

/** Returns true only for a completed Tool result that explicitly waits on a human. */
export function toolResultNeedsHumanInput(output: unknown): boolean {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return false;
  const value = output as Record<string, unknown>;
  return value.pendingApproval === true || value.pendingConfirmation === true;
}

export interface SlackToolProgressReporter {
  start(input: { readonly id: string; readonly toolName: string }): Promise<void>;
  finish(input: {
    readonly id: string;
    readonly succeeded: boolean;
    readonly waitingForHuman?: boolean;
  }): Promise<void>;
  complete(input?: { readonly waitingForHuman?: boolean }): Promise<void>;
  fail(): Promise<void>;
}

/**
 * Shows provider-native task progress without exposing Tool inputs, outputs, or
 * provisional model prose. Presentation failures remain best effort and never
 * change CompanyOS execution semantics.
 */
export function createSlackToolProgressReporter(
  thread: Pick<Thread, "post">,
  configuration: SlackAgentExperienceConfiguration,
): SlackToolProgressReporter {
  let planPromise: Promise<Plan> | undefined;
  let disabled = !configuration.streamingEnabled;
  const taskIds = new Map<string, string>();

  const safely = async (operation: () => Promise<void>): Promise<void> => {
    if (disabled) return;
    try {
      await operation();
    } catch {
      disabled = true;
    }
  };

  return {
    async start({ id, toolName }) {
      await safely(async () => {
        const title = toolProgressTitle(toolName);
        const createsPlan = !planPromise;
        planPromise ??= (async () => {
          const plan = new Plan({ initialMessage: title });
          await thread.post(plan);
          return plan;
        })();
        const plan = await planPromise;
        if (createsPlan) {
          const task = plan.currentTask;
          if (task) taskIds.set(id, task.id);
          return;
        }
        const task = await plan.addTask({
          title,
          autoCompletePrevious: false,
        });
        if (task) taskIds.set(id, task.id);
      });
    },
    async finish({ id, succeeded, waitingForHuman }) {
      await safely(async () => {
        if (!planPromise) return;
        const plan = await planPromise;
        const taskId = taskIds.get(id);
        await plan.updateTask({
          ...(taskId ? { id: taskId } : {}),
          status: succeeded ? "complete" : "error",
          output: waitingForHuman
            ? "Waiting for human approval"
            : succeeded ? "Completed" : "Failed",
        });
      });
    },
    async complete({ waitingForHuman } = {}) {
      if (!planPromise) return;
      await safely(async () => {
        const plan = await planPromise!;
        await plan.complete({
          completeMessage: waitingForHuman ? "Waiting for human approval" : "CompanyOS tools complete",
        });
      });
    },
    async fail() {
      if (!planPromise) return;
      await safely(async () => {
        const plan = await planPromise!;
        for (const task of plan.tasks) {
          if (task.status === "in_progress") {
            await plan.updateTask({ id: task.id, status: "error", output: "Failed" });
          }
        }
      });
    },
  };
}

const SLACK_ROOT_MESSAGE_ID = /^\d{10,}\.\d+$/u;
const SLACK_AGENT_SESSION_BRIDGE_TTL_MS = 2 * 60 * 60 * 1000;

function agentSessionConversationKey(sessionThreadId: string): string {
  return `slack:agent-session-conversation:${sessionThreadId}`;
}

export function resolveSlackAgentExperience(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SlackAgentExperienceConfiguration {
  return {
    enabled: environment.COMPANYOS_SLACK_AGENT_VIEW === "true",
    streamingEnabled: environment.COMPANYOS_SLACK_AGENT_VIEW === "true",
    workingStatus: "Working",
  };
}

/**
 * Stream only text whose provider-visible form cannot be changed by a later
 * CompanyOS trust check. Granted business Tool loops, required Knowledge
 * grounding, and Builder turns remain buffered until their final presentation
 * has been validated. An internal Agent-handoff control is not a business Tool.
 */
export function shouldStreamSlackAgentResponse(input: {
  configuration: SlackAgentExperienceConfiguration;
  agentId: string;
  knowledgeRouteKind: "auto" | "required-search";
  businessToolCount: number;
}): boolean {
  return input.configuration.streamingEnabled
    && input.agentId !== "builder"
    && input.knowledgeRouteKind === "auto"
    && input.businessToolCount === 0;
}

/**
 * Agent View assigns one session to each Slack root message. A DM that was
 * subscribed before Agent View was enabled can still arrive under the legacy
 * channel-wide thread id (`slack:<channel>:`). Use the accepted inbound root
 * message for the Agent Session presentation and reply while the durable
 * legacy conversation and its Agent assignment remain unchanged.
 */
export function resolveSlackAgentSessionThreadId(
  threadId: string,
  messageId: string,
  configuration: SlackAgentExperienceConfiguration,
): string {
  if (!configuration.enabled) return threadId;
  const parts = threadId.split(":");
  if (parts.length !== 3 || parts[0] !== "slack" || !parts[1]?.startsWith("D") || parts[2]) return threadId;
  if (!SLACK_ROOT_MESSAGE_ID.test(messageId)) return threadId;
  return `slack:${parts[1]}:${messageId}`;
}

/**
 * Preserve an exact, short-lived bridge for DMs that still execute under the
 * legacy channel-wide conversation id. Slack sends native stop events for the
 * per-message Agent Session id, so the event handler needs this durable mapping
 * to cancel the correct CompanyOS turn across serverless invocations.
 */
export async function rememberSlackAgentSessionConversation(
  state: Pick<StateAdapter, "set">,
  sessionThreadId: string,
  conversationThreadId: string,
  configuration: SlackAgentExperienceConfiguration,
): Promise<void> {
  if (!configuration.enabled || sessionThreadId === conversationThreadId) return;
  await state.set(
    agentSessionConversationKey(sessionThreadId),
    conversationThreadId,
    SLACK_AGENT_SESSION_BRIDGE_TTL_MS,
  );
}

/**
 * Chat SDK cancels native per-message sessions directly. This bridge handles
 * only pre-Agent-View DMs whose active turn is still keyed by the legacy
 * CompanyOS conversation id.
 */
export async function abortRememberedSlackAgentSessionConversation(
  chat: { abortTurn(threadId: string): Promise<void> },
  state: Pick<StateAdapter, "delete" | "get">,
  sessionThreadId: string,
  configuration: SlackAgentExperienceConfiguration,
): Promise<boolean> {
  if (!configuration.enabled) return false;
  const key = agentSessionConversationKey(sessionThreadId);
  const conversationThreadId = await state.get<string>(key);
  if (!conversationThreadId || conversationThreadId === sessionThreadId) return false;
  await chat.abortTurn(conversationThreadId);
  await state.delete(key);
  return true;
}

/**
 * Combine the platform stop signal with the configured model timeout. A Slack
 * stop therefore cancels upstream generation without weakening the existing
 * timeout boundary.
 */
export function resolveSlackTurnAbortSignal(
  platformSignal: AbortSignal,
  timeoutMs: number | undefined,
): AbortSignal {
  if (timeoutMs === undefined) return platformSignal;
  return AbortSignal.any([platformSignal, AbortSignal.timeout(timeoutMs)]);
}

/**
 * Provider presentation is deliberately best effort. CompanyOS authorization,
 * Agent resolution, model execution, and the resulting response must not fail
 * merely because Slack cannot display an optional status indicator.
 */
export async function showSlackAgentWorking(
  thread: Pick<Thread, "startTyping">,
  configuration: SlackAgentExperienceConfiguration,
): Promise<void> {
  if (!configuration.enabled) return;
  try {
    await thread.startTyping(configuration.workingStatus);
  } catch {
    // The Slack adapter logs provider failures. Keep the accepted turn running.
  }
}
