import type { JsonValue } from "../../capabilities/contracts.ts";
import type { MondayGraphqlResponse, MondayResourceBinding, MondayResourceDiscovery, MondayWorkItem } from "./contracts.ts";

export type MondayFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export class MondayClient {
  readonly token: string;
  readonly apiVersion: string;
  readonly fetcher: MondayFetch;
  readonly endpoint: string;

  constructor(args: { token: string; apiVersion: string; fetcher?: MondayFetch; endpoint?: string }) {
    if (!args.token) throw new Error("Monday client requires an Instance-injected token");
    if (!args.apiVersion) throw new Error("Monday client requires an explicit API version");
    this.token = args.token;
    this.apiVersion = args.apiVersion;
    this.fetcher = args.fetcher ?? fetch;
    this.endpoint = args.endpoint ?? "https://api.monday.com/v2";
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<MondayGraphqlResponse<T>> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.token,
        "api-version": this.apiVersion,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Monday GraphQL request failed with HTTP ${response.status}`);
    const envelope = await response.json() as GraphqlEnvelope<T>;
    if (envelope.errors?.length) throw new Error(`Monday GraphQL request failed: ${envelope.errors.map((error) => error.message ?? "unknown error").join("; ")}`);
    if (!envelope.data) throw new Error("Monday GraphQL response did not contain data");
    return {
      data: envelope.data,
      apiVersion: response.headers.get("api-version"),
      requestId: response.headers.get("x-request-id"),
    };
  }

  async discoverResources(boardIds: string[]): Promise<MondayGraphqlResponse<MondayResourceDiscovery>> {
    const requested = [...new Set(boardIds.map(String))];
    if (requested.length === 0 || requested.length > 20) throw new Error("Monday resource discovery requires between one and twenty exact board ids");
    for (const boardId of requested) if (!/^\d{1,20}$/.test(boardId)) throw new Error(`Monday board id '${boardId}' is invalid`);
    const response = await this.graphql<{
      me: { id: string; name: string; account: { id: string; name: string } };
      boards: Array<{
        id: string;
        name: string;
        board_kind: string;
        state: string;
        permissions: string;
        workspace: { id: string; name: string } | null;
        groups: Array<{ id: string; title: string; archived?: boolean; deleted?: boolean }>;
        columns: Array<{ id: string; title: string; type: string; archived?: boolean; revision?: string | null; settings_str?: string | null }>;
      }>;
    }>(`query DiscoverCompanyOSResources($boardIds: [ID!]!) {
      me { id name account { id name } }
      boards(ids: $boardIds) {
        id name board_kind state permissions
        workspace { id name }
        groups { id title archived deleted }
        columns { id title type archived revision settings_str }
      }
    }`, { boardIds: requested });
    const byId = new Map(response.data.boards.map((board) => [String(board.id), board]));
    const missing = requested.filter((boardId) => !byId.has(boardId));
    if (missing.length > 0) throw new Error(`Monday did not return explicitly selected board(s): ${missing.join(", ")}`);
    return {
      ...response,
      data: {
        actor: { id: String(response.data.me.id), name: response.data.me.name },
        account: { id: String(response.data.me.account.id), name: response.data.me.account.name },
        boards: requested.map((boardId) => {
          const board = byId.get(boardId)!;
          return {
            id: String(board.id),
            name: board.name,
            boardKind: board.board_kind,
            state: board.state,
            permissions: board.permissions,
            workspace: board.workspace ? { id: String(board.workspace.id), name: board.workspace.name } : null,
            groups: board.groups.map((group) => ({
              id: String(group.id), title: group.title, archived: group.archived === true, deleted: group.deleted === true,
            })),
            columns: board.columns.map((column) => ({
              id: String(column.id), title: column.title, type: column.type, archived: column.archived === true,
              revision: column.revision ?? null, settings: column.settings_str ?? null,
            })),
          };
        }),
      },
    };
  }

  async readWorkItem(binding: MondayResourceBinding, workItemId: string, logicalFields?: string[]): Promise<MondayGraphqlResponse<MondayWorkItem>> {
    const fields = logicalFields ?? Object.keys(binding.fields);
    for (const field of fields) if (!binding.fields[field]) throw new Error(`Monday resource binding '${binding.id}' does not expose field '${field}'`);
    const response = await this.graphql<{
      items: Array<{
        id: string; name: string; updated_at: string; board: { id: string }; group: { id: string };
        column_values: Array<{ id: string; text: string; value: string | null }>;
      }>;
    }>(`query ReadWorkItem($ids: [ID!]!, $columnIds: [String!]) {
      items(ids: $ids) {
        id name updated_at board { id } group { id }
        column_values(ids: $columnIds) { id text value }
      }
    }`, { ids: [workItemId], columnIds: fields.map((field) => binding.fields[field]) });
    const item = response.data.items[0];
    if (!item) throw new Error(`Monday work item '${workItemId}' was not found`);
    if (String(item.board.id) !== binding.boardId) throw new Error(`Monday work item '${workItemId}' is outside resource binding '${binding.id}'`);
    const logicalByProvider = new Map(Object.entries(binding.fields).map(([logical, provider]) => [provider, logical]));
    const values: Record<string, JsonValue> = {};
    for (const column of item.column_values) {
      const logical = logicalByProvider.get(column.id);
      if (!logical) continue;
      if (column.value === null) values[logical] = column.text;
      else {
        try { values[logical] = JSON.parse(column.value) as JsonValue; }
        catch { values[logical] = column.text; }
      }
    }
    return {
      ...response,
      data: {
        id: String(item.id), title: item.name, boardId: String(item.board.id), groupId: String(item.group.id),
        providerVersion: item.updated_at, fields: values,
      },
    };
  }

  async updateWorkItem(binding: MondayResourceBinding, workItemId: string, changes: Record<string, JsonValue>): Promise<MondayGraphqlResponse<{ id: string }>> {
    if (binding.permission !== "read-write") throw new Error(`Monday resource binding '${binding.id}' is read-only`);
    const providerChanges: Record<string, JsonValue> = {};
    for (const [logical, value] of Object.entries(changes)) {
      const provider = binding.fields[logical];
      if (!provider) throw new Error(`Monday resource binding '${binding.id}' does not allow field '${logical}'`);
      providerChanges[provider] = value;
    }
    if (Object.keys(providerChanges).length === 0) throw new Error("Monday work-item update requires at least one allowed field");
    return this.graphql<{ id: string }>(`mutation UpdateWorkItem($boardId: ID!, $itemId: ID!, $values: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id }
    }`, { boardId: binding.boardId, itemId: workItemId, values: JSON.stringify(providerChanges) });
  }

  async comment(binding: MondayResourceBinding, workItemId: string, body: string): Promise<MondayGraphqlResponse<{ create_update: { id: string; created_at?: string } }>> {
    if (binding.permission !== "read-write") throw new Error(`Monday resource binding '${binding.id}' is read-only`);
    return this.graphql(`mutation CommentOnWorkItem($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id created_at }
    }`, { itemId: workItemId, body });
  }
}
