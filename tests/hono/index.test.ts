import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { mountMcpRoutes } from "../../src/hono/index.js";
import type {
  AgentDefinition,
  MountableHonoApp,
} from "../../src/hono/index.js";
import {
  FileSystemPublicAssetStorage,
  fromFileSystemAssetRef,
} from "../../src/agent/public-assets/filesystem.js";

function createStubApp(): MountableHonoApp {
  return {
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
  };
}

function createAgentDefinitions(): AgentDefinition[] {
  return [
    {
      name: "alpha",
      create: () => null as never,
    },
  ];
}

describe("mountMcpRoutes", () => {
  it("uses persistence from ai-kit.config when no explicit override is provided", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-hono-"));
    const configuredDataDir = path.join(cwd, "config-data");
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    await writeFile(
      configPath,
      `export default { persistence: { kind: "filesystem", dataDir: ${JSON.stringify(configuredDataDir)} } };`,
      "utf8",
    );

    const mounts = await mountMcpRoutes(createStubApp(), {
      agentDefinitions: createAgentDefinitions(),
      configFile: configPath,
    });

    await mounts.get("alpha")?.persistence.appendConversationTurn("session-1", {
      turnId: "turn-1",
      runId: "run-1",
      timestamp: "2026-03-17T00:00:00.000Z",
      userMessage: "Hello",
      assistantMessage: "Hi",
      status: "success",
    });

    const stored = await readFile(
      path.join(configuredDataDir, "alpha", "conversations", "session-1.jsonl"),
      "utf8",
    );
    expect(stored).toContain('"type":"turn"');
  });

  it("prefers explicit persistence over ai-kit.config", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-kit-hono-"));
    const configuredDataDir = path.join(cwd, "config-data");
    const overrideDataDir = path.join(cwd, "override-data");
    const configPath = path.join(cwd, "ai-kit.config.mjs");
    await writeFile(
      configPath,
      `export default { persistence: { kind: "filesystem", dataDir: ${JSON.stringify(configuredDataDir)} } };`,
      "utf8",
    );

    const mounts = await mountMcpRoutes(createStubApp(), {
      agentDefinitions: createAgentDefinitions(),
      configFile: configPath,
      persistence: {
        kind: "filesystem",
        dataDir: overrideDataDir,
      },
    });

    await mounts.get("alpha")?.persistence.appendConversationTurn("session-2", {
      turnId: "turn-1",
      runId: "run-1",
      timestamp: "2026-03-17T00:00:00.000Z",
      userMessage: "Hello",
      assistantMessage: "Hi",
      status: "success",
    });

    const stored = await readFile(
      path.join(overrideDataDir, "alpha", "conversations", "session-2.jsonl"),
      "utf8",
    );
    expect(stored).toContain('"type":"turn"');
  });

  it("serves filesystem-backed public assets via /public/*", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ai-kit-hono-public-"));
    const publicAssetStorage = new FileSystemPublicAssetStorage({
      appName: "alpha",
      publicDir: path.join(dataDir, "alpha", "public"),
    });
    const saved = await publicAssetStorage.saveImage({
      sessionId: "session/1",
      mediaType: "image/png",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7G8AAAAASUVORK5CYII=",
        "base64",
      ),
      now: new Date("2026-03-17T00:00:00.000Z"),
    });
    const relativePath = fromFileSystemAssetRef(saved.assetRef, "alpha");

    const app = new Hono();
    await mountMcpRoutes(app, {
      agentDefinitions: createAgentDefinitions(),
      persistence: {
        kind: "filesystem",
        dataDir,
      },
    });

    const response = await app.request(`/api/mcp/alpha/public/${relativePath}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer()).length).toBeGreaterThan(0);
  });
});
