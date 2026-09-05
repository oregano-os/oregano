import { CORE_CAPABILITY_CATALOG } from "../capabilities/catalog.ts";
import { maximumRisk } from "../capabilities/contracts.ts";
import { loadCompanyTool } from "./workspace-loader.ts";
import YAML from "yaml";
import { sha256 } from "../runtime/canonical.ts";
import type { CompiledAgent } from "./types.ts";
import type { CompiledWorkflow, CompiledWorkflowStep, CompiledWorkflowSchedule, CompiledWorkflowTemplate, WorkflowValue } from "./workflow-types.ts";
import { validateWorkflowFiles } from "./workflow-authoring.ts";
import { workspaceFile, workspaceDocument, workspacePaths, type WorkspaceFiles } from "./workspace-files.ts";

type Declaration = Record<string, any>;
const reference = /^\$steps\.([a-z][a-z0-9-]*)(?:\.(.+))?$/;
const visit = (value: unknown, callback: (value: string, path: string[]) => void, path: string[] = []): void => {
  if (typeof value === "string") callback(value, path);
  else if (Array.isArray(value)) value.forEach((item, index) => visit(item, callback, [...path, String(index)]));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) visit(item, callback, [...path, key]);
};
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Compile the same captured bytes that were validated. No provider calls or activation. */
export function compileWorkflows(args: {
  files: WorkspaceFiles;
  agents: CompiledAgent[];
  provenance: CompiledWorkflow["provenance"];
}): CompiledWorkflow[] {
  const files = { ...args.files };
  const declarations = workspacePaths(files, "workflows", /\.md$/).map((path) => ({ path, ...workspaceDocument(files, path) })).filter(({ data }) => data?.steps !== undefined);
  if (!declarations.length) return [];
  const errors = validateWorkflowFiles(files);
  if (errors.length) throw new Error(`Workflow compilation failed:\n${errors.join("\n")}`);
  const schedules: CompiledWorkflowSchedule[] = workspacePaths(files, "schedules", /\.ya?ml$/).map((path) => ({ path, digest: sha256(workspaceFile(files, path)), declaration: YAML.parse(workspaceFile(files, path)) }));
  const scheduleFor = (triggerId: string): CompiledWorkflowSchedule => {
    const candidates = schedules.filter((schedule) => schedule.declaration.triggers.some((trigger) => trigger.id === triggerId));
    if (candidates.length !== 1) throw new Error(`Trigger '${triggerId}' needs exactly one schedule`);
    return candidates[0]!;
  };
  return declarations.map(({ path, data }) => {
    const agentId = data.owner.slice(7);
    const agent = args.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`${data.id}: owning Agent is absent from the Artifact`);
    const config = data.config ? { path: data.config, digest: sha256(workspaceFile(files, data.config)), value: YAML.parse(workspaceFile(files, data.config)) } : undefined;
    const literalConfig = (value: unknown): any => {
      if (typeof value === "string" && value.startsWith("$config")) {
        let resolved = config?.value;
        for (const part of value.slice(8).split(".").filter(Boolean)) resolved = resolved && Object.hasOwn(resolved, part) ? resolved[part] : undefined;
        if (resolved === undefined) throw new Error(`${data.id}: missing config value ${value}`);
        return structuredClone(resolved);
      }
      if (Array.isArray(value)) return value.map(literalConfig);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, literalConfig(item)]));
      return value;
    };
    const rawSteps: Declaration[] = data.steps.map((raw: Declaration) => {
      const id = Object.keys(raw)[0]!;
      const { [id]: tool, ...options } = raw;
      return { id, tool, ...literalConfig(options) };
    });
    const triggerId = data.trigger.startsWith("schedule:") ? data.trigger.slice(9) : undefined;
    const startingSchedule = triggerId ? scheduleFor(triggerId) : undefined;
    const calendarPath = data.calendar ?? startingSchedule?.path;
    const calendar = (): string => {
      if (!calendarPath || !schedules.some((schedule) => schedule.path === calendarPath)) throw new Error(`${data.id}: business-day waits and decisions require an explicit calendar or a scheduled trigger`);
      return calendarPath;
    };
    const usedSchedules = new Set<string>(startingSchedule ? [startingSchedule.path] : []);
    if (data.calendar) { calendar(); usedSchedules.add(data.calendar); }
    const templates = new Map<string, CompiledWorkflowTemplate>();
    const steps: CompiledWorkflowStep[] = rawSteps.map((raw, index) => {
      const next = raw.then ?? rawSteps[index + 1]?.id ?? "end";
      const base: CompiledWorkflowStep = {
        id: raw.id, owner: `agent:${agentId}`, kind: "compute", allowedTools: [], maxRisk: "R0",
        next: [next], allPages: raw.all_pages === true, requiredOutputPaths: [], requiresDecisions: [], bindingConstraints: [], conversationalTools: [], evidence: [],
        idempotency: ["instance_id", "workflow_id", "run_id", "step_id", "item_key", "input_digest"],
        ...(raw.after ? { after: raw.after } : {}),
        ...(raw.require_synced_through ? { requireSyncedThrough: raw.require_synced_through } : {}),
        ...(raw.for_each ? { forEach: { over: raw.for_each.over, key: raw.for_each.key, maxItems: 10000 as const } } : {}),
      };
      if (raw.tool === "route") {
        const targets = Object.fromEntries(Object.entries(raw).filter(([key]) => !["id", "tool", "on"].includes(key))) as Record<string, string>;
        return { ...base, kind: "route", route: { on: raw.on, targets }, next: [...new Set(Object.values(targets))] };
      }
      if (raw.tool === "wait") {
        if (typeof raw.for === "string") {
          const id = raw.for.slice(9); const schedule = scheduleFor(id); usedSchedules.add(schedule.path);
          return { ...base, kind: "wait", wait: { triggerId: id, schedulePath: schedule.path } };
        }
        const path = calendar(); usedSchedules.add(path);
        return { ...base, kind: "wait", wait: { businessDays: raw.for.business_days, calendarPath: path } };
      }
      if (raw.tool.startsWith("human:")) {
        const path = calendar(); usedSchedules.add(path);
        return { ...base, kind: "decision", owner: raw.tool, next: [...new Set([raw.approve, raw.reject, "end"])], decision: { role: raw.tool.slice(6), binds: raw.binds, via: raw.via, timeoutBusinessDays: raw.timeout.business_days, calendarPath: path, targets: { approve: raw.approve, reject: raw.reject, timeout: "end" } } };
      }
      const resolved = agent.toolSet.tools.find((tool) => tool.grantId === raw.tool);
      const tool = agent.tools.find((tool) => tool.contract.runtimeId === resolved?.runtimeId);
      if (!resolved || !tool || sha256(tool.contract) !== resolved.contractDigest) throw new Error(`${data.id}/${raw.id}: Tool must match the resolved Artifact contract`);
      if (resolved.version !== tool.contract.version) throw new Error(`${data.id}/${raw.id}: Tool version differs from resolved ToolSet`);
      if (raw.tool.startsWith("company:")) {
        const captured = loadCompanyTool(files, agentId, raw.tool.slice(8));
        if (sha256(captured) !== sha256(tool)) throw new Error(`${data.id}/${raw.id}: compiled Tool differs from captured Workspace bytes`);
      }
      const capabilities = tool.contract.capabilities.map((id) => CORE_CAPABILITY_CATALOG.find((contract) => contract.id === id)!);
      if (resolved.risk !== maximumRisk(tool.contract.risk, ...capabilities.map((contract) => contract.minimumRisk))) throw new Error(`${data.id}/${raw.id}: resolved risk differs from maintained Capability minimum`);
      const effectful = capabilities.some((contract) => contract.mode === "effect") || Number(resolved.risk.slice(1)) >= 3;
      const result: CompiledWorkflowStep = { ...base, tool: structuredClone(resolved), allowedTools: [resolved.runtimeId], maxRisk: resolved.risk, kind: effectful ? "effect" : "compute", evidence: [...tool.contract.evidence] };
      if (raw.tool === "oregano:communications/publish") {
        const [skill, name] = raw.template.split("/");
        const path = `${data.owner}/skills/${skill}/assets/${name}`;
        const template = workspaceDocument(files, path);
        templates.set(path, { path, content: template.body, format: template.data.format, digest: sha256(workspaceFile(files, path)) });
        const thread = raw.thread ?? literalConfig(data.defaults?.thread);
        result.kind = "message";
        result.message = { template: path, vars: raw.vars, destination: raw.destination ?? literalConfig(data.defaults?.destination), ...(raw.recipient !== undefined ? { recipient: raw.recipient } : {}), ...(thread !== undefined ? { thread } : {}) };
        // Recipient-specific destination resolution is an Instance service; never concatenate IDs.
        result.bindingConstraints.push({ inputPath: ["destination_binding"], value: result.message.destination });
      } else {
        result.input = raw.input ?? {};
        for (const binding of ["resource_binding", "destination_binding"]) if (raw.input?.[binding] !== undefined) result.bindingConstraints.push({ inputPath: [binding], value: raw.input[binding] });
      }
      return result;
    });
    for (const step of steps) {
      const consumed = [step.input, step.message?.vars, step.message?.destination, step.message?.recipient, step.message?.thread, step.requireSyncedThrough, step.route?.on, step.decision?.binds, step.decision?.via, step.forEach?.over];
      for (const value of consumed) visit(value, (text) => {
        const match = reference.exec(text);
        if (!match) return;
        const producer = steps.find((candidate) => candidate.id === match[1])!;
        const required = match[2]?.split(".") ?? [];
        if (required.length && !producer.requiredOutputPaths.some((path) => path.join(".") === required.join("."))) producer.requiredOutputPaths.push(required);
      });
      visit(step.input, (text, payloadPath) => {
        const match = /^\$steps\.([a-z][a-z0-9-]*)\.bound$/.exec(text);
        if (match && steps.find((candidate) => candidate.id === match[1])?.decision) step.requiresDecisions.push({ stepId: match[1]!, payloadPath });
      });
      if (Number(step.maxRisk.slice(1)) >= 3 && !step.requiresDecisions.length) throw new Error(`${data.id}/${step.id}: R3/R4 Tool input must bind an explicit workflow decision`);
      if (step.forEach) {
        const over = reference.exec(String(step.forEach.over));
        if (over) {
          const producer = steps.find((candidate) => candidate.id === over[1])!;
          const prefix = [...(over[2]?.split(".") ?? []), "[]"];
          const add = (path: string[]) => {
            const required = [...prefix, ...path];
            if (!producer.requiredOutputPaths.some((value) => value.join(".") === required.join("."))) producer.requiredOutputPaths.push(required);
          };
          add([step.forEach.key]);
          for (const value of consumed) visit(value, (text) => { if (text.startsWith("$item.")) add(text.slice(6).split(".")); });
        }
      }
    }
    for (const step of steps) step.requiredOutputPaths.sort((a, b) => a.join(".").localeCompare(b.join(".")));
    const rawKey = data.instance?.key ?? ["trigger_id", "run_date"];
    const key: string[] = typeof rawKey === "string" ? [rawKey] : rawKey;
    const fields: string[] = [...new Set<string>(["trigger_id", "run_date", ...(data.instance?.fields ?? [])])];
    for (const field of key) if (!fields.includes(field)) throw new Error(`${data.id}: instance key '${field}' must be declared in fields`);
    const manifest = {
      manifestVersion: 1 as const, id: data.id, version: data.version, agentId, executionMode: data.execution_mode,
      source: { path, digest: sha256(workspaceFile(files, path)) }, provenance: { ...args.provenance },
      trigger: triggerId ? { kind: "schedule" as const, id: triggerId, schedulePath: startingSchedule!.path } : { kind: "operator" as const },
      instance: { key, fields }, ...(config ? { config } : {}),
      schedules: schedules.filter((schedule) => usedSchedules.has(schedule.path)), templates: [...templates.values()].sort((a, b) => a.path.localeCompare(b.path)),
      entry: steps[0]!.id, steps, reservedEffects: [...new Set(steps.filter((step) => ["effect", "message"].includes(step.kind)).flatMap((step) => step.allowedTools))].sort(),
    };
    return freeze({ ...manifest, manifestHash: sha256(manifest) } as CompiledWorkflow);
  }).sort((a, b) => a.id.localeCompare(b.id));
}
