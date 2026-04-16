import { buildMcpServer } from "../agent/mcp/server.js";
import { AgentRegistry } from "../agent/mcp/agent-registry.js";
import type { McpPersistence } from "../agent/mcp/persistence.js";
import {
  AuthError,
  type AuthBackend,
  createAuthBackend,
  getRequestRuntimeScope,
  runWithRequestRuntimeScope,
  type AuthBackendOptions,
  type RequestRuntimeScope,
} from "../auth/index.js";
import {
  createPersistenceBundleResolver,
  type PersistenceBundleResolver,
  type PersistenceBackendOptions,
} from "../agent/persistence/factory.js";
import { toFileSystemAssetRef } from "../agent/public-assets/filesystem.js";
import type { PublicAssetStorage } from "../agent/public-assets/storage.js";
import { resolveAiKitOptions } from "../config/resolver.js";
import type { AgentContext } from "../types/agent.js";
import type { ConversationalAgent } from "../agent/conversational.js";
import type { AgentSkillsOptions } from "../types/agent.js";
import type { AgentRuntimePolicy, ResolvedAgentRuntime } from "../types/runtime.js";
import { mountSpeechRoutes } from "./speech.js";
import type { MountSpeechRoutesOptions } from "../speech/types.js";
import {
  createSpeechClient,
  createSpeechService,
  startSpeechWorker,
} from "../speech/index.js";
import type {
  CreateSpeechClientOptions,
  CreateSpeechServiceOptions,
  SpeechWorkerHandle,
  StartSpeechWorkerOptions,
} from "../speech/types.js";
import type { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const encoder = new TextEncoder();
const MCP_PROTOCOL_VERSION = "2025-06-18";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export type NotificationListener = (message: JSONRPCMessage) => void;

interface PendingRequest {
  resolve: (response: JSONRPCMessage) => void;
  reject: (error: Error) => void;
}

interface NormalizedAgentGroupDefinition extends AgentGroupDefinitionFields {
  appName: string;
  mountName: string;
}

export interface AgentDefinition {
  name: string;
  description?: string;
  create: (
    context: AgentContext,
    params?: Record<string, unknown>,
    runtime?: ResolvedAgentRuntime,
  ) => ConversationalAgent;
  runtimePolicy?: AgentRuntimePolicy;
  skills?: AgentSkillsOptions;
}

export interface AgentGroupAgentDefinition {
  agentId: string;
  description?: string;
  create: AgentDefinition["create"];
  runtimePolicy?: AgentRuntimePolicy;
  skills?: AgentSkillsOptions;
}

interface AgentGroupDefinitionFields {
  description?: string;
  agents: AgentGroupAgentDefinition[];
  defaultAgentId?: string;
}

export interface AppGroupDefinition extends AgentGroupDefinitionFields {
  appName: string;
  /** @deprecated Use appName. */
  mountName?: string;
}

/** @deprecated Use AppGroupDefinition. */
export type AgentGroupDefinition =
  | AppGroupDefinition
  | (AgentGroupDefinitionFields & {
    /** @deprecated Use appName. */
    mountName: string;
    appName?: string;
  });

export interface AppMountDefinition {
  appName: string;
  /** @deprecated Use appName. */
  mountName: string;
  description?: string;
}

/** @deprecated Use AppMountDefinition. */
export type AgentMountDefinition = AppMountDefinition;

export interface AgentMount {
  definition: AppMountDefinition;
  mcpServer: SdkMcpServer;
  persistence: McpPersistence;
  publicAssetStorage: PublicAssetStorage;
  publicAssetsDir?: string;
  registry: AgentRegistry;
  transport: McpInProcessTransport;
  runtimeResolver: PersistenceBundleResolver;
  auth: AuthBackendOptions;
  authBackend: AuthBackend;
}

export interface MountMcpRoutesOptions {
  agentDefinitions?: AgentDefinition[];
  agentGroups?: Array<AppGroupDefinition | AgentGroupDefinition>;
  dataDir?: string;
  basePath?: string;
  persistence?: PersistenceBackendOptions;
  auth?: AuthBackendOptions;
  configFile?: string | false;
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

export { mountSpeechRoutes } from "./speech.js";
export type { MountSpeechRoutesOptions } from "../speech/types.js";

export interface MountAiKitSpeechOptions extends
  CreateSpeechClientOptions,
  Pick<CreateSpeechServiceOptions, "dataDir" | "maxFileBytes" | "allowedMimeTypes">,
  Omit<MountSpeechRoutesOptions, "service"> {
  worker?: boolean | Omit<StartSpeechWorkerOptions, "service">;
}

export interface MountAiKitRoutesOptions extends MountMcpRoutesOptions {
  speech?: MountAiKitSpeechOptions;
}

export interface MountAiKitRoutesResult {
  mounts: Map<string, AgentMount>;
  speechWorker?: SpeechWorkerHandle;
}

export async function mountAiKitRoutes(
  app: MountableHonoApp,
  options: MountAiKitRoutesOptions,
): Promise<MountAiKitRoutesResult> {
  const mounts = await mountMcpRoutes(app, options);
  let speechWorker: SpeechWorkerHandle | undefined;

  if (options.speech) {
    const speechService = createSpeechService({
      client: createSpeechClient(options.speech),
      dataDir: options.speech.dataDir,
      maxFileBytes: options.speech.maxFileBytes,
      allowedMimeTypes: options.speech.allowedMimeTypes,
    });
    await mountSpeechRoutes(app, {
      service: speechService,
      basePath: options.speech.basePath,
      auth: options.speech.auth,
    });
    if (options.speech.worker !== false) {
      speechWorker = startSpeechWorker({
        service: speechService,
        intervalMs: typeof options.speech.worker === "object"
          ? options.speech.worker.intervalMs
          : undefined,
      });
    }
  }

  return { mounts, speechWorker };
}

export async function mountMcpRoutes(
  app: MountableHonoApp,
  options: MountMcpRoutesOptions,
): Promise<Map<string, AgentMount>> {
  const resolvedOptions = await resolveAiKitOptions(options);
  const basePath = resolvedOptions.basePath ?? "/api/mcp";
  const definitions = normalizeAgentGroups(resolvedOptions);
  const mounts = await initAgentMounts(
    definitions,
    resolvedOptions,
    basePath,
    resolvedOptions.onMountCreated,
  );
  const startedAt = Date.now();

  app.use(`${basePath}/:app_name/*`, async (c, next) => {
    const mount = mounts.get(resolveAppNameParam(c));
    if (!mount) {
      return c.json({ error: "agent not found" }, 404);
    }
    c.set("mount", mount);
    await next();
  });

  app.use(`${basePath}/:app_name`, async (c, next) => {
    const mount = mounts.get(resolveAppNameParam(c));
    if (!mount) {
      return c.json({ error: "agent not found" }, 404);
    }
    c.set("mount", mount);
    await next();
  });

  app.get(`${basePath}/:app_name/public/*`, async (c) => {
    const appName = resolveAppNameParam(c);
    const mount = mounts.get(appName);
    const routePrefix = `${basePath.replace(/\/+$/, "")}/${appName}/public/`;
    const requested = c.req.path.startsWith(routePrefix)
      ? c.req.path.slice(routePrefix.length)
      : "";
    if (!appName || !mount || requested.length === 0) {
      return c.json({ error: "not found" }, 404);
    }

    const assetRef = resolveRequestedPublicAssetRef(appName, requested);
    if (!assetRef) {
      return c.json({ error: "not found" }, 404);
    }

    return withMountRequestScope(mount, c.req.raw.headers, async () => {
      const scope = getRequiredRequestScope();
      const asset = await readPublicAssetResponse(scope.publicAssetStorage, assetRef);
      if (!asset) {
        return c.json({ error: "not found" }, 404);
      }
      if ("redirectUrl" in asset) {
        return Response.redirect(asset.redirectUrl, 302);
      }

      return new Response(new Uint8Array(asset.bytes), {
        status: 200,
        headers: {
          "Content-Type": asset.contentType,
          "Cache-Control": IMMUTABLE_CACHE_CONTROL,
        },
      });
    });
  });

  app.post(`${basePath}/:app_name`, async (c) => {
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
    const appName = resolveAppNameParam(c);
    const publicBaseUrl = resolvePublicBaseUrl(c.req.url, basePath, appName);
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

    return withMountRequestScope(
      mount,
      c.req.raw.headers,
      () => sseResponseFromRequest(transport, requestWithHttpMarker),
    );
  });

  app.get(`${basePath}/:app_name/status`, async (c) => {
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

  app.post(`${basePath}/:app_name/tools/call/:tool_name`, async (c) => {
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
      return withMountRequestScope(
        mount,
        c.req.raw.headers,
        () => handleBridgePayload(transport, body),
      );
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
      resolveAppNameParam(c),
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

    return withMountRequestScope(mount, c.req.raw.headers, async () => {
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
  });

  app.get(basePath, (c) => {
    const apps = definitions.map((definition) => ({
      appName: definition.appName,
      name: definition.appName,
      description: definition.description,
    }));
    return c.json({
      apps,
      agents: apps.map(({ name, description }) => ({ name, description })),
    });
  });

  return mounts;
}

async function withMountRequestScope<T>(
  mount: AgentMount,
  headers: Headers,
  callback: () => Promise<T> | T,
): Promise<T | Response> {
  try {
    const auth = await mount.authBackend.authenticateRequest({ headers });
    const bundle = await mount.runtimeResolver.getBundle({ userId: auth.userId });
    return await runWithRequestRuntimeScope({
      auth,
      persistence: bundle.persistence,
      publicAssetStorage: bundle.publicAssetStorage,
      publicAssetsDir: bundle.publicAssetsDir,
    }, async () => await callback());
  } catch (error) {
    if (error instanceof AuthError) {
      logAuthFailure(mount, headers, error);
      return new Response(
        JSON.stringify({ error: error.message }),
        {
          status: error.status,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": error.wwwAuthenticate,
          },
        },
      );
    }
    throw error;
  }
}

function logAuthFailure(
  mount: AgentMount,
  headers: Headers,
  error: AuthError,
): void {
  const authorization = headers.get("authorization");
  const hasBearerToken = typeof authorization === "string" && /^Bearer\s+\S+/i.test(authorization);
  const authScheme = typeof authorization === "string"
    ? authorization.split(/\s+/, 1)[0] ?? "unknown"
    : "missing";
  console.error("[ai-kit] authentication failed", {
    appName: mount.definition.appName,
    authBackend: mount.auth.kind,
    hasAuthorizationHeader: typeof authorization === "string" && authorization.length > 0,
    hasBearerToken,
    authScheme,
    status: error.status,
    message: error.message,
    wwwAuthenticate: error.wwwAuthenticate,
  });
}

function getRequiredRequestScope(): RequestRuntimeScope {
  const scope = getRequestRuntimeScope();
  if (!scope) {
    throw new Error("request runtime scope is not available");
  }
  return scope;
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
): NormalizedAgentGroupDefinition[] {
  if (options.agentGroups && options.agentGroups.length > 0) {
    return options.agentGroups.map(normalizeAgentGroupDefinition);
  }
  return (options.agentDefinitions ?? []).map((definition) => ({
    appName: definition.name,
    mountName: definition.name,
    description: definition.description,
    defaultAgentId: definition.name,
    agents: [
      {
        agentId: definition.name,
        description: definition.description,
        create: definition.create,
        runtimePolicy: definition.runtimePolicy,
        skills: definition.skills,
      },
    ],
  }));
}

async function initAgentMounts(
  definitions: NormalizedAgentGroupDefinition[],
  options: MountMcpRoutesOptions,
  basePath: string,
  onMountCreated?: (mount: AgentMount) => Promise<void> | void,
): Promise<Map<string, AgentMount>> {
  const mounts = new Map<string, AgentMount>();

  for (const definition of definitions) {
    const auth = options.auth ?? { kind: "none" };
    const authBackend = createAuthBackend(auth);
    const runtimeResolver = await createPersistenceBundleResolver(definition.appName, {
      persistence: options.persistence ?? { kind: "filesystem", dataDir: "data" },
    });
    const bundle = await runtimeResolver.getBundle({ userId: "anonymous" });
    const persistence = bundle.persistence;
    const registry = new AgentRegistry({
      agents: definition.agents.map((agent) => ({
        agentId: agent.agentId,
        description: agent.description,
        create: agent.create,
        runtimePolicy: agent.runtimePolicy,
        skills: agent.skills,
      })),
      defaultAgentId: definition.defaultAgentId,
    });

    const mcpServer = buildMcpServer({
      serverName: definition.appName,
      appName: definition.appName,
      persistence,
      agentRegistry: registry,
      publicAssetStorage: bundle.publicAssetStorage,
      publicAssetsDir: bundle.publicAssetsDir,
      publicAssetsBasePath: `${basePath.replace(/\/+$/, "")}/${definition.appName}/public`,
    });

    const transport = new InProcessMcpTransport();
    const mount: AgentMount = {
      definition: {
        appName: definition.appName,
        mountName: definition.mountName,
        description: definition.description,
      },
      mcpServer,
      persistence,
      publicAssetStorage: bundle.publicAssetStorage,
      publicAssetsDir: bundle.publicAssetsDir,
      registry,
      transport,
      runtimeResolver,
      auth,
      authBackend,
    };

    if (onMountCreated) {
      await onMountCreated(mount);
    }

    await mcpServer.connect(transport);
    await transport.init();

    mounts.set(definition.appName, mount);
  }

  return mounts;
}

function normalizeAgentGroupDefinition(
  definition: AppGroupDefinition | AgentGroupDefinition,
): NormalizedAgentGroupDefinition {
  const appName = resolveAppName(definition);
  return {
    ...definition,
    appName,
    mountName: appName,
  };
}

function resolveAppName(
  definition: { appName?: string; mountName?: string },
): string {
  const appName = definition.appName ?? definition.mountName;
  if (!appName) {
    throw new Error("Agent group definition requires appName");
  }
  return appName;
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
      "X-Accel-Buffering": "no",
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
  appName: string,
): string | undefined {
  if (!appName) {
    return undefined;
  }
  try {
    const parsed = new URL(requestUrl);
    return `${parsed.origin}${basePath.replace(/\/+$/, "")}/${appName}/public`;
  } catch {
    return undefined;
  }
}

function resolveAppNameParam(
  context: { req: { param(name: string): string | undefined } },
): string {
  return context.req.param("app_name") ?? "";
}

function resolveRequestedPublicAssetRef(
  appName: string,
  requestedPath: string,
): string | null {
  const normalizedPath = requestedPath.replace(/^\/+/, "");
  if (normalizedPath.length === 0) {
    return null;
  }
  if (normalizedPath.startsWith("ref/")) {
    try {
      const decoded = decodeURIComponent(normalizedPath.slice(4));
      return decoded.length > 0 ? decoded : null;
    } catch {
      return null;
    }
  }
  return toFileSystemAssetRef(appName, normalizedPath);
}

async function readPublicAssetResponse(
  publicAssetStorage: PublicAssetStorage,
  assetRef: string,
): Promise<
  | { bytes: Uint8Array; contentType: string }
  | { redirectUrl: string }
  | null
> {
  if (publicAssetStorage.readPublicAsset) {
    const asset = await publicAssetStorage.readPublicAsset(assetRef);
    if (asset) {
      return asset;
    }
  }

  const resolved = await publicAssetStorage.resolveForLlm({ assetRef });
  if (resolved.mode === "url") {
    return { redirectUrl: resolved.url };
  }
  return parseDataUrlAsset(resolved.dataUrl);
}

function parseDataUrlAsset(
  dataUrl: string,
): { bytes: Uint8Array; contentType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) {
    return null;
  }
  return {
    bytes: Uint8Array.from(Buffer.from(match[2], "base64")),
    contentType: match[1],
  };
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
