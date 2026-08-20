// Board stand-in (Monday & friends): the neutral item model a connection would
// produce from its mapping, plus an event log tests can feed and inspect. No
// HTTP, no provider vocabulary — the mapping lives in the real connection.

export interface BoardItem {
  itemId: string;
  title: string;
  group: string; // neutral column/state name, e.g. "in-sprint"
  owner?: string; // principal or member id
  plannedEffort?: number; // hours
  fields: Record<string, string>;
}

export type BoardEventType = "item.created" | "item.moved" | "field.changed" | "comment.added";

export interface BoardEvent {
  type: BoardEventType;
  itemId: string;
  at: Date;
  /** Who caused it (logged, never trusted for authorization). */
  actor?: string;
  from?: string;
  to?: string;
  field?: string;
  value?: string;
  text?: string;
}

/**
 * In-memory board: tests move cards and change fields, the engine consumes the
 * resulting events. Writes the engine performs (field enrichment, comments) are
 * recorded so assertions can prove "only allowed fields were touched".
 */
export class BoardFake {
  readonly events: BoardEvent[] = [];
  readonly writes: { itemId: string; field?: string; value?: string; comment?: string; at: Date }[] = [];
  #items = new Map<string, BoardItem>();
  readonly #clock: { now(): Date };

  constructor(clock: { now(): Date }) {
    this.#clock = clock;
  }

  seed(item: BoardItem): BoardItem {
    this.#items.set(item.itemId, { ...item, fields: { ...item.fields } });
    this.events.push({ type: "item.created", itemId: item.itemId, at: this.#clock.now() });
    return this.get(item.itemId)!;
  }

  get(itemId: string): BoardItem | undefined {
    const item = this.#items.get(itemId);
    return item ? { ...item, fields: { ...item.fields } } : undefined;
  }

  items(group?: string): BoardItem[] {
    const all = [...this.#items.values()].map((i) => ({ ...i, fields: { ...i.fields } }));
    return group ? all.filter((i) => i.group === group) : all;
  }

  /** A human drags a card (the only way groups change — we never correct). */
  move(itemId: string, to: string, actor?: string): void {
    const item = this.#items.get(itemId);
    if (!item) throw new Error(`move: unknown item ${itemId}`);
    const from = item.group;
    item.group = to;
    this.events.push({ type: "item.moved", itemId, from, to, actor, at: this.#clock.now() });
  }

  /** A human edits a field. */
  changeField(itemId: string, field: string, value: string, actor?: string): void {
    const item = this.#items.get(itemId);
    if (!item) throw new Error(`changeField: unknown item ${itemId}`);
    item.fields[field] = value;
    this.events.push({ type: "field.changed", itemId, field, value, actor, at: this.#clock.now() });
  }

  addComment(itemId: string, text: string, actor?: string): void {
    this.events.push({ type: "comment.added", itemId, text, actor, at: this.#clock.now() });
  }

  /** Engine-side write: enrich a field (recorded for assertions). */
  writeField(itemId: string, field: string, value: string): void {
    const item = this.#items.get(itemId);
    if (!item) throw new Error(`writeField: unknown item ${itemId}`);
    item.fields[field] = value;
    this.writes.push({ itemId, field, value, at: this.#clock.now() });
  }

  /** Engine-side write: status comment (never a group move). */
  writeComment(itemId: string, comment: string): void {
    this.writes.push({ itemId, comment, at: this.#clock.now() });
  }

  /** Events since a point in time — what a webhook would have delivered. */
  since(when: Date): BoardEvent[] {
    return this.events.filter((e) => e.at.getTime() > when.getTime());
  }
}
