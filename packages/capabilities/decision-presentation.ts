/** Provider-neutral controls. Labels never select executable operations. */
export interface DecisionPresentation {
  request_id: string;
  approve_label: string;
  reject_label: string;
}
export function parseDecisionPresentation(value: unknown): DecisionPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Decision controls must be an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["request_id", "approve_label", "reject_label"].includes(key))
    || typeof v.request_id !== "string" || !/^[a-f0-9]{64}$/.test(v.request_id)) throw new Error("Invalid decision identity");
  for (const key of ["approve_label", "reject_label"]) if (typeof v[key] !== "string" || !/^[^\u0000-\u001f]{1,75}$/.test(v[key] as string)) throw new Error("Invalid decision label");
  return { request_id: v.request_id, approve_label: v.approve_label as string, reject_label: v.reject_label as string };
}
