import { z } from "zod";
import type { AgentRegistry } from "../agent-registry.js";
import type { McpPersistence, ConversationTurn, RunState } from "../persistence.js";
import { AgentContextImpl } from "../../context.js";
import { InMemoryHistory } from "../../conversation/memory-history.js";
import type { LLMStreamEvent } from "../../../types/stream-events.js";

/** agent.run ツールの入力パラメータ */
export const AgentRunParamsSchema = z.object({
  message: z.string().describe("The user message to send to the agent"),
  idempotencyKey: z.string().optional().describe("Idempotency key for deduplication"),
  sessionId: z.string().optional().describe("Session ID for conversation continuity"),
  title: z.string().optional().describe("Title for the conversation"),
  params: z.record(z.unknown()).optional().describe("Additional parameters for the agent"),
  agentId: z.string().optional().describe("Agent ID to use. Defaults to the default agent"),
  stream: z.boolean().optional().describe("Enable streaming notifications"),
  notificationToken: z.string().optional().describe("Token for stream notifications"),
});

export type AgentRunParams = z.infer<typeof AgentRunParamsSchema>;

/** agent.run ツールの戻り値 */
export interface AgentRunResult {
  sessionId: string;
  runId: string;
  turnId: string;
  status: "success" | "error" | "cancelled";
  responseId?: string;
  message: string;
  agentId?: string;
  idempotencyKey?: string;
  errorMessage?: string;
}

/** MCP ストリーム通知イベント */
export type McpStreamNotification =
  | { type: "agent.change_state.started"; sessionId: string; runId: string; agentId?: string; agentName?: string }
  | { type: "agent.reasoning_summary_delta"; delta: string }
  | {
    type: "agent.tool_call";
    summary: string;
    description?: string;
    toolCallId?: string;
    arguments?: Record<string, unknown>;
  }
  | { type: "agent.tool_call_finish"; summary: string }
  | { type: "agent.text_delta"; delta: string }
  | { type: "agent.text_result"; summary?: string; description?: string; responseId?: string }
  | { type: "agent.result"; responseId?: string; item?: Record<string, unknown> }
  | { type: "agent.cumulative_cost"; amount: number }
  | { type: "agent.change_state.finished"; sessionId: string; runId: string; agentId?: string }
  | { type: "agent.change_state.error"; sessionId: string; runId: string; agentId?: string }
  | { type: "agent.change_state.cancelled"; sessionId: string; runId: string; agentId?: string };

export interface AgentToolDeps {
  registry: AgentRegistry;
  persistence: McpPersistence;
  sendNotification?: (method: string, params: Record<string, unknown>) => Promise<void>;
}

export async function handleAgentList(
  deps: AgentToolDeps,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}> {
  const rawPayload = deps.registry.listPayload();
  const payload = {
    defaultAgentId: rawPayload.defaultAgentId,
    agents: rawPayload.agents.map((agent) => ({
      agentId: agent.agentId,
      description: agent.description ?? null,
    })),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

export async function handleAgentRun(
  deps: AgentToolDeps,
  params: AgentRunParams,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}> {
  const {
    message,
    idempotencyKey,
    sessionId: requestedSessionId,
    title,
    params: agentParams,
    agentId: requestedAgentId,
    stream: enableStream,
  } = params;

  const agentId = deps.registry.resolveAgentId(requestedAgentId);
  const sessionId = requestedSessionId ?? crypto.randomUUID();
  const runId = crypto.randomUUID();
  const turnId = crypto.randomUUID();

  // Check idempotency
  if (idempotencyKey) {
    const existing = await deps.persistence.readIdempotencyRecord(
      idempotencyKey,
      sessionId,
      agentId,
    );
    if (existing) {
      const payload = toAgentRunWireResult(
        existing.result as Partial<AgentRunResult> & Record<string, unknown>,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload, null, 2),
          },
        ],
        structuredContent: payload,
        isError: payload.status === "error",
      };
    }
  }

  // Record run state as started
  const startedAt = new Date().toISOString();
  await deps.persistence.appendRunState(sessionId, {
    runId,
    turnId,
    status: "started",
    startedAt,
    updatedAt: startedAt,
    userMessage: message,
    agentId,
  });

  // Send start notification
  if (enableStream && deps.sendNotification) {
    await deps.sendNotification("agent/stream-response", {
      type: "agent.change_state.started",
      sessionId,
      runId,
      agentId,
    });
  }

  // Record input message
  await deps.persistence.appendInputMessageHistory(message, sessionId, runId);

  // Create agent context and run
  const entry = deps.registry.get(agentId);
  const context = new AgentContextImpl({
    history: new InMemoryHistory(),
    sessionId,
    selectedAgentName: agentId,
  });

  const agent = entry.create(context, agentParams);

  let result: AgentRunResult;

  try {
    if (enableStream && deps.sendNotification) {
      // Run with streaming notifications
      const agentStream = agent.stream(message);
      for await (const event of agentStream) {
        await forwardStreamEvent(event, deps.sendNotification);
      }
      const agentResult = await agentStream.result;

      result = {
        sessionId,
        runId,
        turnId,
        status: "success",
        responseId: agentResult.responseId ?? undefined,
        message: agentResult.content ?? "",
        agentId,
        idempotencyKey,
      };

      // Record cost
      if (agentResult.usage.totalCost > 0) {
        await deps.persistence.appendUsage(
          agentResult.usage.totalCost,
          "usd",
          sessionId,
          runId,
        );
        await deps.sendNotification("agent/stream-response", {
          type: "agent.cumulative_cost",
          amount: agentResult.usage.totalCost,
        });
      }

      await deps.sendNotification("agent/stream-response", {
        type: "agent.change_state.finished",
        sessionId,
        runId,
        agentId,
      });
    } else {
      // Non-streaming run
      const agentResult = await agent.invoke(message);

      result = {
        sessionId,
        runId,
        turnId,
        status: "success",
        responseId: agentResult.responseId ?? undefined,
        message: agentResult.content ?? "",
        agentId,
        idempotencyKey,
      };

      if (agentResult.usage.totalCost > 0) {
        await deps.persistence.appendUsage(
          agentResult.usage.totalCost,
          "usd",
          sessionId,
          runId,
        );
      }
    }

    // Persist turn
    const turn: ConversationTurn = {
      turnId,
      runId,
      timestamp: new Date().toISOString(),
      userMessage: message,
      assistantMessage: result.message,
      status: "success",
      agentId,
    };
    await deps.persistence.appendConversationTurn(sessionId, turn, title);

    // Update run state
    await deps.persistence.appendRunState(sessionId, {
      runId,
      turnId,
      status: "success",
      startedAt,
      updatedAt: new Date().toISOString(),
      userMessage: message,
      assistantMessage: result.message,
      agentId,
    });
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : String(err);

    result = {
      sessionId,
      runId,
      turnId,
      status: "error",
      message: "",
      agentId,
      idempotencyKey,
      errorMessage,
    };

    // Persist error turn
    const turn: ConversationTurn = {
      turnId,
      runId,
      timestamp: new Date().toISOString(),
      userMessage: message,
      assistantMessage: "",
      status: "error",
      errorMessage,
      agentId,
    };
    await deps.persistence.appendConversationTurn(sessionId, turn, title);

    // Update run state
    await deps.persistence.appendRunState(sessionId, {
      runId,
      turnId,
      status: "error",
      startedAt,
      updatedAt: new Date().toISOString(),
      userMessage: message,
      agentId,
    });

    if (enableStream && deps.sendNotification) {
      await deps.sendNotification("agent/stream-response", {
        type: "agent.change_state.error",
        sessionId,
        runId,
        agentId,
      });
    }
  }

  const payload = toAgentRunWireResult(result);

  // Write idempotency record
  if (idempotencyKey) {
    await deps.persistence.writeIdempotencyRecord({
      idempotencyKey,
      sessionId,
      runId,
      status: result.status,
      result: payload,
      agentId,
      createdAt: new Date().toISOString(),
    });
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: result.status === "error",
  };
}

async function forwardStreamEvent(
  event: LLMStreamEvent,
  sendNotification: (method: string, params: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  switch (event.type) {
    case "text.delta":
      await sendNotification("agent/stream-response", {
        type: "agent.text_delta",
        delta: event.delta,
      });
      break;
    case "reasoning.delta":
      await sendNotification("agent/stream-response", {
        type: "agent.reasoning_summary_delta",
        delta: event.delta,
      });
      break;
    case "tool_call.arguments.done":
      await sendNotification("agent/stream-response", {
        type: "agent.tool_call",
        summary: event.name,
        toolCallId: event.toolCallId,
        arguments: event.arguments,
        description: JSON.stringify(event.arguments, null, 2),
      });
      break;
    case "response.completed":
      if (event.result.content) {
        await sendNotification("agent/stream-response", {
          type: "agent.text_result",
          responseId: event.result.responseId ?? undefined,
        });
      }
      break;
  }
}

function toAgentRunWireResult(
  result: Partial<AgentRunResult> | Record<string, unknown>,
): Record<string, unknown> {
  const source = result as Record<string, unknown>;
  const sessionId = stringOrUndefined(source.sessionId ?? source.session_id);
  const runId = stringOrUndefined(source.runId ?? source.run_id);
  const turnId = stringOrUndefined(source.turnId ?? source.turn_id);
  const responseId = stringOrUndefined(source.responseId ?? source.response_id);
  const message = stringOrUndefined(source.message);
  const agentId = stringOrUndefined(source.agentId ?? source.agent_id);
  const idempotencyKey = stringOrUndefined(
    source.idempotencyKey ?? source.idempotency_key,
  );
  const notificationToken = stringOrUndefined(
    source.notificationToken ?? source.notification_token,
  );
  const errorMessage = stringOrUndefined(source.errorMessage ?? source.error_message);
  const status = stringOrUndefined(source.status) ?? "error";

  return {
    sessionId: sessionId ?? null,
    runId: runId ?? null,
    turnId: turnId ?? null,
    status,
    responseId: responseId ?? null,
    message: message ?? "",
    agentId: agentId ?? null,
    idempotencyKey: idempotencyKey ?? null,
    notificationToken: notificationToken ?? null,
    errorMessage: errorMessage ?? null,
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
