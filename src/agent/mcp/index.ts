import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpPersistence } from "./persistence.js";
import type { AgentRegistry } from "./agent-registry.js";
import { JsonlMcpPersistence } from "./jsonl-persistence.js";
import { FileSystemStorage } from "../../storage/fs.js";
import { buildMcpServer } from "./server.js";

export { AgentRegistry } from "./agent-registry.js";
export type { AgentEntry, AgentRegistryOptions } from "./agent-registry.js";
export {
  AgentRuntimeValidationError,
  hasRequestedRuntime,
  resolveAgentRuntime,
} from "./runtime.js";
export { JsonlMcpPersistence } from "./jsonl-persistence.js";
export { FilesystemPersistence } from "../persistence/filesystem.js";
export { PostgresPersistence } from "../persistence/postgres.js";
export { SupabasePersistence } from "../persistence/supabase.js";
export type {
  CreatePersistenceBundleOptions,
  FileSystemBackend,
  PostgresBackend,
  PersistenceBackendOptions,
  PersistenceBundle,
  SupabaseBackend,
} from "../persistence/factory.js";
export { createPersistenceBundle } from "../persistence/factory.js";
export { FileSystemPublicAssetStorage } from "../public-assets/filesystem.js";
export {
  SupabasePublicAssetStorage,
  fromSupabaseAssetRef,
  toSupabaseAssetRef,
} from "../public-assets/supabase.js";
export type {
  AgentSessionState,
  AgentSkillsSessionState,
  AgentPersistence,
  McpPersistence,
  Conversation,
  ConversationStateEvent,
  ConversationSummary,
  ConversationTurn,
  TimelineItem,
  McpUsageSummary,
  IdempotencyRecord,
  RunState,
} from "./persistence.js";
export type {
  PublicAssetReadResult,
  PublicAssetResolution,
  PublicAssetStorage,
  SavePublicFileInput,
  SavePublicFileResult,
  SavePublicImageInput,
  SavePublicImageResult,
} from "../public-assets/storage.js";
export type {
  AgentRunParams,
  AgentRunResult,
  McpStreamNotification,
} from "./tools/agent.js";
export { buildMcpServer } from "./server.js";
export type { McpServerOptions } from "./server.js";

export interface CreateMcpServerOptions {
  /** サーバー名（MCP プロトコルの server_info.name） */
  serverName?: string;
  /** サーバーバージョン */
  serverVersion?: string;
  /** エージェントレジストリ。agent.run / agent.list ツールに必要 */
  agentRegistry?: AgentRegistry;
  /** 永続化バックエンド。未指定時は JsonlMcpPersistence（FileSystemStorage）を使用 */
  persistence?: McpPersistence;
  /** JsonlMcpPersistence 使用時のベースディレクトリ。デフォルト: ".ai-kit-data" */
  dataDir?: string;
}

/**
 * MCP プロトコル準拠のサーバーを生成する。
 * 全 MCP ツール（agent / conversations / usage / health）を自動登録する。
 *
 * @example
 * const server = createMcpServer({
 *   serverName: "my-agent",
 *   agentRegistry: new AgentRegistry({
 *     agents: [{ create: (ctx) => new MyAgent(ctx), description: "My agent" }],
 *   }),
 * });
 *
 * // Start with stdio transport
 * const transport = new StdioServerTransport();
 * await server.connect(transport);
 */
export function createMcpServer(options?: CreateMcpServerOptions): McpServer {
  const persistence =
    options?.persistence ??
    new JsonlMcpPersistence(
      new FileSystemStorage(options?.dataDir ?? ".ai-kit-data"),
    );

  return buildMcpServer({
    serverName: options?.serverName,
    serverVersion: options?.serverVersion,
    agentRegistry: options?.agentRegistry,
    persistence,
  });
}
