import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createFakeSupabaseClient } from "../helpers/fake-supabase.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7G8AAAAASUVORK5CYII=",
  "base64",
);

describe("mountMcpRoutes with supabase persistence", () => {
  it("serves public assets by redirecting to a signed URL", async () => {
    const fakeClient = createFakeSupabaseClient();

    vi.resetModules();
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: vi.fn(() => fakeClient),
    }));

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
        kind: "supabase",
        url: "https://example.supabase.co",
        serviceRoleKey: "service-role-key",
        bucket: "ai-kit",
        signedUrlExpiresInSeconds: 45,
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
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://example.supabase.test/storage/v1/object/sign/ai-kit/${encodeURIComponent(saved.storagePath)}?expiresIn=45`,
    );

    vi.doUnmock("@supabase/supabase-js");
  });
});
