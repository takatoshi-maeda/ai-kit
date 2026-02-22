import type {
  AgentHooks,
  AfterRunAction,
  BeforeTurnContext,
  AfterTurnContext,
  BeforeToolCallContext,
  AfterToolCallContext,
  AfterRunContext,
} from "../types/agent.js";

export async function runBeforeTurnHooks(
  hooks: AgentHooks | undefined,
  ctx: BeforeTurnContext,
): Promise<void> {
  if (!hooks?.beforeTurn) return;
  for (const hook of hooks.beforeTurn) {
    await hook(ctx);
  }
}

export async function runAfterTurnHooks(
  hooks: AgentHooks | undefined,
  ctx: AfterTurnContext,
): Promise<void> {
  if (!hooks?.afterTurn) return;
  for (const hook of hooks.afterTurn) {
    await hook(ctx);
  }
}

export async function runBeforeToolCallHooks(
  hooks: AgentHooks | undefined,
  ctx: BeforeToolCallContext,
): Promise<void> {
  if (!hooks?.beforeToolCall) return;
  for (const hook of hooks.beforeToolCall) {
    await hook(ctx);
  }
}

export async function runAfterToolCallHooks(
  hooks: AgentHooks | undefined,
  ctx: AfterToolCallContext,
): Promise<void> {
  if (!hooks?.afterToolCall) return;
  for (const hook of hooks.afterToolCall) {
    await hook(ctx);
  }
}

export async function runAfterRunHooks(
  hooks: AgentHooks | undefined,
  ctx: AfterRunContext,
): Promise<AfterRunAction> {
  if (!hooks?.afterRun) return { type: "done" };
  for (const hook of hooks.afterRun) {
    const action = await hook(ctx);
    if (action.type === "rerun") return action;
  }
  return { type: "done" };
}
