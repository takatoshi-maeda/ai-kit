import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createFakePostgresSql } from "../helpers/fake-postgres.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7G8AAAAASUVORK5CYII=",
  "base64",
);

describe("mountMcpRoutes with postgres persistence", () => {
  it("serves public assets from the filesystem storage", async () => {
    const fakeSql = createFakePostgresSql();

    vi.resetModules();
    vi.doMock("../../src/agent/postgres/client.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/agent/postgres/client.js")>(
        "../../src/agent/postgres/client.js",
      );
      return {
        ...actual,
        createPostgresClient: vi.fn(() => fakeSql),
      };
    });

    const { mountMcpRoutes } = await import("../../src/hono/index.js");
    const app = new Hono();
    const mounts = await mountMcpRoutes(app, {
      agentDefinitions: [
        {
          name: "alpha",
          create: () => null as never,
        },
      ],
      persistence: {
        kind: "postgres",
        connectionString: "postgresql://postgres:postgres@example.com:5432/postgres",
      },
    });

    const saved = await mounts.get("alpha")!.publicAssetStorage.saveImage({
      agentId: "alpha",
      sessionId: "session/1",
      mediaType: "image/png",
      bytes: ONE_PIXEL_PNG,
      now: new Date("2026-03-17T00:00:00.000Z"),
    });

    const response = await app.request(
      `/api/mcp/alpha/public/ref/${encodeURIComponent(saved.assetRef)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ONE_PIXEL_PNG);
  });
});
