import type { JsonValue } from "../../capabilities/contracts.ts";
import type {
  MondayGraphqlResponse,
  MondayAgentResourceDiscovery,
  MondayRecordInventory,
  MondayRecordObject,
  MondayResourceBinding,
  MondayResourceDiscovery,
  MondayWorkItem,
} from "./contracts.ts";

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
        access_level: string;
        workspace: { id: string; name: string } | null;
        groups: Array<{ id: string; title: string; archived?: boolean; deleted?: boolean }>;
        columns: Array<{ id: string; title: string; type: string; archived?: boolean; revision?: string | null; settings?: JsonValue | null }>;
      }>;
    }>(`query DiscoverCompanyOSResources($boardIds: [ID!]!) {
      me { id name account { id name } }
      boards(ids: $boardIds) {
        id name board_kind state permissions access_level
        workspace { id name }
        groups { id title archived deleted }
        columns { id title type archived revision settings }
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
            accessLevel: board.access_level,
            workspace: board.workspace ? { id: String(board.workspace.id), name: board.workspace.name } : null,
            groups: board.groups.map((group) => ({
              id: String(group.id), title: group.title, archived: group.archived === true, deleted: group.deleted === true,
            })),
            columns: board.columns.map((column) => ({
              id: String(column.id), title: column.title, type: column.type, archived: column.archived === true,
              revision: column.revision ?? null, settings: column.settings ?? null,
            })),
          };
        }),
      },
    };
  }

  async discoverAgentResources(args: { agentId: string; boardIds: string[] }): Promise<MondayGraphqlResponse<MondayAgentResourceDiscovery>> {
    const agentId = String(args.agentId);
    if (!/^\d{1,20}$/.test(agentId)) throw new Error(`Monday external Agent id '${agentId}' is invalid`);
    const requested = [...new Set(args.boardIds.map(String))].sort();
    if (requested.length === 0 || requested.length > 20) throw new Error("Monday Agent resource discovery requires between one and twenty exact board ids");
    for (const boardId of requested) if (!/^\d{1,20}$/.test(boardId)) throw new Error(`Monday board id '${boardId}' is invalid`);
    const response = await this.graphql<{
      me: { id: string; name: string; kind: string; email: string; account: { id: string; name: string } };
      boards: Array<{
        id: string;
        name: string;
        board_kind: string;
        state: string;
        permissions: string;
        access_level: string;
        workspace: { id: string; name: string } | null;
        groups: Array<{ id: string; title: string; archived?: boolean; deleted?: boolean }>;
        columns: Array<{ id: string; title: string; type: string; archived?: boolean; revision?: string | null; settings?: JsonValue | null }>;
      }>;
    }>(`query QualifyCompanyOSExternalAgent($boardIds: [ID!]!) {
      me { id name kind email account { id name } }
      boards(ids: $boardIds) {
        id name board_kind state permissions access_level
        workspace { id name }
        groups { id title archived deleted }
        columns { id title type archived revision settings }
      }
    }`, { boardIds: requested });
    const externalAgentId = /^agent-(\d+)@agent\.monday\.com$/i.exec(response.data.me.email ?? "")?.[1] ?? null;
    const byId = new Map(response.data.boards.map((board) => [String(board.id), board]));
    const missing = requested.filter((boardId) => !byId.has(boardId));
    if (missing.length > 0) throw new Error(`Monday did not return explicitly selected board(s): ${missing.join(", ")}`);
    return {
      ...response,
      data: {
        identity: {
          memberId: String(response.data.me.id),
          name: response.data.me.name,
          kind: response.data.me.kind,
          email: response.data.me.email,
          externalAgentId,
        },
        account: { id: String(response.data.me.account.id), name: response.data.me.account.name },
        boards: requested.map((boardId) => {
          const board = byId.get(boardId)!;
          return {
            id: String(board.id),
            name: board.name,
            boardKind: board.board_kind,
            state: board.state,
            permissions: board.permissions,
            accessLevel: board.access_level,
            workspace: board.workspace ? { id: String(board.workspace.id), name: board.workspace.name } : null,
            groups: board.groups.map((group) => ({
              id: String(group.id), title: group.title, archived: group.archived === true, deleted: group.deleted === true,
            })),
            columns: board.columns.map((column) => ({
              id: String(column.id), title: column.title, type: column.type, archived: column.archived === true,
              revision: column.revision ?? null, settings: column.settings ?? null,
            })),
          };
        }),
      },
    };
  }

  async readCompleteRecordInventory(args: {
    boardId: string;
    columnIds: string[];
    groupIds?: string[];
    pageSize?: number;
    maxPages?: number;
    maxObjects?: number;
    inventoryMode?: "selected-items" | "complete-table";
    allowedSubitemBoardIds?: string[];
  }): Promise<MondayRecordInventory> {
    const boardId = String(args.boardId);
    if (!/^\d{1,20}$/.test(boardId)) throw new Error(`Monday board id '${boardId}' is invalid`);
    const inventoryMode = args.inventoryMode ?? "selected-items";
    if (!new Set(["selected-items", "complete-table"]).has(inventoryMode)) throw new Error(`Monday inventory mode '${inventoryMode}' is invalid`);
    const columnIds = [...new Set(args.columnIds.map(String))].sort();
    if (columnIds.length > 100) throw new Error("Monday record inventory supports at most one hundred explicit column ids");
    for (const columnId of columnIds) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(columnId)) throw new Error(`Monday column id '${columnId}' is invalid`);
    }
    const groupIds = [...new Set((args.groupIds ?? []).map(String))].sort();
    for (const groupId of groupIds) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(groupId)) throw new Error(`Monday group id '${groupId}' is invalid`);
    }
    const pageSize = args.pageSize ?? 100;
    const maxPages = args.maxPages ?? 100;
    const maxObjects = args.maxObjects ?? 50_000;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error("Monday inventory page size must be between 1 and 500");
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error("Monday inventory max pages must be between 1 and 1000");
    if (!Number.isInteger(maxObjects) || maxObjects < 1 || maxObjects > 1_000_000) throw new Error("Monday inventory max objects must be between 1 and 1000000");
    if (inventoryMode === "complete-table" && groupIds.length > 0) throw new Error("Monday complete-table inventory cannot use group filters");
    const allowedSubitemBoardIds = [...new Set((args.allowedSubitemBoardIds ?? []).map(String))].sort();
    for (const childBoardId of allowedSubitemBoardIds) {
      if (!/^\d{1,20}$/.test(childBoardId)) throw new Error(`Monday subitem board id '${childBoardId}' is invalid`);
    }

    type ColumnValue = { id: string; text: string | null; value: string | null };
    type Item = {
      id: string;
      name: string;
      updated_at: string | null;
      created_at?: string | null;
      state?: string | null;
      url?: string | null;
      board: { id: string };
      group: { id: string };
      parent_item?: { id: string } | null;
      column_values: ColumnValue[];
      subitems?: Array<Item & { subitems?: Array<{ id: string }> }>;
    };
    type Page = { cursor: string | null; items: Item[] };
    type BoardMetadata = {
      id: string;
      name: string;
      board_kind: string;
      state: string;
      groups: Array<{ id: string; title: string; archived?: boolean; deleted?: boolean }>;
      columns: Array<{ id: string; title: string; type: string; archived?: boolean; revision?: string | null; settings?: JsonValue | null }>;
    };
    const requests: Array<MondayGraphqlResponse<Page>> = [];
    const metadataRequests: Array<MondayGraphqlResponse<BoardMetadata[]>> = [];
    const variableDefinition = inventoryMode === "complete-table"
      ? "$boardIds: [ID!]!, $limit: Int!"
      : "$boardIds: [ID!]!, $limit: Int!, $columnIds: [String!]";
    const columnSelection = inventoryMode === "complete-table"
      ? "column_values { id text value }"
      : "column_values(ids: $columnIds) { id text value }";
    const subitemSelection = inventoryMode === "complete-table" ? `
            subitems {
              id name updated_at created_at state url board { id } group { id } parent_item { id }
              column_values { id text value }
              subitems { id }
            }` : "";
    const itemSelection = `
            id name updated_at created_at state url board { id } group { id }
            ${columnSelection}${subitemSelection}`;
    const variables: Record<string, unknown> = { boardIds: [boardId], limit: pageSize };
    if (inventoryMode !== "complete-table") variables.columnIds = columnIds;
    const first = await this.graphql<{ boards: Array<BoardMetadata & { items_page: Page }> }>(`query ReadCompanyRecordsFirstPage(${variableDefinition}) {
      boards(ids: $boardIds) {
        id name board_kind state
        groups { id title archived deleted }
        columns { id title type archived revision settings }
        items_page(limit: $limit) {
          cursor
          items {${itemSelection}
          }
        }
      }
    }`, variables);
    const board = first.data.boards[0];
    if (!board || String(board.id) !== boardId) throw new Error(`Monday did not return exact board '${boardId}' for record inventory`);
    requests.push({ ...first, data: board.items_page });
    metadataRequests.push({ ...first, data: [board] });

    let cursor = board.items_page.cursor;
    const seenCursors = new Set<string>();
    while (cursor) {
      if (requests.length >= maxPages) throw new Error(`Monday record inventory exceeded the configured ${maxPages}-page bound`);
      if (seenCursors.has(cursor)) throw new Error("Monday record inventory returned a repeated cursor");
      seenCursors.add(cursor);
      const nextVariables: Record<string, unknown> = { cursor, limit: pageSize };
      if (inventoryMode !== "complete-table") nextVariables.columnIds = columnIds;
      const nextVariableDefinition = inventoryMode === "complete-table"
        ? "$cursor: String!, $limit: Int!"
        : "$cursor: String!, $limit: Int!, $columnIds: [String!]";
      const next = await this.graphql<{ next_items_page: Page }>(`query ReadCompanyRecordsNextPage(${nextVariableDefinition}) {
        next_items_page(cursor: $cursor, limit: $limit) {
          cursor
          items {${itemSelection}
          }
        }
      }`, nextVariables);
      requests.push({ ...next, data: next.data.next_items_page });
      cursor = next.data.next_items_page.cursor;
    }

    const allMainItems = requests.flatMap((request) => request.data.items);
    const allSubitems = inventoryMode === "complete-table" ? allMainItems.flatMap((item) => item.subitems ?? []) : [];
    for (const subitem of allSubitems) {
      if ((subitem.subitems ?? []).length > 0) {
        throw new Error(`Monday complete-table inventory found nested subitems below '${subitem.id}'; V1 supports exactly one subitem level`);
      }
    }
    const observedSubitemBoardIds = [...new Set(allSubitems.map((item) => String(item.board.id)).filter((id) => id !== boardId))].sort();
    const unexpectedSubitemBoards = observedSubitemBoardIds.filter((id) => !allowedSubitemBoardIds.includes(id));
    if (unexpectedSubitemBoards.length > 0) {
      throw new Error(`Monday returned subitems on unqualified child board(s): ${unexpectedSubitemBoards.join(", ")}`);
    }
    const subitemBoardIds = inventoryMode === "complete-table" ? allowedSubitemBoardIds : [];
    let tableBoards: BoardMetadata[] = [board];
    if (subitemBoardIds.length > 0) {
      const children = await this.graphql<{ boards: BoardMetadata[] }>(`query ReadCompanyRecordsChildBoardMetadata($boardIds: [ID!]!) {
        boards(ids: $boardIds) {
          id name board_kind state
          groups { id title archived deleted }
          columns { id title type archived revision settings }
        }
      }`, { boardIds: subitemBoardIds });
      const returned = new Set(children.data.boards.map((candidate) => String(candidate.id)));
      const missing = subitemBoardIds.filter((candidate) => !returned.has(candidate));
      if (missing.length > 0) throw new Error(`Monday did not return subitem board metadata for '${missing.join(", ")}'`);
      metadataRequests.push({ ...children, data: children.data.boards });
      tableBoards = [board, ...subitemBoardIds.map((id) => children.data.boards.find((candidate) => String(candidate.id) === id)!)];
    }

    const columnTypesByBoard = new Map(tableBoards.map((candidate) => [
      String(candidate.id),
      new Map((candidate.columns ?? []).map((column) => [String(column.id), column.type])),
    ]));
    const objects: MondayRecordObject[] = [];
    const seenObjects = new Set<string>();
    const parseColumnValues = (values: ColumnValue[], itemBoardId: string) => {
      const columns: Record<string, JsonValue> = {};
      const rawColumns: Record<string, JsonValue> = {};
      const columnText: Record<string, string> = {};
      for (const column of values) {
        const id = String(column.id);
        columnText[id] = column.text ?? "";
        let parsed: JsonValue;
        if (column.value === null) parsed = column.text ?? "";
        else {
          try { parsed = JSON.parse(column.value) as JsonValue; }
          catch { parsed = column.text ?? ""; }
        }
        rawColumns[id] = parsed;
        const type = columnTypesByBoard.get(itemBoardId)?.get(id);
        const personsAndTeams = type === "people" && parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, JsonValue>).personsAndTeams
          : undefined;
        columns[id] = type === "people"
          ? Array.isArray(personsAndTeams)
            ? [...new Set(personsAndTeams.flatMap((entry) => {
                if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
                const providerId = (entry as Record<string, JsonValue>).id;
                return typeof providerId === "string" || typeof providerId === "number" ? [String(providerId)] : [];
              }))]
            : []
          : parsed;
      }
      return { columns, rawColumns, columnText };
    };
    const remember = (object: MondayRecordObject) => {
      if (seenObjects.has(object.id)) throw new Error(`Monday record inventory returned duplicate object '${object.id}'`);
      seenObjects.add(object.id);
      objects.push(object);
      if (objects.length > maxObjects) throw new Error(`Monday record inventory exceeded the configured ${maxObjects}-object bound`);
    };
    if (inventoryMode === "complete-table") {
      for (const metadata of tableBoards) {
        const metadataBoardId = String(metadata.id);
        remember({
          id: `board:${metadataBoardId}`, object_kind: "board", provider_id: metadataBoardId, name: metadata.name,
          updated_at: null, created_at: null, state: metadata.state, url: null, root_board_id: boardId,
          board_id: metadataBoardId, group_id: null, parent_item_id: null, columns: {}, column_text: {},
          provider_payload: { board_kind: metadata.board_kind, state: metadata.state },
        });
        for (const group of metadata.groups.filter((candidate) => candidate.archived !== true && candidate.deleted !== true)) {
          const providerId = String(group.id);
          remember({
            id: `group:${metadataBoardId}:${providerId}`, object_kind: "group", provider_id: providerId, name: group.title,
            updated_at: null, created_at: null, state: "active", url: null, root_board_id: boardId,
            board_id: metadataBoardId, group_id: providerId, parent_item_id: null, columns: {}, column_text: {},
            provider_payload: { title: group.title, archived: false, deleted: false },
          });
        }
        for (const column of metadata.columns.filter((candidate) => candidate.archived !== true)) {
          const providerId = String(column.id);
          remember({
            id: `column:${metadataBoardId}:${providerId}`, object_kind: "column", provider_id: providerId, name: column.title,
            updated_at: null, created_at: null, state: "active", url: null, root_board_id: boardId,
            board_id: metadataBoardId, group_id: null, parent_item_id: null, columns: {}, column_text: {},
            provider_payload: {
              title: column.title, type: column.type, archived: false,
              revision: column.revision ?? null, settings: column.settings ?? null,
            },
          });
        }
      }
    }
    const appendItem = (item: Item, kind: "item" | "subitem", parentItemId: string | null) => {
      const actualBoardId = String(item.board.id);
      if (kind === "item" && actualBoardId !== boardId) throw new Error(`Monday returned item '${item.id}' outside exact board '${boardId}'`);
      if (kind === "subitem" && !new Set(subitemBoardIds).has(actualBoardId) && actualBoardId !== boardId) {
        throw new Error(`Monday returned subitem '${item.id}' outside the discovered table surface`);
      }
      const providerId = String(item.id);
      const groupId = String(item.group.id);
      if (kind === "item" && groupIds.length > 0 && !groupIds.includes(groupId)) return;
      const { columns, rawColumns, columnText } = parseColumnValues(item.column_values, actualBoardId);
      const id = inventoryMode === "complete-table" ? `${kind}:${providerId}` : providerId;
      remember({
        id, object_kind: kind, provider_id: providerId, name: item.name, updated_at: item.updated_at ?? null,
        created_at: item.created_at ?? null, state: item.state ?? null, url: item.url ?? null,
        root_board_id: boardId, board_id: actualBoardId, group_id: groupId,
        parent_item_id: parentItemId ?? (item.parent_item ? String(item.parent_item.id) : null),
        columns, column_text: columnText,
        provider_payload: {
          name: item.name, updated_at: item.updated_at ?? null, created_at: item.created_at ?? null,
          state: item.state ?? null, url: item.url ?? null, board_id: actualBoardId, group_id: groupId,
          parent_item_id: parentItemId ?? (item.parent_item ? String(item.parent_item.id) : null),
          columns: rawColumns, column_text: columnText,
        },
      });
    };
    for (const request of requests) {
      for (const item of request.data.items) {
        if (String(item.board.id) !== boardId) throw new Error(`Monday returned item '${item.id}' outside exact board '${boardId}'`);
        appendItem(item, "item", null);
        if (inventoryMode === "complete-table") {
          for (const subitem of item.subitems ?? []) appendItem(subitem, "subitem", String(item.id));
        }
      }
    }
    objects.sort((left, right) => left.id.localeCompare(right.id));
    const allResponses = [...requests, ...metadataRequests];
    const objectCounts = objects.reduce<Record<string, number>>((counts, object) => {
      counts[object.object_kind] = (counts[object.object_kind] ?? 0) + 1;
      return counts;
    }, {});
    return {
      boardId,
      boardIds: tableBoards.map((candidate) => String(candidate.id)),
      inventoryMode,
      tableSchema: tableBoards.map((candidate) => ({
        board_id: String(candidate.id),
        columns: (candidate.columns ?? [])
          .filter((column) => column.archived !== true)
          .map((column) => ({ id: String(column.id), title: column.title, type: column.type }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      })),
      objects,
      objectCounts,
      requestIds: [...new Set(allResponses.flatMap((request) => request.requestId ? [request.requestId] : []))],
      reportedApiVersions: [...new Set(allResponses.flatMap((request) => request.apiVersion ? [request.apiVersion] : []))].sort(),
      pageCount: requests.length,
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
