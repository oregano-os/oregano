import { sha256 } from "../canonical.ts";
import type { BuilderJob } from "../../state-store/builder-jobs.ts";

/** Durable company/user selection. Provider conversation references stay opaque. */
export interface BuilderExperienceStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
}
export interface BuilderRequestReference {
  jobId: string; objective: string; createdAt: string; sourceConversation: string;
}
export const builderDecisionKey = (jobId: string) => `builder:proposal-decision:${jobId}`;
export const builderOperationLock = (jobId: string) => `builder:operation:${jobId}`;
export const builderCurrentRequestKey = (instance: string, actor: string, conversation: string) => `builder:current:${sha256([instance, actor, conversation])}`;
export const builderUserRequestsKey = (instance: string, actor: string) => `builder:requests:${sha256([instance, actor])}`;
export const builderSelectionKey = (instance: string, actor: string) => `builder:selected:${sha256([instance, actor])}`;
export const builderConversationKey = (conversation: string) => `builder:test-conversation:${sha256(conversation)}`;

/** Caller serializes updates for this user, preventing late worker completion from selecting an older build. */
export async function rememberBuilderRequest(state: BuilderExperienceStore, job: BuilderJob) {
  const key = builderUserRequestsKey(job.instanceId, job.requesterPrincipal);
  const previous = await state.get<BuilderRequestReference[]>(key) ?? [];
  const entry = { jobId: job.jobId, objective: job.objective, createdAt: job.createdAt, sourceConversation: job.sourceConversationKey };
  const all = [...previous.filter(item => item.jobId !== job.jobId), entry].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId)).slice(0, 30);
  await state.set(key, all);
  const current = all.find(item => item.sourceConversation === job.sourceConversationKey);
  if (current) await state.set(builderCurrentRequestKey(job.instanceId, job.requesterPrincipal, job.sourceConversationKey), current);
  if (!previous.some(item => item.jobId === job.jobId) && all[0]?.jobId === job.jobId) {
    await state.set(builderSelectionKey(job.instanceId, job.requesterPrincipal), entry);
  }
}

export async function selectBuilderRequest(state: BuilderExperienceStore, instance: string, actor: string, job: BuilderJob) {
  if (job.instanceId !== instance || job.requesterPrincipal !== actor || job.state !== "published") throw new Error("Select only your own prepared build.");
  if (await state.get(builderDecisionKey(job.jobId))) throw new Error("This build has a pending or completed decision.");
  await state.set(builderSelectionKey(instance, actor), { jobId: job.jobId, objective: job.objective, createdAt: job.createdAt, sourceConversation: job.sourceConversationKey } satisfies BuilderRequestReference);
}

export interface BuilderTestDestination { channel: string; url: string; label: string; }
/** Implemented by the communication adapter; Core never parses provider IDs. */
export interface BuilderTestSurface {
  destination(binding: string): BuilderTestDestination;
  contains(binding: string, conversation: string): boolean;
  isRoot(conversation: string, messageId: string): boolean;
  qualify(binding: string): Promise<void>;
  permalink(conversation: string): Promise<string>;
}

export const builderUserLock = (instance: string, actor: string) => `builder:user:${sha256([instance, actor])}`;
