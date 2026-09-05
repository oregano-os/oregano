export type SlackFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SlackApiReceipt {
  requestId?: string;
  scopes: string[];
}

export interface SlackApiResult<T> extends SlackApiReceipt {
  data: T;
}

type SlackEnvelope<T> = T & {
  ok?: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
};

const tokenList = (value: string | null): string[] => value
  ? [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))].sort()
  : [];

const text = (value: string, label: string): string => {
  if (!value) throw new Error(`${label} must be non-empty`);
  return value;
};

/** Minimal Slack Web API client used only by the read-only Record Source boundary. */
export class SlackWebApiClient {
  readonly token: string;
  readonly fetcher: SlackFetch;
  readonly endpoint: string;

  constructor(args: { token: string; fetcher?: SlackFetch; endpoint?: string }) {
    this.token = text(args.token, "Slack client token");
    this.fetcher = args.fetcher ?? fetch;
    this.endpoint = args.endpoint ?? "https://slack.com/api";
  }

  async call<T extends Record<string, unknown>>(method: string, parameters: Record<string, string | number | boolean | undefined> = {}): Promise<SlackApiResult<T>> {
    if (!/^[a-z][a-z.]+$/.test(method)) throw new Error(`Slack API method '${method}' is invalid`);
    const url = new URL(`${this.endpoint.replace(/\/$/, "")}/${method}`);
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await this.fetcher(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new Error(`Slack API rate limited '${method}'${retryAfter ? `; retry after ${retryAfter} seconds` : ""}`);
    }
    if (!response.ok) throw new Error(`Slack API '${method}' failed with HTTP ${response.status}`);
    const envelope = await response.json() as SlackEnvelope<T>;
    if (envelope.ok !== true) throw new Error(`Slack API '${method}' failed: ${envelope.error ?? "unknown error"}`);
    return {
      data: envelope,
      requestId: response.headers.get("x-slack-req-id") ?? undefined,
      scopes: tokenList(response.headers.get("x-oauth-scopes")),
    };
  }

  authTest() {
    return this.call<{ ok: true; team_id: string; user_id: string; bot_id?: string }>("auth.test");
  }

  conversationInfo(channel: string) {
    return this.call<{ ok: true; channel: Record<string, unknown> }>("conversations.info", { channel });
  }

  history(args: { channel: string; oldest: string; latest?: string; limit: number; cursor?: string }) {
    return this.call<{
      ok: true;
      messages: Array<Record<string, unknown>>;
      has_more?: boolean;
      is_limited?: boolean;
      response_metadata?: { next_cursor?: string };
    }>("conversations.history", {
      channel: args.channel,
      oldest: args.oldest,
      latest: args.latest,
      inclusive: true,
      limit: args.limit,
      cursor: args.cursor,
    });
  }

  replies(args: { channel: string; ts: string; oldest: string; latest?: string; limit: number; cursor?: string }) {
    return this.call<{
      ok: true;
      messages: Array<Record<string, unknown>>;
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>("conversations.replies", {
      channel: args.channel,
      ts: args.ts,
      oldest: args.oldest,
      latest: args.latest,
      inclusive: true,
      limit: args.limit,
      cursor: args.cursor,
    });
  }
}
