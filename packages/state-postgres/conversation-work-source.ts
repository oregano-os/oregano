import { findByCanonicalPrincipal } from "../state-store/roster.ts";
import { neon } from "@neondatabase/serverless";
import type { CompanyOSArtifact } from "../companyos-builder/types.ts";
import type { ConversationAddress, ConversationScope, ConversationWorkSource, WorkContext } from "../runtime/shared-conversation.ts";
import type { WorkflowAssignment } from "../state-store/workflow-engine.ts";
import { createPostgresWorkflowExecutionStore } from "./workflow-store.ts";
import { createPostgresBuilderJobStore } from "./builder-job-store.ts";
import { ensureWorkflowExecutionSchema } from "./workflow-migrate.ts";
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const address = (a: ConversationAddress): ConversationAddress => ({ surface: a.surface, accountId: a.accountId, channelId: a.channelId, threadId: a.threadId });

/** Bounded SQL projection of existing delivery and job stores, not another work database.
 * The host must authenticate scope. Reads stay inside its current delivery audience. */
export function createPostgresConversationWorkSource(artifact: CompanyOSArtifact): ConversationWorkSource {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Conversation retrieval requires Instance state");
  const sql = neon(url), workflows = createPostgresWorkflowExecutionStore(), builders = createPostgresBuilderJobStore();
  const valid = (scope: ConversationScope) => {
    const member = findByCanonicalPrincipal(artifact.roster, scope.principal);
    if (scope.instanceId !== artifact.instance.id || !member || !/^(active|aktiv)$/i.test(member.status)
      || member.type === "service" || member.type === "agent") throw new Error("Unknown or inactive conversation recipient");
  };
  async function workflow(scope: ConversationScope, key: string): Promise<WorkContext | undefined> {
    const rows = await sql`select assignment_json from companyos.workflow_thread_assignments
      where instance_id = ${scope.instanceId} and assignment_key = ${key}
        and assignment_json->>'surface' = ${scope.surface} and assignment_json->>'accountId' = ${scope.accountId}
        and assignment_json->>'channelId' = ${scope.channelId}
        and (assignment_json->>'subjectPrincipal' = ${scope.principal} or (assignment_json ? 'publication' and not (assignment_json ? 'subjectPrincipal')))`;
    if (!rows[0]) return;
    const a = json<WorkflowAssignment>(rows[0].assignment_json), run = await workflows.read(scope.instanceId, a.runId);
    if (!run) return;
    const pinned = await workflows.getArtifact(run.artifactHash);
    const definition = pinned?.workflows?.find(w => w.id === run.workflowId);
    if (!definition || !artifact.agents.some(agent => agent.id === definition.agentId)) return;
    const published = await workflows.publishedAssignments({ instanceId: scope.instanceId, conversation: { ...address(a), subjectPrincipal: scope.principal }, now: new Date().toISOString() });
    const publication = published.at(-1)?.publication ?? a.publication;
    const title = Object.entries(run.fields).find(([k]) => /(?:title|name)$/i.test(k))?.[1]
      ?? publication?.content.match(/\[([^\]]+)\]\(https?:\/\//)?.[1]
      ?? `${run.workflowId} · ${Object.values(run.fields).join(" · ")}`.slice(0, 250);
    const terminal = ["done", "cancelled", "failed"].includes(run.state.status);
    return { id: `workflow:${key}`, kind: "workflow", agentId: definition.agentId, title, status: run.state.blocked ? "blocked" : run.state.status,
      version: String(run.revision), address: address(a), summary: publication?.content.slice(0, 1500) ?? `${title}: ${run.state.cursor ?? run.state.status}`,
      terminal, context: { assignment: a, runId: run.runId, fields: run.fields, cursor: run.state.cursor, status: run.state.status,
        blocked: run.state.blocked, publication, updatedAt: run.updatedAt } };
  }
  async function builder(scope: ConversationScope, id: string): Promise<WorkContext | undefined> {
    const job = await builders.get(id);
    // Existing job addresses are adapter-issued opaque keys. A new adapter must
    // supply its own source resolver instead of guessing a cross-provider identity.
    const prefix = `${scope.surface}:${scope.channelId}:`;
    if (!job || job.instanceId !== scope.instanceId || job.requesterPrincipal !== scope.principal
      || !job.sourceConversationKey.startsWith(prefix) || !artifact.agents.some(a => a.id === job.agentId)) return;
    return { id: `builder:${job.jobId}`, kind: "builder", agentId: job.agentId, title: job.objective.slice(0, 250),
      status: job.state, terminal: ["published", "cancelled", "failed"].includes(job.state), version: job.updatedAt,
      address: { surface: scope.surface, accountId: scope.accountId, channelId: scope.channelId, threadId: job.sourceConversationKey.slice(prefix.length) },
      summary: job.objective.slice(0, 1500), context: { objective: job.objective, state: job.state, updatedAt: job.updatedAt, evidence: job.evidence, terminalReason: job.terminalReason } };
  }
  const source: ConversationWorkSource = {
    async read(scope, id) {
      valid(scope); await ensureWorkflowExecutionSchema();
      if (id.startsWith("workflow:")) return workflow(scope, id.slice(9));
      if (id.startsWith("builder:")) return builder(scope, id.slice(8));
      return undefined;
    },
    async current(scope, input) {
      valid(scope); await ensureWorkflowExecutionSchema();
      const rows = await sql`select assignment_key from companyos.workflow_thread_assignments
        where instance_id = ${scope.instanceId} and assignment_json->>'surface' = ${scope.surface}
          and assignment_json->>'accountId' = ${scope.accountId} and assignment_json->>'channelId' = ${scope.channelId}
          and assignment_json->>'threadId' = ${input.threadId}
          and (assignment_json->>'subjectPrincipal' = ${scope.principal} or (assignment_json ? 'publication' and not (assignment_json ? 'subjectPrincipal')))
        order by (assignment_json ? 'publication'), expires_at desc limit 1`;
      if (rows[0]) return workflow(scope, String(rows[0].assignment_key));
      const jobs = await sql`select job_id from companyos.builder_jobs where input->>'instanceId' = ${scope.instanceId}
        and input->>'requesterPrincipal' = ${scope.principal} and input->>'sourceConversationKey' = ${`${scope.surface}:${scope.channelId}:${input.threadId}`}
        order by created_at desc limit 1`;
      return jobs[0] ? builder(scope, String(jobs[0].job_id)) : undefined;
    },
    async search(scope, input) {
      valid(scope); await ensureWorkflowExecutionSchema();
      const limit = Math.min(6, Math.max(1, input.limit)), query = (input.query ?? "").slice(0, 200);
      const rows = await sql`select id from (
        select 'workflow:' || a.assignment_key as id, r.identity_json::text || ' ' || r.workflow_id || ' ' || r.state_json::text as searchable
        from companyos.workflow_thread_assignments a join companyos.workflow_executions r on a.run_id = r.run_id and a.instance_id = r.instance_id
        where a.instance_id = ${scope.instanceId} and not (a.assignment_json ? 'publication')
          and a.assignment_json->>'surface' = ${scope.surface} and a.assignment_json->>'accountId' = ${scope.accountId}
          and a.assignment_json->>'channelId' = ${scope.channelId} and a.assignment_json->>'subjectPrincipal' = ${scope.principal}
          and (${input.includeClosed === true} or (r.state_json->>'status' in ('running','waiting') and a.expires_at > now()))
        union all
        select 'builder:' || job_id as id, input->>'objective' as searchable from companyos.builder_jobs
        where input->>'instanceId' = ${scope.instanceId} and input->>'requesterPrincipal' = ${scope.principal}
          and starts_with(input->>'sourceConversationKey', ${`${scope.surface}:${scope.channelId}:`})
          and (${input.includeClosed === true} or state not in ('published','failed','cancelled'))
      ) work where id > ${input.after ?? ""} and position(lower(${query}) in lower(searchable)) > 0
      order by id limit ${limit + 1}`;
      const items: WorkContext[] = [];
      for (const row of rows.slice(0, limit)) { const work = await source.read(scope, String(row.id)); if (work) items.push(work); }
      return { items, ...(rows.length > limit ? { next: String(rows[limit - 1]!.id) } : {}) };
    },
  };
  return source;
}
