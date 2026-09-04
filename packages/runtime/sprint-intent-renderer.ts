import type { CompiledSprintTemplate } from "../companyos-builder/types.ts";
import type { SprintIntent, SprintState } from "../domains/sprint/contracts.ts";
import { sha256 } from "./canonical.ts";

export interface RenderedSprintMessage {
  content: string;
  templatePath: string;
  templateDigest: string;
  contentDigest: string;
}

const line = (values: string[]): string => values.length > 0 ? values.join(", ") : "";

function render(template: CompiledSprintTemplate, values: Record<string, string>): RenderedSprintMessage {
  const content = template.content.split(/\r?\n/).flatMap((sourceLine) => {
    const keys = [...sourceLine.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((match) => match[1]!);
    for (const key of keys) {
      if (!(key in values)) throw new Error(`Sprint template '${template.path}' uses unsupported placeholder '${key}'`);
    }
    if (keys.length > 0 && keys.every((key) => values[key] === "")) return [];
    return [sourceLine.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_match, key: string) => values[key]!)];
  }).join("\n");
  const unresolved = content.match(/\{\{[^}]+\}\}/)?.[0];
  if (unresolved) throw new Error(`Sprint template '${template.path}' contains unresolved placeholder '${unresolved}'`);
  const normalized = content.trim();
  if (!normalized || normalized.length > 20_000) throw new Error(`Sprint template '${template.path}' rendered outside the supported message size`);
  return {
    content: normalized,
    templatePath: template.path,
    templateDigest: template.digest,
    contentDigest: sha256(normalized),
  };
}

export function renderSprintMessageIntent(args: {
  intent: Extract<SprintIntent, { type: "message.monday-handoff" | "message.weekday-digest" | "message.direct-question" | "message.close-reminder" | "message.close-chase" | "message.close-report" | "message.retro" }>;
  state: SprintState;
  templates: {
    reminder: CompiledSprintTemplate;
    chase: CompiledSprintTemplate;
    closeReport: CompiledSprintTemplate;
    retro: CompiledSprintTemplate;
    mondayHandoff?: CompiledSprintTemplate;
    weekdayDigest?: CompiledSprintTemplate;
    directQuestion?: CompiledSprintTemplate;
  };
}): RenderedSprintMessage {
  if (!args.state.sprint_id || !args.state.period_start || !args.state.period_end) {
    throw new Error("Sprint message rendering requires one open durable Sprint");
  }
  const common = {
    sprint_id: args.state.sprint_id,
    period_start: args.state.period_start,
    period_end: args.state.period_end,
    due_at: args.intent.type === "message.close-reminder" || args.intent.type === "message.close-chase"
      ? args.intent.deadline_at ?? args.intent.due_at
      : args.intent.due_at,
  };
  const intent = args.intent;
  if (intent.type === "message.monday-handoff") {
    if (!args.templates.mondayHandoff) throw new Error("Sprint Monday handoff template is not compiled");
    return render(args.templates.mondayHandoff, {
      ...common,
      committed_work_items: line(intent.committed_work_item_ids.map((id) => args.state.work_items[id]?.title ?? id)),
      carry_forward_names: line(intent.carry_forward_participant_ids.map((id) => args.state.participants[id]?.display_name ?? id)),
      disagreements: line(intent.disagreements),
    });
  }
  if (intent.type === "message.weekday-digest") {
    if (!args.templates.weekdayDigest) throw new Error("Sprint weekday digest template is not compiled");
    const readiness = Object.entries(intent.readiness ?? {}).map(([id, fields]) => `${args.state.work_items[id]?.title ?? id}: ${fields.join(", ")}`);
    return render(args.templates.weekdayDigest, {
      ...common,
      changed_work_items: line(intent.changed_work_item_ids.map((id) => args.state.work_items[id]?.title ?? id)),
      readiness_gaps: line(readiness),
    });
  }
  if (intent.type === "message.direct-question") {
    if (!args.templates.directQuestion) throw new Error("Sprint direct-question template is not compiled");
    return render(args.templates.directQuestion, {
      ...common,
      participant_name: args.state.participants[intent.participant_id]?.display_name ?? intent.participant_id,
      work_item_title: args.state.work_items[intent.work_item_id]?.title ?? intent.work_item_id,
      missing_fields: line(intent.missing_fields),
    });
  }
  if (intent.type === "message.close-reminder") return render(args.templates.reminder, common);
  const names = (classification: "complete" | "needs-reformat" | "missing") => line(
    Object.entries(intent.participant_states)
      .filter(([, value]) => value === classification)
      .map(([participantId]) => args.state.participants[participantId]?.display_name ?? participantId)
      .sort((left, right) => left.localeCompare(right)),
  );
  const classified = {
    ...common,
    complete_names: names("complete"),
    needs_reformat_names: names("needs-reformat"),
    missing_names: names("missing"),
  };
  if (intent.type === "message.close-chase") return render(args.templates.chase, classified);
  if (intent.type === "message.close-report") return render(args.templates.closeReport, classified);
  return render(args.templates.retro, {
    ...classified,
    open_work_item_ids: line(intent.open_work_item_ids),
    open_work_item_count: String(intent.open_work_item_ids.length),
    total_effort_hours: intent.total_effort_hours === null ? "not available" : String(intent.total_effort_hours),
  });
}
