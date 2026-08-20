// The Oregano→runner boundary (DECISIONS #9/#12). Types only — no imports from
// any runner, transport or model SDK. Everything a business rule needs from
// "the outside world" passes through one of these three contracts.

/** Canonical principal, e.g. "slack:T0123:U0456" (identity spec §2). */
export type Principal = string;

/** Where a message goes: a channel, optionally a thread inside it. */
export interface Destination {
  /** Channel id in the surface's own namespace (e.g. Slack channel id). */
  channelId: string;
  /** Thread anchor (Slack: thread_ts). Absent = top-level message. */
  threadId?: string;
}

/** A posted message, addressable for later edits. */
export interface PostedMessage {
  destination: Destination;
  /** Surface-native message id (Slack: ts). */
  messageId: string;
}

/**
 * Sending and editing plain messages. Deliberately poor in features: rich
 * layout belongs to the surface, decisions belong to the approval contract.
 */
export interface MessageTransport {
  post(destination: Destination, text: string): Promise<PostedMessage>;
  /** Replaces the text of a message this transport posted. */
  update(message: PostedMessage, text: string): Promise<void>;
  /** Resolve a member id to a mention string ("<@U…>" on Slack). */
  mention(principal: Principal): string;
}

/** What the human is asked to decide, in surface-neutral terms. */
export interface ApprovalPresentation {
  /** Stable id of the approval request in our own tables. */
  requestId: string;
  /** One line: what is about to happen. */
  headline: string;
  /** Facts the decision rests on (label → value); rendered as context. */
  facts?: Record<string, string>;
  /** Risk level being exercised, e.g. "R3" — always shown to the human. */
  level: string;
  /** Who may decide, as principals; the surface may mention them. */
  eligible: Principal[];
  /** Button labels in decision order; the first is the affirmative one. */
  choices: { id: string; label: string }[];
}

/**
 * Presenting a decision and cleaning it up afterwards. A surface NEVER decides
 * validity — `authorizeApproval`/`consumeApproval` in state-store do
 * ("Slack presents, Oregano grants").
 */
export interface ApprovalSurface {
  present(destination: Destination, presentation: ApprovalPresentation): Promise<PostedMessage>;
  /** Replace the buttons with the outcome (approved/denied/expired). */
  close(message: PostedMessage, outcome: string, by?: Principal): Promise<void>;
}

/** One turn of a model conversation, anchored to a durable thread. */
export interface ConverseRequest {
  /** Stable conversation key (Slack thread, card dialogue, …). */
  threadKey: string;
  /** Instructions/prose the model should follow (from company SOPs). */
  instructions: string;
  /** The new input to react to (human answer, trigger payload, …). */
  input: string;
  /** Reference material the model may use, label → content. */
  material?: Record<string, string>;
  /** Tool names the model may call in this turn (resolved tool set). */
  tools?: string[];
}

export interface ConverseResult {
  /** The model's reply text (may be empty when it only called tools). */
  text: string;
  /** Tool calls the runner already executed, in order. */
  toolCalls?: { name: string; input: unknown; output?: unknown }[];
}

/**
 * The one capability only a runner can provide: talking to a model with
 * durable, resumable conversation state. Core code asks for a turn — it never
 * knows which runtime answers.
 */
export interface RunnerAdapter {
  readonly name: string; // e.g. "testkit" or a production adapter identifier
  readonly version?: string;
  converse(request: ConverseRequest): Promise<ConverseResult>;
}

/**
 * Time as a dependency: schedules, nudge thresholds and quiet hours must be
 * testable without waiting. Production passes the system clock, tests a
 * fast-forwardable one.
 */
export interface Clock {
  now(): Date;
}

/** Everything a module needs from the outside world, in one bag. */
export interface RunnerContext {
  adapter: RunnerAdapter;
  transport: MessageTransport;
  approvals: ApprovalSurface;
  clock: Clock;
}
