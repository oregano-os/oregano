import type { JsonValue } from "../../capabilities/contracts.ts";

export interface MondayResourceBinding {
  id: string;
  boardId: string;
  permission: "read" | "read-write";
  fields: Record<string, string>;
}

export interface MondayWorkItem {
  id: string;
  title: string;
  boardId: string;
  groupId: string;
  providerVersion: string;
  fields: Record<string, JsonValue>;
}

export interface MondayGraphqlResponse<T> {
  data: T;
  apiVersion: string | null;
  requestId: string | null;
}

export interface MondayBoardDiscovery {
  id: string;
  name: string;
  boardKind: string;
  state: string;
  permissions: string;
  accessLevel: string;
  workspace: { id: string; name: string } | null;
  groups: Array<{
    id: string;
    title: string;
    archived: boolean;
    deleted: boolean;
  }>;
  columns: Array<{
    id: string;
    title: string;
    type: string;
    archived: boolean;
    revision: string | null;
    settings: JsonValue | null;
  }>;
}

export interface MondayResourceDiscovery {
  actor: { id: string; name: string };
  account: { id: string; name: string };
  boards: MondayBoardDiscovery[];
}

export interface MondayAgentResourceDiscovery {
  identity: {
    memberId: string;
    name: string;
    kind: string;
    email: string;
    externalAgentId: string | null;
  };
  account: { id: string; name: string };
  boards: MondayBoardDiscovery[];
}

export interface MondayRecordObject {
  id: string;
  object_kind: "board" | "group" | "column" | "item" | "subitem";
  provider_id: string;
  name: string;
  updated_at: string | null;
  created_at: string | null;
  state: string | null;
  url: string | null;
  root_board_id: string;
  board_id: string;
  group_id: string | null;
  parent_item_id: string | null;
  columns: Record<string, JsonValue>;
  column_text: Record<string, string>;
  provider_payload: Record<string, JsonValue>;
}

export interface MondayRecordInventory {
  boardId: string;
  boardIds: string[];
  inventoryMode: "selected-items" | "complete-table";
  objects: MondayRecordObject[];
  objectCounts: Record<string, number>;
  requestIds: string[];
  reportedApiVersions: string[];
  pageCount: number;
}

export interface MondayEchoReceipt {
  instanceId: string;
  resourceBinding: string;
  workItemId: string;
  providerVersion: string;
  actorId: string;
  idempotencyKey: string;
  expiresAt: string;
}

export interface MondayEchoStore {
  remember(receipt: MondayEchoReceipt): Promise<void>;
  consumeMatch(args: { instanceId: string; resourceBinding: string; workItemId: string; providerVersion: string; actorId: string; now: string }): Promise<MondayEchoReceipt | undefined>;
}
