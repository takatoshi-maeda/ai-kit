export interface ActiveRunHandle {
  appName: string;
  userId: string;
  agentId: string;
  sessionId: string;
  runId: string;
  controller: AbortController;
}

export interface CancelActiveRunInput {
  appName: string;
  userId: string;
  sessionId: string;
  runId: string;
  agentId?: string;
  reason?: string;
}

function buildKey(handle: Pick<ActiveRunHandle, "appName" | "userId" | "agentId" | "sessionId" | "runId">): string {
  return [
    handle.appName,
    handle.userId,
    handle.agentId,
    handle.sessionId,
    handle.runId,
  ].join(":");
}

export class ActiveRunRegistry {
  readonly #runs = new Map<string, ActiveRunHandle>();

  register(handle: ActiveRunHandle): void {
    this.#runs.set(buildKey(handle), handle);
  }

  unregister(handle: Pick<ActiveRunHandle, "appName" | "userId" | "agentId" | "sessionId" | "runId">): void {
    this.#runs.delete(buildKey(handle));
  }

  cancel(input: CancelActiveRunInput): boolean {
    const agentIds = input.agentId
      ? [input.agentId]
      : this.listAgentIds(input.appName, input.userId, input.sessionId, input.runId);

    for (const agentId of agentIds) {
      const key = buildKey({
        appName: input.appName,
        userId: input.userId,
        agentId,
        sessionId: input.sessionId,
        runId: input.runId,
      });
      const handle = this.#runs.get(key);
      if (!handle) {
        continue;
      }
      handle.controller.abort(input.reason);
      return true;
    }
    return false;
  }

  listAgentIds(
    appName: string,
    userId: string,
    sessionId: string,
    runId: string,
  ): string[] {
    const agentIds: string[] = [];
    for (const handle of this.#runs.values()) {
      if (
        handle.appName === appName &&
        handle.userId === userId &&
        handle.sessionId === sessionId &&
        handle.runId === runId
      ) {
        agentIds.push(handle.agentId);
      }
    }
    return agentIds;
  }
}
