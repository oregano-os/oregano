// Runner no. 2 (DECISIONS #12): the deliberately primitive implementation of
// the runner contracts. Messages land in an in-memory outbox, model turns are
// scripted, the clock can be fast-forwarded. Every core test runs through this
// adapter — so a runner-specific import in a core package breaks the tests, not
// production.
import type {
  ApprovalPresentation,
  ApprovalSurface,
  Clock,
  ConverseRequest,
  ConverseResult,
  Destination,
  MessageTransport,
  PostedMessage,
  Principal,
  RunnerAdapter,
  RunnerContext,
} from "../../runner/interfaces.ts";

export interface OutboxEntry {
  kind: "message" | "approval";
  destination: Destination;
  messageId: string;
  text: string;
  /** Present for approvals: what was asked. */
  presentation?: ApprovalPresentation;
  /** Present once an approval was closed. */
  outcome?: string;
  closedBy?: Principal;
  at: Date;
}

/** Fast-forwardable clock: tests advance time instead of waiting for it. */
export class TestClock implements Clock {
  #now: Date;
  constructor(start: string | Date = "2026-08-03T08:00:00.000Z") {
    this.#now = new Date(start);
  }
  now(): Date {
    return new Date(this.#now);
  }
  advanceHours(hours: number): void {
    this.#now = new Date(this.#now.getTime() + hours * 3_600_000);
  }
  advanceMinutes(minutes: number): void {
    this.#now = new Date(this.#now.getTime() + minutes * 60_000);
  }
  set(when: string | Date): void {
    this.#now = new Date(when);
  }
}

/** Slack/Monday stand-in: records everything, sends nothing. */
export class TestTransport implements MessageTransport {
  readonly outbox: OutboxEntry[] = [];
  #seq = 0;
  readonly #clock: Clock;
  constructor(clock: Clock = new TestClock()) {
    this.#clock = clock;
  }

  #id(): string {
    this.#seq += 1;
    return `msg_${this.#seq}`;
  }

  async post(destination: Destination, text: string): Promise<PostedMessage> {
    const messageId = this.#id();
    this.outbox.push({ kind: "message", destination, messageId, text, at: this.#clock.now() });
    return { destination, messageId };
  }

  async update(message: PostedMessage, text: string): Promise<void> {
    const entry = this.outbox.find((e) => e.messageId === message.messageId);
    if (!entry) throw new Error(`update: unknown message ${message.messageId}`);
    entry.text = text;
  }

  mention(principal: Principal): string {
    return `<@${principal.split(":").pop()}>`;
  }

  /** Test helpers — assertions read these instead of parsing Slack. */
  texts(): string[] {
    return this.outbox.map((e) => e.text);
  }
  inThread(threadId: string): OutboxEntry[] {
    return this.outbox.filter((e) => e.destination.threadId === threadId);
  }
  approvals(): OutboxEntry[] {
    return this.outbox.filter((e) => e.kind === "approval");
  }
  clear(): void {
    this.outbox.length = 0;
  }
}

/** Approval surface stand-in: presents into the same outbox, decides nothing. */
export class TestApprovalSurface implements ApprovalSurface {
  readonly #transport: TestTransport;
  constructor(transport: TestTransport) {
    this.#transport = transport;
  }

  async present(destination: Destination, presentation: ApprovalPresentation): Promise<PostedMessage> {
    const posted = await this.#transport.post(
      destination,
      `[${presentation.level}] ${presentation.headline}`,
    );
    const entry = this.#transport.outbox.find((e) => e.messageId === posted.messageId)!;
    entry.kind = "approval";
    entry.presentation = presentation;
    return posted;
  }

  async close(message: PostedMessage, outcome: string, by?: Principal): Promise<void> {
    const entry = this.#transport.outbox.find((e) => e.messageId === message.messageId);
    if (!entry) throw new Error(`close: unknown message ${message.messageId}`);
    entry.outcome = outcome;
    entry.closedBy = by;
  }
}

/**
 * Scripted model: answers from a queue (or a matcher function), records what it
 * was asked. Deterministic and free — the default for engine tests.
 */
export class ScriptedAdapter implements RunnerAdapter {
  readonly name = "testkit";
  readonly version = "0";
  readonly requests: ConverseRequest[] = [];
  #queue: ConverseResult[] = [];
  #matcher?: (request: ConverseRequest) => ConverseResult;

  constructor(script?: (ConverseResult | string)[] | ((request: ConverseRequest) => ConverseResult)) {
    if (typeof script === "function") this.#matcher = script;
    else if (script) this.#queue = script.map((s) => (typeof s === "string" ? { text: s } : s));
  }

  /** Queue another answer for a later turn. */
  reply(result: ConverseResult | string): void {
    this.#queue.push(typeof result === "string" ? { text: result } : result);
  }

  async converse(request: ConverseRequest): Promise<ConverseResult> {
    this.requests.push(request);
    if (this.#matcher) return this.#matcher(request);
    const next = this.#queue.shift();
    if (!next) {
      throw new Error(
        `ScriptedAdapter: no scripted answer left for thread ${request.threadKey} ` +
        `(input: ${request.input.slice(0, 60)}…)`,
      );
    }
    return next;
  }
}

/** One call to wire a complete test world. */
export function testContext(options: {
  clock?: TestClock;
  script?: (ConverseResult | string)[] | ((request: ConverseRequest) => ConverseResult);
} = {}): RunnerContext & { clock: TestClock; transport: TestTransport; adapter: ScriptedAdapter } {
  const clock = options.clock ?? new TestClock();
  const transport = new TestTransport(clock);
  return {
    clock,
    transport,
    approvals: new TestApprovalSurface(transport),
    adapter: new ScriptedAdapter(options.script),
  };
}
