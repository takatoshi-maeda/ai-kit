import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentRegistry } from "./agent-registry.js";
import type { McpPersistence } from "./persistence.js";
import {
  AgentRunParamsSchema,
  handleAgentList,
  handleAgentRun,
} from "./tools/agent.js";
import type { AgentToolDeps } from "./tools/agent.js";
import {
  ConversationsListParamsSchema,
  ConversationsGetParamsSchema,
  ConversationsDeleteParamsSchema,
  handleConversationsList,
  handleConversationsGet,
  handleConversationsDelete,
} from "./tools/conversations.js";
import {
  UsageSummaryParamsSchema,
  handleUsageSummary,
} from "./tools/usage.js";
import { handleHealthCheck } from "./tools/health.js";

export interface McpServerOptions {
  /** サーバー名（MCP プロトコルの server_info.name） */
  serverName?: string;
  /** サーバーバージョン */
  serverVersion?: string;
  /** エージェントレジストリ。agent.run / agent.list ツールに必要 */
  agentRegistry?: AgentRegistry;
  /** 永続化バックエンド */
  persistence: McpPersistence;
}

/**
 * MCP プロトコル準拠のサーバーを生成し、全ツールを自動登録する。
 */
export function buildMcpServer(options: McpServerOptions): SdkMcpServer {
  const {
    serverName = "ai-kit",
    serverVersion = "0.1.0",
    agentRegistry,
    persistence,
  } = options;

  const server = new SdkMcpServer(
    { name: serverName, version: serverVersion },
    { capabilities: { tools: {}, logging: {} } },
  );

  // --- Agent tools ---
  if (agentRegistry) {
    server.registerTool("agent.list", {
      description: "List available agents",
    }, async () => {
      const deps: AgentToolDeps = { registry: agentRegistry, persistence };
      return handleAgentList(deps);
    });

    const runShape = extractShape(AgentRunParamsSchema);
    server.registerTool("agent.run", {
      description: "Run an agent with the given message",
      inputSchema: runShape,
    }, async (args, extra) => {
      const parsed = AgentRunParamsSchema.parse(args);
      const deps: AgentToolDeps = {
        registry: agentRegistry,
        persistence,
        sendNotification: async (method, params) => {
          const token = parsed.notificationToken;
          const payload: Record<string, unknown> = { ...params };
          if (typeof token === "string" && token) {
            payload.notificationToken = token;
          }
          await extra.sendNotification({
            method: method as never,
            params: payload,
          });
        },
      };
      return handleAgentRun(deps, parsed);
    });
  }

  // --- Conversation tools ---
  const listShape = extractShape(ConversationsListParamsSchema);
  server.registerTool("conversations.list", {
    description: "List conversations",
    inputSchema: listShape,
  }, async (args) => {
    const parsed = ConversationsListParamsSchema.parse(args);
    return handleConversationsList(persistence, parsed);
  });

  const getShape = extractShape(ConversationsGetParamsSchema);
  server.registerTool("conversations.get", {
    description: "Get a conversation by session ID",
    inputSchema: getShape,
  }, async (args) => {
    const parsed = ConversationsGetParamsSchema.parse(args);
    return handleConversationsGet(persistence, parsed);
  });

  const deleteShape = extractShape(ConversationsDeleteParamsSchema);
  server.registerTool("conversations.delete", {
    description: "Delete a conversation",
    inputSchema: deleteShape,
  }, async (args) => {
    const parsed = ConversationsDeleteParamsSchema.parse(args);
    return handleConversationsDelete(persistence, parsed);
  });

  // --- Usage tool ---
  const usageShape = extractShape(UsageSummaryParamsSchema);
  server.registerTool("usage.summary", {
    description: "Get usage cost summary",
    inputSchema: usageShape,
  }, async (args) => {
    const parsed = UsageSummaryParamsSchema.parse(args);
    return handleUsageSummary(persistence, parsed);
  });

  // --- Health tool ---
  server.registerTool("health.check", {
    description: "Check storage health",
  }, async () => {
    return handleHealthCheck(persistence);
  });

  return server;
}

/**
 * Zod object schema から MCP SDK が受け付ける raw shape を抽出する。
 * MCP SDK の registerTool は ZodRawShape (Record<string, ZodType>) を期待する。
 */
function extractShape<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): T {
  return schema.shape;
}
