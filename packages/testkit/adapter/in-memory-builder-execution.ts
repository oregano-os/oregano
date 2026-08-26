import {
  assertBuilderExecutionHandle,
  assertBuilderExecutionRequest,
  type BuilderExecutionAdapter,
  type BuilderExecutionHandle,
  type BuilderExecutionRequest,
  type BuilderExecutionResult,
  type BuilderExecutionState,
  type BuilderExecutionStatus,
} from "../../runtime/builder/execution.ts";

interface FakeExecution {
  readonly request: BuilderExecutionRequest;
  readonly handle: BuilderExecutionHandle;
  readonly startedAt: string;
  state: BuilderExecutionState;
  finishedAt?: string;
  evidence: Record<string, unknown>;
  artifacts?: BuilderExecutionResult["artifacts"];
  disposed: boolean;
}

export interface InMemoryBuilderExecutionStore {
  readonly executions: Map<string, FakeExecution>;
  readonly jobExecutions: Map<string, string>;
  sequence: number;
}

export function createInMemoryBuilderExecutionStore(): InMemoryBuilderExecutionStore {
  return {
    executions: new Map(),
    jobExecutions: new Map(),
    sequence: 0,
  };
}

export class InMemoryBuilderExecutionAdapter implements BuilderExecutionAdapter {
  readonly id = "testkit-memory";
  readonly version = "1.0.0";
  readonly #store: InMemoryBuilderExecutionStore;
  readonly #now: () => string;

  constructor(
    now: () => string = () => new Date().toISOString(),
    store: InMemoryBuilderExecutionStore = createInMemoryBuilderExecutionStore(),
  ) {
    this.#now = now;
    this.#store = store;
  }

  async start(request: BuilderExecutionRequest): Promise<BuilderExecutionHandle> {
    assertBuilderExecutionRequest(request);
    const existingId = this.#store.jobExecutions.get(request.jobId);
    if (existingId) {
      const existing = this.#required(existingId);
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
        throw new Error("Builder job id was reused with a different execution request.");
      }
      return existing.handle;
    }
    const executionId = `builder-fake-${++this.#store.sequence}`;
    const handle: BuilderExecutionHandle = {
      jobId: request.jobId,
      executionId,
      adapter: { id: this.id, version: this.version },
    };
    this.#store.executions.set(executionId, {
      request,
      handle,
      startedAt: this.#now(),
      state: "running",
      evidence: {},
      artifacts: undefined,
      disposed: false,
    });
    this.#store.jobExecutions.set(request.jobId, executionId);
    return handle;
  }

  async status(handle: BuilderExecutionHandle): Promise<BuilderExecutionStatus> {
    const execution = this.#fromHandle(handle);
    return { state: execution.state, observedAt: this.#now() };
  }

  async cancel(handle: BuilderExecutionHandle): Promise<void> {
    const execution = this.#fromHandle(handle);
    if (execution.state === "starting" || execution.state === "running") {
      execution.state = "cancelled";
      execution.finishedAt = this.#now();
    }
  }

  async collect(handle: BuilderExecutionHandle): Promise<BuilderExecutionResult> {
    const execution = this.#fromHandle(handle);
    if (!execution.finishedAt || !this.#isTerminal(execution.state)) {
      throw new Error("Builder execution result is unavailable before a terminal state.");
    }
    return {
      state: execution.state,
      startedAt: execution.startedAt,
      finishedAt: execution.finishedAt,
      evidence: structuredClone(execution.evidence),
      artifacts: execution.artifacts ? structuredClone(execution.artifacts) : undefined,
    };
  }

  async dispose(handle: BuilderExecutionHandle): Promise<void> {
    const execution = this.#fromHandle(handle, true);
    execution.disposed = true;
  }

  finish(
    handle: BuilderExecutionHandle,
    state: Extract<BuilderExecutionState, "succeeded" | "failed" | "timed_out">,
    evidence: Record<string, unknown> = {},
    artifacts?: BuilderExecutionResult["artifacts"],
  ): void {
    const execution = this.#fromHandle(handle);
    if (this.#isTerminal(execution.state)) throw new Error("Builder execution is already terminal.");
    execution.state = state;
    execution.finishedAt = this.#now();
    execution.evidence = structuredClone(evidence);
    execution.artifacts = artifacts ? structuredClone(artifacts) : undefined;
  }

  isDisposed(handle: BuilderExecutionHandle): boolean {
    return this.#fromHandle(handle, true).disposed;
  }

  #fromHandle(handle: BuilderExecutionHandle, allowDisposed = false): FakeExecution {
    assertBuilderExecutionHandle(this, handle);
    const execution = this.#required(handle.executionId);
    if (execution.handle.jobId !== handle.jobId) throw new Error("Builder execution handle job does not match.");
    if (execution.disposed && !allowDisposed) throw new Error("Builder execution environment has been disposed.");
    return execution;
  }

  #required(executionId: string): FakeExecution {
    const execution = this.#store.executions.get(executionId);
    if (!execution) throw new Error(`Unknown Builder execution '${executionId}'.`);
    return execution;
  }

  #isTerminal(state: BuilderExecutionState): state is BuilderExecutionResult["state"] {
    return state === "succeeded" || state === "failed" || state === "cancelled" || state === "timed_out";
  }
}
