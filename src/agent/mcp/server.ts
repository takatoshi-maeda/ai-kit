import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestRuntimeScope, type AuthContext } from "../../auth/index.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { McpPersistence } from "./persistence.js";
import type { PublicAssetStorage } from "../public-assets/storage.js";
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
import {
  SkillsListParamsSchema,
  handleSkillsList,
} from "./tools/skills.js";

export interface McpServerOptions {
  /** サーバー名（MCP プロトコルの server_info.name） */
  serverName?: string;
  /** サーバーバージョン */
  serverVersion?: string;
  /** エージェントレジストリ。agent.run / agent.list ツールに必要 */
  agentRegistry?: AgentRegistry;
  /** 永続化バックエンド */
  persistence: McpPersistence;
  /** HTTP mount / persistence partition name */
  appName?: string;
  /** base64 画像や内部 asset ref を解決する公開アセットストレージ */
  publicAssetStorage?: PublicAssetStorage;
  /** base64 画像を正規化して保存する公開アセット用ディレクトリ */
  publicAssetsDir?: string;
  /** 公開アセット配信用の URL ベースパス */
  publicAssetsBasePath?: string;
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
    appName,
    publicAssetStorage,
    publicAssetsDir,
    publicAssetsBasePath,
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
      const runtime = resolveRuntimeServices(
        persistence,
        publicAssetStorage,
        publicAssetsDir,
      );
      const deps: AgentToolDeps = {
        registry: agentRegistry,
        persistence: runtime.persistence,
        authContext: runtime.auth,
      };
      return handleAgentList(deps);
    });

    const runShape = extractShape(AgentRunParamsSchema);
    server.registerTool("agent.run", {
      description: "Run an agent with the given message",
      inputSchema: runShape,
    }, async (args, extra) => {
      const parsed = AgentRunParamsSchema.parse(args);
      const runtime = resolveRuntimeServices(
        persistence,
        publicAssetStorage,
        publicAssetsDir,
      );
      const deps: AgentToolDeps = {
        registry: agentRegistry,
        persistence: runtime.persistence,
        appName,
        publicAssetStorage: runtime.publicAssetStorage,
        publicAssetsDir: runtime.publicAssetsDir,
        publicAssetsBasePath,
        authContext: runtime.auth,
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
    return handleConversationsList(resolveRuntimeServices(
      persistence,
      publicAssetStorage,
      publicAssetsDir,
    ).persistence, {
      ...parsed,
      agentId: resolveConversationAgentId(agentRegistry, parsed.agentId),
    });
  });

  const getShape = extractShape(ConversationsGetParamsSchema);
  server.registerTool("conversations.get", {
    description: "Get a conversation by session ID",
    inputSchema: getShape,
  }, async (args, extra) => {
    const parsed = ConversationsGetParamsSchema.parse(args);
    const isHttpTransport = parsed._httpTransport === true || extra.requestInfo !== undefined;
    const runtime = resolveRuntimeServices(
      persistence,
      publicAssetStorage,
      publicAssetsDir,
    );
    return handleConversationsGet(runtime.persistence, {
      ...parsed,
      agentId: resolveConversationAgentId(agentRegistry, parsed.agentId),
      _httpTransport: isHttpTransport,
    }, {
      appName,
      publicAssetsBasePath,
    });
  });

  const deleteShape = extractShape(ConversationsDeleteParamsSchema);
  server.registerTool("conversations.delete", {
    description: "Delete a conversation",
    inputSchema: deleteShape,
  }, async (args) => {
    const parsed = ConversationsDeleteParamsSchema.parse(args);
    return handleConversationsDelete(resolveRuntimeServices(
      persistence,
      publicAssetStorage,
      publicAssetsDir,
    ).persistence, {
      ...parsed,
      agentId: resolveConversationAgentId(agentRegistry, parsed.agentId),
    });
  });

  if (agentRegistry) {
    const skillsShape = extractShape(SkillsListParamsSchema);
    server.registerTool("skills.list", {
      description: "List explicit skills available to an agent from its current working directory and bundled global skills.",
      inputSchema: skillsShape,
    }, async (args) => {
      const parsed = SkillsListParamsSchema.parse(args);
      const runtime = resolveRuntimeServices(
        persistence,
        publicAssetStorage,
        publicAssetsDir,
      );
      return handleSkillsList({
        registry: agentRegistry,
        authContext: runtime.auth,
      }, parsed);
    });
  }

  // --- Usage tool ---
  const usageShape = extractShape(UsageSummaryParamsSchema);
  server.registerTool("usage.summary", {
    description: "Get usage cost summary",
    inputSchema: usageShape,
  }, async (args) => {
    const parsed = UsageSummaryParamsSchema.parse(args);
    return handleUsageSummary(resolveRuntimeServices(
      persistence,
      publicAssetStorage,
      publicAssetsDir,
    ).persistence, parsed);
  });

  // --- Health tool ---
  server.registerTool("health.check", {
    description: "Check storage health",
  }, async () => {
    return handleHealthCheck(resolveRuntimeServices(
      persistence,
      publicAssetStorage,
      publicAssetsDir,
    ).persistence);
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

function resolveConversationAgentId(
  agentRegistry: AgentRegistry | undefined,
  agentId?: string,
): string | undefined {
  if (!agentRegistry) {
    return agentId;
  }
  return agentRegistry.resolveAgentId(agentId);
}

function resolveRuntimeServices(
  fallbackPersistence: McpPersistence,
  fallbackPublicAssetStorage?: PublicAssetStorage,
  fallbackPublicAssetsDir?: string,
): {
  auth: AuthContext | undefined;
  persistence: McpPersistence;
  publicAssetStorage?: PublicAssetStorage;
  publicAssetsDir?: string;
} {
  const scope = getRequestRuntimeScope();
  if (scope) {
    return {
      auth: scope.auth,
      persistence: scope.persistence,
      publicAssetStorage: scope.publicAssetStorage,
      publicAssetsDir: scope.publicAssetsDir,
    };
  }
  return {
    auth: undefined,
    persistence: fallbackPersistence,
    publicAssetStorage: fallbackPublicAssetStorage,
    publicAssetsDir: fallbackPublicAssetsDir,
  };
}
