import { CORE_CAPABILITY_CATALOG } from "../capabilities/catalog.ts";
import { maximumRisk, type RiskLevel } from "../capabilities/contracts.ts";
import { readFileSync } from "node:fs";
import { readWorkspaceFiles, workspaceFile, workspaceDocument, workspacePaths, type WorkspaceFiles } from "./workspace-files.ts";
import { basename, dirname } from "node:path";
import YAML from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import { STANDARD_DIRECTORY_TOOLS } from "../standard-tools/directory.ts";
import { STANDARD_RECORDS_TOOLS } from "../standard-tools/records.ts";
import { STANDARD_WORK_ITEM_TOOLS } from "../standard-tools/work-items.ts";
import { STANDARD_COMMUNICATION_TOOLS } from "../standard-tools/communication.ts";
import { STANDARD_KNOWLEDGE_TOOLS } from "../standard-tools/knowledge.ts";
import { inspectAndCompileCompanyTool } from "../tool-sdk/source-inspector.ts";
import { validateJsonSchemaValue } from "../capabilities/validation.ts";
import { validateRecordSource, recordFieldSchema } from "../records/source-validation.ts";
import { validateRecordFilters } from "../records/query.ts";
import { recordInstant } from "../records/instant.ts";

type Schema = any;
const standardTools = [...STANDARD_DIRECTORY_TOOLS, ...STANDARD_RECORDS_TOOLS, ...STANDARD_WORK_ITEM_TOOLS, ...STANDARD_COMMUNICATION_TOOLS, ...STANDARD_KNOWLEDGE_TOOLS];
const schemas = new Map<string, any>();
const loadSchema = (name: string): any => {
  if (!schemas.has(name)) schemas.set(name, JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8")));
  return schemas.get(name);
};
function readLiteralConfiguration(files: WorkspaceFiles, name: string): any {
  const config = YAML.parse(workspaceFile(files, name));
  const errors = validateJsonSchemaValue(loadSchema("workflow-config-v2.schema.json"), config);
  if (errors.length) throw new Error(`Invalid workflow config: ${errors.join("; ")}`);
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 32) throw new Error("Workflow config nesting exceeds 32 levels");
    if (typeof value === "string" && value.startsWith("$")) throw new Error("Workflow config contains references; literal values are required");
    if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Unsafe workflow config key");
      inspect(item, depth + 1);
    }
  };
  inspect(config); return config;
}

/** Resolve a JSON-pointer-like field path inside a schema; returns the sub-schema or null. */
function schemaAt(root: Schema, schema: Schema, path: string[]): Schema | null {
  let current = deref(root, schema);
  if (current?.anyOf || current?.oneOf) {
    const alternatives = (current.anyOf ?? current.oneOf).map((part: Schema) => schemaAt(root, part, path));
    return alternatives.some((part: Schema) => part === null) ? null : unionSchema(alternatives);
  }
  for (const segment of path) {
    current = deref(root, current);
    if (!current) return null;
    if (current.type === "array" || current.items) {
      if (segment === "[]") { current = current.items; continue; }
      return null;
    }
    if (current.properties && Object.hasOwn(current.properties, segment)) { const optional = current.__optional || !(current.required ?? []).includes(segment); current = { ...current.properties[segment], ...(optional ? { __optional: true } : {}) }; continue; }
    if (current.additionalProperties && typeof current.additionalProperties === "object") { current = { ...current.additionalProperties, __optional: true }; continue; }
    if (current.type === "object" && !current.properties && current.additionalProperties !== false) return { type: "unknown" };
    return null;
  }
  return deref(root, current);
}
function deref(root: Schema, schema: Schema): Schema {
  if (schema && typeof schema === "object" && typeof schema.$ref === "string") {
    if (!schema.$ref.startsWith("#/")) throw new Error("Workflow schemas require local references");
    const path = schema.$ref.slice(2).split("/").map((part: string) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    let node: any = root;
    for (const segment of path) node = node && Object.hasOwn(node, segment) ? node[segment] : undefined;
    return node ?? null;
  }
  return schema;
}

function expandSchema(root: Schema, value: Schema = root, depth = 0): Schema {
  if (depth > 32) throw new Error("Reference schema exceeds the supported nesting bound");
  if (typeof value !== "object" || !value) return value;
  if (value.$ref) return expandSchema(root, deref(root, value), depth + 1);
  const result = { ...value };
  delete result.$defs;
  for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(value[key])) result[key] = value[key].map((part: Schema) => expandSchema(root, part, depth + 1));
  for (const key of ["properties", "patternProperties"]) if (value[key]) result[key] = Object.fromEntries(Object.entries(value[key]).map(([name, part]) => [name, expandSchema(root, part, depth + 1)]));
  for (const key of ["items", "additionalProperties"]) if (typeof value[key] === "object") result[key] = expandSchema(root, value[key], depth + 1);
  return result;
}


export function validateWorkflowAuthoring(dir: string): string[] {
  return validateWorkflowFiles(readWorkspaceFiles(dir));
}

export function validateWorkflowFiles(files: WorkspaceFiles): string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date-time", (value: string) => { try { recordInstant(value, "Workflow timestamp"); return true; } catch { return false; } });
  const errors: string[] = [];
  const err = (workflow: string, message: string) => errors.push(`${workflow}: ${message}`);
  const core = new Map(standardTools.map((tool) => [tool.contract.grantId ?? tool.contract.runtimeId, tool.contract]));

  const loadDir = (sub: string) => workspacePaths(files, `records/${sub}`, /\.yaml$/).map((path) => YAML.parse(workspaceFile(files, path)));
  const sourceValues = loadDir("sources"), projectionValues = loadDir("projections");
  const sources = new Map<string, any>(sourceValues.map((x: any) => [x.id, x]));
  const projections = new Map<string, any>(projectionValues.map((x: any) => [x.id, x]));
  if (sources.size !== sourceValues.length || projections.size !== projectionValues.length) errors.push("records: Source and projection identities must be distinct");
  for (const [kind, declarations] of [["source", sources], ["projection", projections]] as const) {
    const schema = loadSchema(`company-record-${kind}-v1.schema.json`);
    for (const [id, declaration] of declarations) {
      const issues = validateJsonSchemaValue(schema, declaration);
      for (const issue of issues) errors.push(`records: ${kind} '${id}': ${issue}`);
      if (!issues.length) {
        try { kind === "source" ? validateRecordSource(declaration) : validateRecordFilters(declaration); }
        catch (error) { errors.push(`records: ${kind} '${id}': ${String(error)}`); }
      }
    }
  }
  if (errors.length) return errors;
  /** rows.values schema for one projection: field names from the projection, types from its source declaration. */
  const rowsSchemaFor = (projectionId: string, fromStep: string, workflow: string): Schema => {
    const projection = projections.get(projectionId);
    if (!projection) { errors.push(`${workflow}: ${fromStep}: projection '${projectionId}' is not declared under records/projections`); return { type: "array", items: { type: "object" } }; }
    const sourceIds: string[] = projection.source_ids ?? [...sources.values()].filter((source: any) => source.record_type === projection.record_type).map((source: any) => source.id);
    const selected = sourceIds.map((id) => sources.get(id));
    if (!selected.length || selected.some((source) => !source || source.record_type !== projection.record_type)) err(workflow, `${fromStep}: projection has no valid source selection`);
    const properties: Record<string, Schema> = {}; const required: string[] = [];
    for (const field of projection.fields ?? []) {
      let guaranteed = selected.length > 0;
      const alternatives = selected.map((source) => {
        const [first, ...rest] = field.path.split(".");
        const mapping = source?.fields?.find((mapping: any) => mapping.target === first);
        const value = mapping ? recordFieldSchema(mapping) : undefined;
        const resolved = value ? schemaAt(value, value, rest) : undefined;
        if (!resolved) err(workflow, `${fromStep}: projection field '${field.path}' has no declared source mapping`);
        if (!mapping?.required || resolved?.__optional) guaranteed = false;
        return resolved ?? {};
      });
      properties[field.name] = unionSchema(alternatives);
      if (guaranteed) required.push(field.name);
    }
    return { type: "array", items: { type: "object", required: ["record_id", "values"], properties: { record_id: { type: "string" }, values: { type: "object", additionalProperties: false, required, properties } } } };
  };
  const scheduleFiles = workspacePaths(files, "schedules", /\.ya?ml$/);
  const schedules: any[] = scheduleFiles.map((path) => ({ path, data: YAML.parse(workspaceFile(files, path)) }));
  for (const entry of schedules) validateSchedule(entry.data, entry.path, err);
  const triggerOwners = new Map<string, string>();
  for (const entry of schedules) for (const trigger of entry.data.triggers ?? []) {
    if (triggerOwners.has(trigger.id) && triggerOwners.get(trigger.id) !== entry.path) err(entry.path, `Trigger ${trigger.id} is ambiguous across schedules`);
    triggerOwners.set(trigger.id, entry.path);
  }
  const schedule = { triggers: schedules.flatMap((entry) => entry.data.triggers ?? []) };
  const triggerParams = new Map<string, Set<string>>();
  for (const trigger of schedule.triggers) triggerParams.set(trigger.id, new Set(Object.keys(trigger.params ?? {})));
  const parsed = workspacePaths(files, "workflows", /\.md$/).map((path) => ({ f: path, ...workspaceDocument(files, path) })).filter((doc) => doc.data?.steps !== undefined);
  if (!parsed.length) return errors;
  const idsSeen = new Set<string>();
  for (const { f, data } of parsed) {
    const schemaIssues = validateJsonSchemaValue(loadSchema("workflow-steps-v1.schema.json"), data);
    for (const issue of schemaIssues) err(f, issue);
    if (schemaIssues.length) continue;
    if (idsSeen.has(data.id)) err(f, "Workflow id is declared more than once");
    idsSeen.add(data.id);
    if (data.calendar && !schedules.some((entry) => entry.path === data.calendar)) err(f, "calendar must name a declared schedule file");
    const needsCalendar = data.steps.some((step: any) => Object.values(step)[0]?.toString().startsWith("human:") || step.for?.business_days);
    if (needsCalendar && data.trigger === "operator" && !data.calendar) err(f, "operator business-day waits and decisions require calendar");
  }
  if (errors.length) return errors;
  const stepsOf = (data: any) => data.steps.map((s: any) => {
    const id = Object.keys(s)[0]!;
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(id) || ["id", "tool", "input", "then", "after", "on", "for", "for_each"].includes(id) || Object.hasOwn(s, "id") || Object.hasOwn(s, "tool")) throw new Error("A compact step requires one leading selector; id/tool metadata cannot override it");
    return { ...s, id, tool: s[id] };
  });
  for (const { f, data, body } of parsed) {
    if (data.trigger !== "operator" && !triggerParams.has(data.trigger.slice(9))) err(f, "Workflow trigger is not declared in a schedule");
    const fields = new Set(["trigger_id", "run_date", ...(data.instance?.fields ?? [])]);
    for (const key of typeof data.instance?.key === "string" ? [data.instance.key] : data.instance?.key ?? ["trigger_id", "run_date"]) if (!fields.has(key)) err(f, `Instance key ${key} is not a declared field`);
    const config = data.config ? readLiteralConfiguration(files, data.config) : {};
    const owner = `${data.owner}/instructions.md`;
    const grants = new Set(workspaceDocument(files, owner).data?.tools ?? []);
    const companyTools = new Map<string, any>();
    const toolsDir = `${data.owner}/tools`;
    for (const file of workspacePaths(files, toolsDir, /\/TOOL\.md$/)) {
      const declaration = workspaceDocument(files, file).data;
      const id = basename(dirname(file));
      companyTools.set(`company:${id}`, declaration);
      const implementation = `${dirname(file)}/execute.ts`;
      for (const issue of inspectAndCompileCompanyTool(workspaceFile(files, implementation), implementation).diagnostics) err(f, issue);
    }
    const toolSchemas = (tool: any): { input: Schema; output: Schema; risk: string } | null => {
    if (typeof tool !== "string") return null;
    if (core.has(tool)) { const c = core.get(tool)!; return { input: expandSchema(c.inputSchema), output: expandSchema(c.outputSchema ?? { type: "object" }), risk: c.risk }; }
    if (companyTools.has(tool)) { const c = companyTools.get(tool);
      const risks: RiskLevel[] = [/^R[0-4]$/.test(c.risk ?? "") ? c.risk : "R3"];
      for (const id of c.capabilities ?? []) {
        const capability = CORE_CAPABILITY_CATALOG.find((candidate) => candidate.id === id);
        if (!capability) err(f, `Company Tool ${tool} requires an unknown Capability ${id}`);
        else risks.push(capability.minimumRisk);
      }
      return { input: expandSchema(c.input_schema), output: expandSchema(c.output_schema), risk: maximumRisk(...risks) }; }
    return null;
  };

    const steps = stepsOf(data);
    const ids: string[] = steps.map((s: any) => s.id);
    const flow = validateStepFlow(steps, f, err);
    const idset = new Set(ids);
    if (idset.size !== ids.length) err(f, "Step identities must be distinct");
    const markers = [...body.matchAll(/^\s*\d+\.\s+\[([^\]]+)\][^\n]*?<!-- step:([a-z][a-z0-9-]*) -->/gm)].map((m) => ({ marker: m[1], id: m[2] }));
    if (JSON.stringify(ids) !== JSON.stringify(markers.map((m) => m.id))) err(f, `body markers ${JSON.stringify(markers.map((m) => m.id))} differ from steps ${JSON.stringify(ids)}`);

    // output schema per step
    const outputOf = new Map<string, Schema>();
    const inputOf = new Map<string, Schema>();
    for (const s of steps) {
      const schemas = toolSchemas(s.tool);
      if (s.tool === "oregano:records/query") {
        const projectionRef = String(s.input?.projection_id ?? "");
        let projectionId: string | null = null;
        const cm = projectionRef.match(/^\$config\.(.+)$/);
        if (cm) { let node: any = config; for (const seg of cm[1].split(".")) node = node?.[seg]; projectionId = typeof node === "string" ? node : null; }
        else if (projectionRef && !projectionRef.startsWith("$")) projectionId = projectionRef;
        const output = structuredClone(schemas!.output);
        if (projectionId) {
          output.properties.rows = rowsSchemaFor(projectionId, s.id, f);
          const declarations = projections.get(projectionId)?.filters ?? {};
          const rowSchema = output.properties.rows.items;
          const filterProperties: Record<string, Schema> = {};
          for (const [name, declaration] of Object.entries(declarations) as any) {
            const valueSchema = schemaAt(rowSchema, rowSchema, ["values", ...declaration.path.split(".")]) ?? {};
            filterProperties[name] = declaration.operator === "equals" ? valueSchema
              : declaration.operator === "in" ? { type: "array", maxItems: 10_000, items: valueSchema }
              : declaration.operator === "after" ? { type: "string", format: "date-time" }
              : { type: "array", minItems: 1, items: { type: "string", enum: declaration.fields } };
          }
          const input = structuredClone(schemas!.input);
          input.properties.filters = { type: "object", additionalProperties: false, properties: filterProperties };
          inputOf.set(s.id, input);
          const allowed = new Set<string>(Object.keys(projections.get(projectionId)?.filters ?? {}));
          for (const key of Object.keys(s.input?.filters ?? {})) if (!allowed.has(key)) err(f, `${s.id}: filter '${key}' is not declared on projection '${projectionId}' (declared: ${[...allowed].join(", ") || "none"})`);
        } else err(f, `${s.id}: records.query projection_id must be a literal or a $config path to a projection id`);
        outputOf.set(s.id, output);
      } else if (schemas) outputOf.set(s.id, schemas.output);
      else if (s.tool === "wait") outputOf.set(s.id, { type: "object", required: ["instant"], properties: { instant: { type: "string", format: "date-time" } } });
      else if (s.tool === "route") outputOf.set(s.id, { type: "object", properties: {} });
      else if (typeof s.tool === "string" && s.tool.startsWith("human:")) {
        const bound = resolveReference(String(s.binds ?? ""), s.id);
        outputOf.set(s.id, { type: "object", required: ["bound", "option"], properties: { bound: bound ?? { type: "unknown" }, option: { type: "string" } } });
      } else if (typeof s.tool === "string" && (s.tool.startsWith("oregano:") || s.tool.startsWith("company:"))) { err(f, `${s.id}: unknown Tool ${s.tool}`); outputOf.set(s.id, { type: "object" }); }
      else { err(f, `${s.id}: unknown step kind ${JSON.stringify(s.tool)}`); outputOf.set(s.id, { type: "object" }); }
      if (s.for_each && outputOf.has(s.id)) outputOf.set(s.id, {
        type: "object", additionalProperties: false, required: ["items"], properties: {
          items: { type: "array", maxItems: 10_000, items: { type: "object", additionalProperties: false, required: ["key", "output"], properties: {
            key: { anyOf: [{ type: "string" }, { type: "integer" }] }, output: outputOf.get(s.id),
          } } },
        },
      });
    }

    function resolveReference(reference: string, fromStep: string, itemSchema?: Schema): Schema | null {
      const m = reference.match(/^\$(steps|config|trigger|instance|item)(?:\.(.+))?$/);
      if (!m || !(m[2] ?? "").split(".").filter(Boolean).every((part) => /^[A-Za-z0-9_-]+$/.test(part) && !["__proto__", "prototype", "constructor"].includes(part))) { err(f, `${fromStep}: malformed reference ${reference}`); return null; }
      const path = (m[2] ?? "").split(".").filter(Boolean);
      if (m[1] === "steps") {
        const [stepId, ...rest] = path;
        if (!idset.has(stepId)) { err(f, `${fromStep}: reference to unknown step '${stepId}'`); return null; }
        if (ids.indexOf(stepId) >= ids.indexOf(fromStep)) err(f, `${fromStep}: reference to current or future output ${stepId}`);
        if (!flow.dominators.get(fromStep)?.has(stepId)) err(f, `${fromStep}: output ${stepId} can be skipped on a path reaching this step`);
        const root = outputOf.get(stepId);
        const resolved = schemaAt(root, root, rest);
        if (!resolved) err(f, `${fromStep}: $steps.${stepId}.${rest.join(".")} is not a field of ${stepId}'s output`);
        return resolved;
      }
      if (m[1] === "config") {
        let node: any = config;
        for (const segment of path) { node = node?.[segment]; if (node === undefined) { err(f, `${fromStep}: $config.${path.join(".")} is not defined in config.yaml`); return null; } }
        return { ...literalSchema(node), const: node };
      }
      if (m[1] === "trigger") {
        const known: Record<string, Schema> = { id: { type: "string" }, instant: { type: "string", format: "date-time" }, previous_instant: { type: "string", format: "date-time" } };
        if (path[0] === "params") {
          const candidates = schedule.triggers.filter((trigger: any) => triggerIds(data).includes(trigger.id));
          const values: any[] = [];
          for (const trigger of candidates) {
            let value = trigger.params;
            for (const part of path.slice(1)) value = value && typeof value === "object" && Object.hasOwn(value, part) ? value[part] : undefined;
            if (value === undefined) err(f, `${fromStep}: $trigger.params.${path.slice(1).join(".")} is not declared on every trigger variant`);
            else values.push(value);
          }
          return unionSchema(values.map(literalSchema));
        }
        if (path.length !== 1) err(f, `${fromStep}: trigger scalar has no nested fields`);
        if (!known[path[0]]) err(f, `${fromStep}: unknown $trigger field '${path[0]}'`);
        return known[path[0]] ?? null;
      }
      if (m[1] === "instance") {
        const fields: string[] = ["trigger_id", "run_date", ...(data.instance?.fields ?? [])];
        if (path.length !== 1) err(f, `${fromStep}: instance fields are scalar strings`);
        if (!fields.includes(path[0])) err(f, `${fromStep}: $instance.${path[0]} is not a declared instance field`);
        return { type: "string" };
      }
      if (m[1] === "item") {
        if (!itemSchema) { err(f, `${fromStep}: $item used outside for_each`); return null; }
        return path.length ? schemaAt(itemSchema, itemSchema, path) ?? (err(f, `${fromStep}: $item.${path.join(".")} is not a field of the for_each item`), null) : itemSchema;
      }
      return null;
    }

    // Validate literals directly. References are checked structurally against
    // their producing contracts, never by inventing a representative value.
    const hasReference = (value: any): boolean => typeof value === "string" ? value.startsWith("$")
      : Array.isArray(value) ? value.some(hasReference)
      : value && typeof value === "object" ? Object.values(value).some(hasReference) : false;
    function materialize(value: any, fromStep: string, itemSchema?: Schema): void {
      if (typeof value === "string" && value.startsWith("$")) { resolveReference(value, fromStep, itemSchema); return; }
      if (Array.isArray(value)) value.forEach((part) => materialize(part, fromStep, itemSchema));
      else if (value && typeof value === "object") Object.values(value).forEach((part) => materialize(part, fromStep, itemSchema));
    }
    function literal(value: any, schema: Schema, fromStep: string, path: string): void {
      const validate = ajv.compile(schema);
      if (!validate(value)) for (const e of validate.errors ?? []) err(f, `${fromStep}: input ${path + e.instancePath || "/"} ${e.message}${e.params?.additionalProperty ? ` ('${e.params.additionalProperty}')` : ""}`);
    }
    function compatible(actual: Schema, expected: Schema, fromStep: string, path: string): void {
      if (!actual || expected === true) return;
      // Optional leaf references become required runtime output checks in the
      // compiled manifest. Never invent a fallback or silently omit the input.
      if (actual.anyOf || actual.oneOf) { for (const part of actual.anyOf ?? actual.oneOf) compatible(part, expected, fromStep, path); return; }
      if (expected.anyOf || expected.oneOf) {
        const start = errors.length;
        for (const part of expected.anyOf ?? expected.oneOf) {
          errors.splice(start); compatible(actual, part, fromStep, path);
          if (errors.length === start) return;
        }
        errors.splice(start); err(f, `${fromStep}: input ${path} does not fit any permitted schema branch`); return;
      }
      if (expected === false) { err(f, `${fromStep}: input ${path} is forbidden`); return; }
      if (Object.hasOwn(actual, "const")) { literal(actual.const, expected, fromStep, path); return; }
      if (actual.enum) { for (const value of actual.enum) literal(value, expected, fromStep, path); return; }
      if (expected.allOf) { for (const part of expected.allOf) compatible(actual, part, fromStep, path); return; }
      if (actual.allOf) { err(f, `${fromStep}: input ${path} requires an explicit producing schema shape instead of allOf`); return; }
      const types = (schema: Schema): string[] => Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
      const provided = types(actual), accepted = types(expected);
      if (accepted.length && (!provided.length || provided.some((type) => !accepted.includes(type) && !(type === "integer" && accepted.includes("number"))))) {
        err(f, `${fromStep}: input ${path} reference types [${provided.join(",") || "unknown"}] do not fit [${accepted.join(",")}]`); return;
      }
      if (provided.includes("object") && accepted.includes("object")) {
        for (const key of expected.required ?? []) if (!(actual.required ?? []).includes(key)) err(f, `${fromStep}: input ${path}/${key} is not guaranteed by the producing contract`);
        for (const [key, value] of Object.entries(actual.properties ?? {})) {
          if (expected.properties?.[key]) compatible(value, expected.properties[key], fromStep, `${path}/${key}`);
          else if (expected.additionalProperties === false) err(f, `${fromStep}: input ${path}/${key} is forbidden by the consuming contract`);
        }
        if (expected.additionalProperties === false && actual.additionalProperties !== false) err(f, `${fromStep}: input ${path} producer permits unknown properties`);
      }
      if (provided.includes("array") && accepted.includes("array")) compatible(actual.items ?? {}, expected.items ?? {}, fromStep, `${path}/[]`);
      // Pattern, cardinality and value constraints remain runtime validations.
      // Structural compatibility does not prove a dynamic value satisfies them.
    }
    function validateInput(value: any, schema: Schema, fromStep: string, itemSchema?: Schema, path = ""): void {
      if (typeof value === "string" && value.startsWith("$")) { compatible(resolveReference(value, fromStep, itemSchema), schema, fromStep, path); return; }
      if (!hasReference(value)) { literal(value, schema, fromStep, path); return; }
      if (schema.anyOf || schema.oneOf) {
        const start = errors.length;
        for (const part of schema.anyOf ?? schema.oneOf) {
          errors.splice(start); validateInput(value, part, fromStep, itemSchema, path);
          if (errors.length === start) return;
        }
        errors.splice(start); err(f, `${fromStep}: input ${path} does not fit any permitted schema branch`); return;
      }
      if (schema.allOf) { for (const part of schema.allOf) validateInput(value, part, fromStep, itemSchema, path); return; }
      if (!schema.type && !schema.properties && !schema.items) { materialize(value, fromStep, itemSchema); return; }
      if (Array.isArray(value)) {
        if (schema.type !== "array") { err(f, `${fromStep}: input ${path || "/"} must be ${schema.type}`); return; }
        if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) err(f, `${fromStep}: input ${path} violates its array size bound`);
        value.forEach((part, index) => validateInput(part, schema.items ?? {}, fromStep, itemSchema, `${path}/${index}`));
      } else if (value && typeof value === "object") {
        if (schema.type !== "object") { materialize(value, fromStep, itemSchema); return; }
        for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) err(f, `${fromStep}: input ${path || "/"} must have required property '${key}'`);
        for (const [key, part] of Object.entries(value)) {
          const child = schema.properties?.[key] ?? schema.additionalProperties;
          if (child === false) err(f, `${fromStep}: input ${path}/${key} must NOT have additional properties`);
          else validateInput(part, typeof child === "object" ? child : {}, fromStep, itemSchema, `${path}/${key}`);
        }
      }
    }

    for (const s of steps) {
      const marker = markers.find((m) => m.id === s.id)?.marker ?? "";
      const schemas = toolSchemas(s.tool);
      const itemSchema = s.for_each ? (() => { const over = resolveReference(String(s.for_each.over ?? ""), s.id); return over?.items ? deref(over, over.items) : (err(f, `${s.id}: for_each.over must reference an array output`), undefined); })() : undefined;
      if (s.for_each && itemSchema && s.for_each.key && !schemaAt(itemSchema, itemSchema, [s.for_each.key])) err(f, `${s.id}: for_each.key '${s.for_each.key}' is not a field of the item`);

      if (s.for_each && schemas && Number(schemas.risk.slice(1)) >= 3) err(f, `${s.id}: approval-bound effects require one batch, not for_each`);
      if (schemas && !grants.has(s.tool)) err(f, `${s.id}: Tool is not granted to the owning Agent`);
      // risk vs marker
      validateStepOptions(s, outputOf, f, err, s.tool === "route" ? resolveReference(String(s.on), s.id) : undefined);
      if (s.for_each && itemSchema) {
        const key = schemaAt(itemSchema, itemSchema, [s.for_each.key]);
        if (key && (key.__optional || !["string", "integer"].includes(key.type))) err(f, `${s.id}: for_each key must be a required string or integer`);
      }
      const expectedRisk = schemas ? schemas.risk : (["wait", "route"].includes(s.tool) ? "R0" : null);
      if (typeof s.tool === "string" && s.tool.startsWith("human:")) {
        if (!marker.startsWith("human:")) err(f, `${s.id}: decision step must carry a [human:<role>] marker, found [${marker}]`);
        else if (marker !== s.tool) err(f, `${s.id}: marker [${marker}] names a different role than ${s.tool}`);
      } else if (expectedRisk) {
        if (marker.split(",")[0]?.trim() !== data.owner.slice(7)) err(f, `${s.id}: marker owner differs from the Workflow owner`);
        const markerRisk = marker.match(/,\s*(R[0-4])\]?$/)?.[1] ?? marker.split(",").pop()?.trim();
        if (markerRisk !== expectedRisk) err(f, `${s.id}: body marker says ${markerRisk ?? "no risk"} but ${s.tool} is ${expectedRisk}`);
      }

      // targets
      for (const k of ["then", "approve", "reject", "after"]) if (s[k] && s[k] !== "end" && !idset.has(s[k])) err(f, `${s.id}: ${k} -> '${s[k]}' is not a step`);
      if (s.tool === "route") {
        const on = resolveReference(String(s.on ?? ""), s.id);
        const branches = Object.entries(s).filter(([k]) => !["id", "tool", "on", s.id].includes(k));
        for (const [k, v] of branches) if (v !== "end" && !idset.has(v as string)) err(f, `${s.id}: route '${k}' -> '${v}' is not a step`);
        if (on?.enum) for (const value of on.enum) if (!branches.some(([k]) => String(k) === String(value))) err(f, `${s.id}: route has no branch for outcome '${value}'`);
        // a route on a Tool 'outcome' that guards a batch-update must send 'none' to end
        const onMatch = String(s.on ?? "").match(/^\$steps\.([a-z-]+)\.outcome$/);
        if (onMatch) {
          const producer = steps.find((x: any) => x.id === onMatch[1]);
          const producesUpdates = producer && toolSchemas(producer.tool)?.output?.properties?.updates;
          if (producesUpdates) {
            const noneTarget = (s as any).none;
            if (noneTarget !== "end") err(f, `${s.id}: route on ${onMatch[1]}.outcome must send 'none' to 'end' (found '${noneTarget}'); an empty updates array must never reach batch-update`);
          }
        }
      }

      // message steps
      if (s.tool === "oregano:communications/publish") {
        if (!s.template) err(f, `${s.id}: message step needs template:`);
        if (s.input) err(f, `${s.id}: message step must use vars:, not input:`);
        if (!s.vars) err(f, `${s.id}: message step needs vars:`);
        if (!s.destination && !data.defaults?.destination) err(f, `${s.id}: no destination and no defaults.destination`);
        if (s.vars) for (const value of Object.values(s.vars)) validateInput(value, { type: ["string", "number", "boolean"] }, s.id, itemSchema);
        for (const value of [s.thread ?? data.defaults?.thread, s.destination ?? data.defaults?.destination, s.recipient]) {
          if (value !== undefined) validateInput(value, { type: "string", minLength: 1 }, s.id, itemSchema);
        }
        if (s.template) {
          const match = String(s.template).match(/^([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*\.md)$/);
          const path = match ? `${data.owner}/skills/${match[1]}/assets/${match[2]}` : "";
          if (!path || !Object.hasOwn(files, path)) err(f, `${s.id}: template must name an existing owner Skill asset`);
          else {
            const template = workspaceDocument(files, path);
            if (!["plain-text", "provider-markdown"].includes(template.data?.format)) err(f, `${s.id}: template format is not supported`);
            const names = new Set([...template.body.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g)].map((value) => value[1]));
            for (const name of names) if (!Object.hasOwn(s.vars ?? {}, name)) err(f, `${s.id}: template variable '${name}' is not supplied`);
            for (const name of Object.keys(s.vars ?? {})) if (!names.has(name)) err(f, `${s.id}: unused template variable '${name}'`);
          }
        }
        continue;
      }
      if (s.template || s.vars) err(f, `${s.id}: template/vars are only valid on message steps`);

      // decision binds
      if (typeof s.tool === "string" && s.tool.startsWith("human:")) {
        validateInput(s.via, { type: "string", minLength: 1 }, s.id);
        if (!s.binds) err(f, `${s.id}: decision needs binds:`);
        else if (!/^\$steps\.[a-z][a-z0-9-]*(?:\.[A-Za-z0-9_-]+)*$/.test(String(s.binds))) err(f, `${s.id}: decision must bind a prior step output, found ${s.binds}`);
        continue;
      }

      // Tool inputs: full JSON Schema validation of the materialized input
      if (schemas) {
        validateInput(s.input ?? {}, inputOf.get(s.id) ?? schemas.input, s.id, itemSchema);
        if (s.tool === "oregano:work-items/batch-update") {
          const src = String(s.input?.updates ?? "");
          const m = src.match(/^\$steps\.([a-z-]+)\.bound$/);
          if (!m) err(f, `${s.id}: batch-update.updates must come from a bound decision ($steps.<decision>.bound)`);
          else {
            const decision = steps.find((x: any) => x.id === m[1]);
            const bm = String(decision?.binds ?? "").match(/^\$steps\.([a-z-]+)\.updates$/);
            if (!bm) err(f, `${s.id}: decision ${m[1]} must bind a Tool 'updates' output`);
            else if (!steps.some((x: any) => x.tool === "route" && String(x.on) === `$steps.${bm[1]}.outcome`)) err(f, `${s.id}: no route on ${bm[1]}.outcome guards the empty updates case`);
          }
        }
      }
      if (s.require_synced_through) validateInput(s.require_synced_through, { type: "string", format: "date-time" }, s.id);
      if (s.tool === "wait" && typeof s.for === "string" && !triggerParams.has(s.for.slice(9))) err(f, `${s.id}: wait names an undeclared trigger`);
    }
  }
  return errors;
}

function triggerIds(data: any): string[] {
  const raw = String(data.trigger ?? "");
  const m = raw.match(/^schedule:\[?([^\]]+)\]?$/);
  return m ? m[1].split(",").map((s) => s.trim()) : [];
}

function literalSchema(value: any): Schema {
  if (value === null) return { type: "null", enum: [null] };
  if (Array.isArray(value)) return { type: "array", items: unionSchema(value.map(literalSchema)) };
  if (typeof value === "object") return { type: "object", required: Object.keys(value), additionalProperties: false, properties: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, literalSchema(item)])) };
  return { type: typeof value, enum: [value] };
}
function unionSchema(values: Schema[]): Schema {
  if (!values.length) return {};
  const unique = [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
  if (unique.length === 1) return unique[0];
  if (unique.every((value) => value.type === unique[0].type && value.enum)) return { type: unique[0].type, enum: [...new Set(unique.flatMap((value) => value.enum))] };
  return { anyOf: unique };
}

type AuthoringError = (file: string, message: string) => void;
function validateSchedule(data: any, file: string, err: AuthoringError): void {
  const issues = validateJsonSchemaValue(loadSchema("schedule-v1.schema.json"), data);
  for (const issue of issues) err(file, issue);
  if (issues.length) return;
  try { new Intl.DateTimeFormat("en", { timeZone: data.timezone }).format(0); }
  catch { err(file, "Schedule requires an existing IANA timezone"); }
  if (data.delivery_window.opens_at >= data.delivery_window.closes_at) err(file, "Delivery window must open before it closes");
  for (const [year, days] of Object.entries(data.holiday_calendar.years) as [string, string[]][]) for (const day of days) {
    try { recordInstant(`${day}T00:00:00Z`, "Holiday"); if (!day.startsWith(`${year}-`)) throw new Error("Holiday year mismatch"); }
    catch { err(file, "Holiday must be a valid date in its declared year"); }
  }
  for (const [index, trigger] of data.triggers.entries()) for (const other of data.triggers.slice(0, index)) {
    if (trigger.id !== other.id) continue;
    if (trigger.at === other.at && (trigger.weekdays.some((day: string) => other.weekdays.includes(day)) || [trigger.holiday_shift, other.holiday_shift].some((shift) => shift && shift !== "none"))) err(file, `Trigger ${trigger.id} can fire twice at the same instant`);
  }
}

function validateStepOptions(step: any, output: Map<string, Schema>, file: string, err: AuthoringError, resolvedRoute?: Schema): void {
  let allowed = [step.id, "id", "tool", "after", "then"];
  if (step.tool === "route") {
    const reference = /^\$steps\.([a-z][a-z0-9-]*)\.(.+)$/.exec(step.on ?? "");
    const schema = resolvedRoute ?? (reference ? schemaAt(output.get(reference[1]!), output.get(reference[1]!), reference[2]!.split(".")) : undefined);
    const values = schema?.enum ?? (schema?.type === "boolean" ? [true, false] : undefined);
    if (!values) err(file, `${step.id}: route requires a finite declared enum or boolean`);
    allowed = [step.id, "id", "tool", "on", ...(values ?? [true, false]).map(String)];
  } else if (step.tool === "wait") allowed.push("for");
  else if (step.tool.startsWith("human:")) allowed = [step.id, "id", "tool", "after", "binds", "via", "timeout", "approve", "reject"];
  else if (step.tool === "oregano:communications/publish") allowed.push("template", "vars", "destination", "recipient", "thread", "for_each");
  else {
    allowed.push("input", "for_each");
    if (step.tool === "oregano:records/query") allowed.push("all_pages", "require_synced_through");
  }
  for (const key of Object.keys(step)) if (!allowed.includes(key)) err(file, `${step.id}: unknown option '${key}' for ${step.tool}`);
  if (step.tool === "wait" && !step.for) err(file, `${step.id}: wait requires for`);
  if (step.tool.startsWith("human:")) for (const key of ["binds", "via", "timeout", "approve", "reject"]) if (step[key] === undefined) err(file, `${step.id}: decision requires ${key}`);
}

function validateStepFlow(steps: any[], file: string, err: AuthoringError): { dominators: Map<string, Set<string>> } {
  const ids: string[] = steps.map((step) => step.id);
  const predecessors = new Map(ids.map((id) => [id, [] as string[]]));
  for (const [index, step] of steps.entries()) {
    const targets: string[] = step.tool === "route" ? Object.entries(step).filter(([key]) => ![step.id, "id", "tool", "on"].includes(key)).map(([, value]) => String(value))
      : typeof step.tool === "string" && step.tool.startsWith("human:") ? [step.approve, step.reject, "end"]
      : [step.then ?? ids[index + 1] ?? "end"];
    if (step.after && (!ids.includes(step.after) || ids.indexOf(step.after) >= index)) err(file, `${step.id}: after must name an earlier step`);
    for (const target of targets) {
      if (target === "end") continue;
      if (!ids.includes(target) || ids.indexOf(target) <= index) err(file, `${step.id}: target ${target} is absent or creates backward control flow`);
      else predecessors.get(target)!.push(step.id);
    }
  }
  const dominators = new Map<string, Set<string>>();
  for (const [index, id] of ids.entries()) {
    const parents = predecessors.get(id)!;
    if (index > 0 && !parents.length) err(file, `${id}: step is unreachable`);
    const inherited = parents.map((parent) => new Set([parent, ...(dominators.get(parent) ?? [])]));
    dominators.set(id, new Set(inherited.length ? [...inherited[0]!].filter((candidate) => inherited.every((set) => set.has(candidate))) : []));
    if (steps[index].after && !dominators.get(id)!.has(steps[index].after)) err(file, `${id}: after dependency can be skipped`);
  }
  return { dominators };
}
