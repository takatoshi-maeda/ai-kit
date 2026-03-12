import { buildMcpServer } from "../agent/mcp/server.js";
import { AgentRegistry } from "../agent/mcp/agent-registry.js";
import { JsonlMcpPersistence } from "../agent/mcp/jsonl-persistence.js";
import type { McpPersistence } from "../agent/mcp/persistence.js";
import { FileSystemStorage } from "../storage/fs.js";
import type { AgentContext } from "../types/agent.js";
import type { ConversationalAgent } from "../agent/conversational.js";
import type { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "node:fs";
import path from "node:path";

const encoder = new TextEncoder();
const MCP_PROTOCOL_VERSION = "2025-06-18";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export type NotificationListener = (message: JSONRPCMessage) => void;

interface PendingRequest {
  resolve: (response: JSONRPCMessage) => void;
  reject: (error: Error) => void;
}

export interface AgentDefinition {
  name: string;
  description?: string;
  create: (
    context: AgentContext,
    params?: Record<string, unknown>,
  ) => ConversationalAgent;
}

export interface AgentGroupAgentDefinition {
  agentId: string;
  description?: string;
  create: AgentDefinition["create"];
}

export interface AgentGroupDefinition {
  mountName: string;
  description?: string;
  agents: AgentGroupAgentDefinition[];
  defaultAgentId?: string;
}

export interface AgentMountDefinition {
  mountName: string;
  description?: string;
}

export interface AgentMount {
  definition: AgentMountDefinition;
  mcpServer: SdkMcpServer;
  persistence: McpPersistence;
  registry: AgentRegistry;
  transport: McpInProcessTransport;
}

export interface MountMcpRoutesOptions {
  agentDefinitions?: AgentDefinition[];
  agentGroups?: AgentGroupDefinition[];
  dataDir?: string;
  basePath?: string;
  /**
   * Hook invoked right after each mount object is created and before the MCP
   * server connects to transport. This allows callers to register custom tools
   * during bootstrap without relying on post-connect mutation timing.
   */
  onMountCreated?: (mount: AgentMount) => Promise<void> | void;
}

export interface McpInProcessTransport {
  request(message: JSONRPCMessage): Promise<JSONRPCMessage>;
  notify(message: JSONRPCMessage): void;
  subscribe(listener: NotificationListener): () => void;
}

export interface MountableHonoApp {
  use(
    path: string,
    handler: (c: any, next: () => Promise<void>) => Promise<unknown> | unknown,
  ): unknown;
  post(path: string, handler: (c: any) => Promise<Response>): unknown;
  get(path: string, handler: (c: any) => Promise<Response> | Response): unknown;
}

export async function mountMcpRoutes(
  app: MountableHonoApp,
  options: MountMcpRoutesOptions,
): Promise<Map<string, AgentMount>> {
  const basePath = options.basePath ?? "/api/mcp";
  const dataDir = options.dataDir ?? "data";
  const definitions = normalizeAgentGroups(options);
  const mounts = await initAgentMounts(
    definitions,
    dataDir,
    basePath,
    options.onMountCreated,
  );
  const startedAt = Date.now();

  app.use(`${basePath}/:agent_name/*`, async (c, next) => {
    const mount = mounts.get(c.req.param("agent_name"));
    if (!mount) {
      return c.json({ error: "agent not found" }, 404);
    }
    c.set("mount", mount);
    await next();
  });

  app.use(`${basePath}/:agent_name`, async (c, next) => {
    const mount = mounts.get(c.req.param("agent_name"));
    if (!mount) {
      return c.json({ error: "agent not found" }, 404);
    }
    c.set("mount", mount);
    await next();
  });

  app.get(`${basePath}/:agent_name/public/*`, async (c) => {
    const mountName = c.req.param("agent_name") ?? "";
    const routePrefix = `${basePath.replace(/\/+$/, "")}/${mountName}/public/`;
    const requested = c.req.path.startsWith(routePrefix)
      ? c.req.path.slice(routePrefix.length)
      : "";
    if (!mountName || requested.length === 0) {
      return c.json({ error: "not found" }, 404);
    }

    const resolved = resolvePublicAssetFilePath(dataDir, mountName, requested);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 400);
    }

    let file: Buffer;
    try {
      const stats = await fs.stat(resolved.fullPath);
      if (!stats.isFile()) {
        return c.json({ error: "not found" }, 404);
      }
      file = await fs.readFile(resolved.fullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "not found" }, 404);
      }
      throw error;
    }

    return new Response(new Uint8Array(file), {
      status: 200,
      headers: {
        "Content-Type": contentTypeFromPath(resolved.fullPath),
        "Cache-Control": IMMUTABLE_CACHE_CONTROL,
      },
    });
  });

  app.post(`${basePath}/:agent_name`, async (c) => {
    const mount = c.get("mount") as AgentMount;
    const { transport } = mount;

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON payload" }, 400);
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return c.json({ error: "expected a JSON-RPC message object" }, 400);
    }

    const message = payload as Record<string, unknown>;
    const mountName = c.req.param("agent_name") ?? "";
    const publicBaseUrl = resolvePublicBaseUrl(c.req.url, basePath, mountName);
    const requestWithHttpMarker = withHttpTransportToolCallMarker(message, publicBaseUrl);
    if (isNotification(message)) {
      transport.notify(requestWithHttpMarker as unknown as JSONRPCMessage);
      return new Response(null, {
        status: 202,
        headers: { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION },
      });
    }

    if (!isRequest(message)) {
      transport.notify(requestWithHttpMarker as unknown as JSONRPCMessage);
      return new Response(null, {
        status: 202,
        headers: { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION },
      });
    }

    return sseResponseFromRequest(transport, requestWithHttpMarker);
  });

  app.get(`${basePath}/:agent_name/status`, async (c) => {
    const mount = c.get("mount") as AgentMount;
    const health = await mount.persistence.checkHealth();
    return c.json({
      ok: health.ok,
      state: health.ok ? "ready" : "error",
      pid: null,
      startedAt,
      updatedAt: Date.now(),
    });
  });

  app.post(`${basePath}/:agent_name/tools/call/:tool_name`, async (c) => {
    const mount = c.get("mount") as AgentMount;
    const { transport } = mount;
    const toolNameFromPath = c.req.param("tool_name") ?? "";

    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        body = raw as Record<string, unknown>;
      }
    } catch {
      // empty body is fine
    }

    if (body.jsonrpc === "2.0" && typeof body.method === "string") {
      return handleBridgePayload(transport, body);
    }

    const resolvedToolName =
      toolNameFromPath ||
      (typeof body.name === "string" ? body.name : "");
    if (!resolvedToolName) {
      return c.json({ error: "tool name is required" }, 400);
    }

    const toolArguments = typeof body.arguments === "object"
      ? body.arguments
      : body;
    const acceptHeader = c.req.header("accept") ?? "";
    const toolArgsRecord = isRecord(toolArguments) ? toolArguments : {};
    const streamRequestedByArgs = toolArgsRecord.stream === true;
    const wantsStream = resolvedToolName === "agent.run" ||
      acceptHeader.includes("text/event-stream") ||
      streamRequestedByArgs;
    const resolvedArguments = wantsStream && resolvedToolName === "agent.run"
      ? { stream: true, ...(toolArguments as Record<string, unknown> ?? {}) }
      : toolArguments ?? {};
    const publicBaseUrl = resolvePublicBaseUrl(
      c.req.url,
      basePath,
      c.req.param("agent_name") ?? "",
    );
    const argsWithHttpMarker = withHttpTransportArguments(
      resolvedToolName,
      resolvedArguments,
      publicBaseUrl,
    );

    const jsonRpcPayload = {
      jsonrpc: "2.0" as const,
      id: `mcp-tool-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      method: "tools/call" as const,
      params: {
        name: resolvedToolName,
        arguments: argsWithHttpMarker,
      },
    };

    if (!wantsStream) {
      try {
        const response = await transport.request(
          jsonRpcPayload as unknown as JSONRPCMessage,
        );
        return c.json(response, 200, {
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        });
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : String(error ?? "error");
        return c.json({ error: message }, 500);
      }
    }

    return handleBridgePayload(transport, jsonRpcPayload);
  });

  app.get(basePath, (c) => {
    const agents = definitions.map((definition) => ({
      name: definition.mountName,
      description: definition.description,
    }));
    return c.json({ agents });
  });

  return mounts;
}

class InProcessMcpTransport implements Transport, McpInProcessTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly subscribers = new Set<NotificationListener>();

  async start(): Promise<void> {
    // no-op
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const msg = message as Record<string, unknown>;
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pending.get(msg.id as string | number);
      if (pending) {
        this.pending.delete(msg.id as string | number);
        pending.resolve(message);
      }
      return;
    }

    for (const listener of this.subscribers) {
      try {
        listener(message);
      } catch {
        // ignore subscriber exceptions
      }
    }
  }

  async close(): Promise<void> {
    for (const [, pending] of this.pending) {
      pending.reject(new Error("transport closed"));
    }
    this.pending.clear();
    this.subscribers.clear();
    this.onclose?.();
  }

  request(message: JSONRPCMessage): Promise<JSONRPCMessage> {
    return new Promise<JSONRPCMessage>((resolve, reject) => {
      const msg = message as Record<string, unknown>;
      if (msg.id !== undefined) {
        this.pending.set(msg.id as string | number, { resolve, reject });
      }
      try {
        this.onmessage?.(message);
      } catch (error) {
        if (msg.id !== undefined) {
          this.pending.delete(msg.id as string | number);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }

  subscribe(listener: NotificationListener): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  async init(): Promise<void> {
    const initResponse = await this.request({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { logging: {} },
        clientInfo: { name: "ai-kit-hono", version: "0.1.0" },
      },
    } as unknown as JSONRPCMessage);

    const response = initResponse as Record<string, unknown>;
    if (response.error) {
      throw new Error(
        `MCP initialize failed: ${JSON.stringify(response.error)}`,
      );
    }

    this.notify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    } as unknown as JSONRPCMessage);
  }
}

function normalizeAgentGroups(
  options: MountMcpRoutesOptions,
): AgentGroupDefinition[] {
  if (options.agentGroups && options.agentGroups.length > 0) {
    return options.agentGroups;
  }
  return (options.agentDefinitions ?? []).map((definition) => ({
    mountName: definition.name,
    description: definition.description,
    defaultAgentId: definition.name,
    agents: [
      {
        agentId: definition.name,
        description: definition.description,
        create: definition.create,
      },
    ],
  }));
}

async function initAgentMounts(
  definitions: AgentGroupDefinition[],
  dataDir: string,
  basePath: string,
  onMountCreated?: (mount: AgentMount) => Promise<void> | void,
): Promise<Map<string, AgentMount>> {
  const mounts = new Map<string, AgentMount>();

  for (const definition of definitions) {
    const storage = new FileSystemStorage(`${dataDir}/${definition.mountName}`);
    const persistence = new JsonlMcpPersistence(storage);
    const registry = new AgentRegistry({
      agents: definition.agents.map((agent) => ({
        agentId: agent.agentId,
        description: agent.description,
        create: agent.create,
      })),
      defaultAgentId: definition.defaultAgentId,
    });

    const mcpServer = buildMcpServer({
      serverName: definition.mountName,
      persistence,
      agentRegistry: registry,
      publicAssetsDir: `${dataDir}/${definition.mountName}/public`,
      publicAssetsBasePath: `${basePath.replace(/\/+$/, "")}/${definition.mountName}/public`,
    });

    const transport = new InProcessMcpTransport();
    const mount: AgentMount = {
      definition: {
        mountName: definition.mountName,
        description: definition.description,
      },
      mcpServer,
      persistence,
      registry,
      transport,
    };

    if (onMountCreated) {
      await onMountCreated(mount);
    }

    await mcpServer.connect(transport);
    await transport.init();

    mounts.set(definition.mountName, mount);
  }

  return mounts;
}

function handleBridgePayload(
  transport: McpInProcessTransport,
  payload: Record<string, unknown>,
): Promise<Response> | Response {
  if (isNotification(payload)) {
    transport.notify(payload as unknown as JSONRPCMessage);
    return new Response(null, {
      status: 202,
      headers: { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION },
    });
  }

  if (!isRequest(payload)) {
    transport.notify(payload as unknown as JSONRPCMessage);
    return new Response(null, {
      status: 202,
      headers: { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION },
    });
  }

  return sseResponseFromRequest(transport, payload);
}

function sseResponseFromRequest(
  transport: McpInProcessTransport,
  message: Record<string, unknown>,
): Response {
  const notificationToken = extractNotificationToken(message);
  let streamClosed = false;
  let unsubscribe: (() => void) | null = null;
  let requestId: string | number | null = null;
  if (typeof message.id === "string" || typeof message.id === "number") {
    requestId = message.id;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => {
        if (streamClosed) return;
        controller.enqueue(encoder.encode(formatSse(payload)));
      };

      unsubscribe = transport.subscribe((incoming) => {
        const incomingRecord = incoming as unknown as Record<string, unknown>;
        if (shouldForwardNotification(incomingRecord, notificationToken)) {
          send(incoming);
        }
      });

      const finalize = () => {
        if (streamClosed) return;
        streamClosed = true;
        unsubscribe?.();
        unsubscribe = null;
        controller.close();
      };

      transport.request(message as unknown as JSONRPCMessage)
        .then((response) => {
          send(response);
          finalize();
        })
        .catch((error) => {
          send({
            jsonrpc: "2.0",
            id: message.id ?? null,
            error: {
              code: -32000,
              message: error instanceof Error
                ? error.message
                : String(error ?? "error"),
            },
          });
          finalize();
        });
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
      streamClosed = true;
      if (requestId === null) {
        return;
      }
      // Propagate HTTP/SSE disconnect to the underlying MCP request so tool
      // handlers can observe extra.signal.aborted and stop long-running work.
      transport.notify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: {
          requestId,
          reason: "client disconnected",
        },
      } as unknown as JSONRPCMessage);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    },
  });
}

function formatSse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotification(message: Record<string, unknown>): boolean {
  return message.method !== undefined && message.id === undefined;
}

function isRequest(message: Record<string, unknown>): boolean {
  return message.method !== undefined && message.id !== undefined;
}

function extractNotificationToken(message: Record<string, unknown>): string | null {
  if (message.method !== "tools/call") return null;
  const params = message.params;
  if (!isRecord(params)) return null;
  const args = params.arguments;
  if (!isRecord(args)) return null;
  const token = args.notification_token ?? args.notificationToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function withHttpTransportToolCallMarker(
  message: Record<string, unknown>,
  publicBaseUrl?: string,
): Record<string, unknown> {
  if (message.method !== "tools/call") {
    return message;
  }
  const params = isRecord(message.params) ? message.params : undefined;
  if (!params) {
    return message;
  }
  const toolName = typeof params.name === "string" ? params.name : "";
  return {
    ...message,
    params: {
      ...params,
      arguments: withHttpTransportArguments(toolName, params.arguments, publicBaseUrl),
    },
  };
}

function withHttpTransportArguments(
  toolName: string,
  args: unknown,
  publicBaseUrl?: string,
): unknown {
  if (toolName !== "conversations.get") {
    return args;
  }
  if (!isRecord(args)) {
    return { _httpTransport: true, _publicBaseUrl: publicBaseUrl };
  }
  return {
    ...args,
    _httpTransport: true,
    _publicBaseUrl: publicBaseUrl ?? args._publicBaseUrl,
  };
}

function resolvePublicBaseUrl(
  requestUrl: string,
  basePath: string,
  agentName: string,
): string | undefined {
  if (!agentName) {
    return undefined;
  }
  try {
    const parsed = new URL(requestUrl);
    return `${parsed.origin}${basePath.replace(/\/+$/, "")}/${agentName}/public`;
  } catch {
    return undefined;
  }
}

function resolvePublicAssetFilePath(
  dataDir: string,
  agentName: string,
  requestedPath: string,
): { ok: true; fullPath: string } | { ok: false; error: string } {
  if (requestedPath.includes("\0")) {
    return { ok: false, error: "invalid path" };
  }
  const normalized = path.posix.normalize(`/${requestedPath}`);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const resolvedSegments =
    segments[0] === "public" ? segments.slice(1) : segments;
  if (
    resolvedSegments.length === 0 ||
    resolvedSegments.some((segment) => segment === "." || segment === "..")
  ) {
    return { ok: false, error: "invalid path" };
  }

  // Always anchor under the mounted agent's public root to block traversal.
  const publicRoot = path.resolve(dataDir, agentName, "public");
  const fullPath = path.resolve(publicRoot, ...resolvedSegments);
  if (
    fullPath !== publicRoot &&
    !fullPath.startsWith(`${publicRoot}${path.sep}`)
  ) {
    return { ok: false, error: "invalid path" };
  }
  return { ok: true, fullPath };
}

function contentTypeFromPath(fullPath: string): string {
  const extension = path.extname(fullPath).toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function shouldForwardNotification(
  message: Record<string, unknown>,
  notificationToken: string | null,
): boolean {
  if (!isNotification(message)) return false;
  if (!notificationToken) return true;
  if (!isRecord(message.params)) return false;
  const token = message.params.notification_token ?? message.params.notificationToken;
  return typeof token === "string" && token === notificationToken;
}
