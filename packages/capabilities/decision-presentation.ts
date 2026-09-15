/** Provider-neutral controls. Labels never select executable operations. */
export interface DecisionPresentation {
  request_id: string;
  approve_label: string;
  reject_label: string;
  conversation_reference?: string;
  /** Readable card heading; absent keeps the historical generic heading. */
  title?: string;
  /** The notice itself is the conversation root; the affirmative control links to its own thread. */
  open_thread?: true;
}
export function parseDecisionPresentation(value: unknown): DecisionPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Decision controls must be an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["request_id", "approve_label", "reject_label", "conversation_reference", "title", "open_thread"].includes(key))
    || typeof v.request_id !== "string" || !/^[a-f0-9]{64}$/.test(v.request_id)) throw new Error("Invalid decision identity");
  for (const key of ["approve_label", "reject_label"]) if (typeof v[key] !== "string" || !/^[^\u0000-\u001f]{1,75}$/.test(v[key] as string)) throw new Error("Invalid decision label");
  if (v.conversation_reference !== undefined && (typeof v.conversation_reference !== "string" || !/^[^\u0000-\u0020]{1,1000}$/.test(v.conversation_reference))) throw new Error("Invalid decision conversation reference");
  if (v.title !== undefined && (typeof v.title !== "string" || !/^[^\u0000-\u001f]{1,150}$/.test(v.title))) throw new Error("Invalid decision title");
  if (v.open_thread !== undefined && v.open_thread !== true) throw new Error("Invalid decision thread navigation");
  if (v.open_thread === true && v.conversation_reference !== undefined) throw new Error("A decision opens either its own thread or another conversation");
  return { ...(v.conversation_reference === undefined ? {} : { conversation_reference: v.conversation_reference as string }),
    ...(v.title === undefined ? {} : { title: v.title as string }), ...(v.open_thread === true ? { open_thread: true as const } : {}),
    request_id: v.request_id, approve_label: v.approve_label as string, reject_label: v.reject_label as string };
}
