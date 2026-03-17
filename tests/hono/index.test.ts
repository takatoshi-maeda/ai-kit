import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mountMcpRoutes } from "../../src/hono/index.js";
import type {
  AgentDefinition,
  MountableHonoApp,
} from "../../src/hono/index.js";

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
});
