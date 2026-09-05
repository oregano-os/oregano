import type { JsonValue } from "../../capabilities/contracts.ts";
import type { CompiledWorkflow, CompiledWorkflowStep } from "../../companyos-builder/workflow-types.ts";
import type { WorkflowReferenceContext } from "./context.ts";
import { canonicalJson } from "../canonical.ts";

export function valueAt(value: unknown, path: readonly string[], label = "Workflow value"): unknown {
  let current = value;
  for (const key of path) {
    if (["__proto__", "prototype", "constructor"].includes(key) || !current || typeof current !== "object" || !Object.hasOwn(current, key)) throw new Error(`${label} is missing '${path.join(".")}'`);
    current = (current as Record<string, unknown>)[key];
  }
  if (current === undefined) throw new Error(`${label} is missing '${path.join(".")}'`);
  return current;
}

export function resolveWorkflowValue(value: JsonValue, workflow: CompiledWorkflow, context: WorkflowReferenceContext): JsonValue {
  if (typeof value === "string" && value.startsWith("$")) {
    if (!/^\$(config|steps|trigger|instance|item)(?:\.[A-Za-z0-9_-]+)*$/.test(value)) throw new Error(`Invalid workflow reference '${value}'`);
    const [root, ...path] = value.slice(1).split(".");
    const roots = { config: workflow.config?.value, steps: context.steps, trigger: context.trigger, instance: context.instance, item: context.item };
    return structuredClone(valueAt(roots[root as keyof typeof roots], path, value)) as JsonValue;
  }
  if (Array.isArray(value)) return value.map((item) => resolveWorkflowValue(item, workflow, context));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Unsafe workflow object key");
    return [key, resolveWorkflowValue(item, workflow, context)];
  }));
  return value;
}

export function assertWorkflowOutput(step: CompiledWorkflowStep, output: unknown): void {
  const requirePath = (value: unknown, path: readonly string[]): void => {
    if (!path.length) { valueAt(value, [], `Output of ${step.id}`); return; }
    const [first, ...rest] = path;
    if (first === "[]") {
      if (!Array.isArray(value)) throw new Error(`Output of ${step.id} requires an array at '${path.join(".")}'`);
      for (const item of value) requirePath(item, rest);
    } else requirePath(valueAt(value, [first!], `Output of ${step.id}`), rest);
  };
  for (const path of step.requiredOutputPaths) requirePath(output, path);
}

export function workflowItems(step: CompiledWorkflowStep, workflow: CompiledWorkflow, context: WorkflowReferenceContext): Array<{ key: string | number; value: JsonValue }> {
  if (!step.forEach) throw new Error(`Step '${step.id}' has no for_each`);
  const collection = resolveWorkflowValue(step.forEach.over, workflow, context);
  if (!Array.isArray(collection) || collection.length > step.forEach.maxItems) throw new Error("Workflow for_each collection violates its bound");
  const keys = new Set<string>();
  return collection.map((value) => {
    const key = valueAt(value, [step.forEach!.key], "Workflow item key");
    if (!(typeof key === "string" && key.length > 0) && !(typeof key === "number" && Number.isSafeInteger(key))) throw new Error("Workflow item keys must be non-empty strings or safe integers");
    const identity = canonicalJson(key);
    if (keys.has(identity)) throw new Error("Workflow for_each has a duplicate key");
    keys.add(identity);
    return { key: key as string | number, value };
  });
}
