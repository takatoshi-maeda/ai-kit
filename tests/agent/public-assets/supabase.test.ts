import { describe, expect, it } from "vitest";
import {
  SupabasePublicAssetStorage,
  fromSupabaseAssetRef,
} from "../../../src/agent/public-assets/supabase.js";
import { createFakeSupabaseClient } from "../../helpers/fake-supabase.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7G8AAAAASUVORK5CYII=",
  "base64",
);

describe("SupabasePublicAssetStorage", () => {
  it("saves images under app/agent-scoped object keys and resolves signed URLs", async () => {
    const client = createFakeSupabaseClient();
    const storage = new SupabasePublicAssetStorage({
      appName: "chat",
      bucket: "ai-kit",
      signedUrlExpiresInSeconds: 123,
      client,
    });

    const saved = await storage.saveImage({
      agentId: "support-agent",
      sessionId: "session/1",
      mediaType: "image/png",
      bytes: ONE_PIXEL_PNG,
      now: new Date("2026-03-17T00:00:00.000Z"),
    });

    expect(saved.storagePath).toMatch(
      /^chat\/support-agent\/uploads\/2026\/03\/17\/session_1\/.+\.png$/,
    );
    expect(saved.assetRef).toMatch(
      /^storage\+supabase:\/\/ai-kit\/chat\/support-agent\/uploads\/2026\/03\/17\/session_1\/.+\.png$/,
    );

    const parsed = fromSupabaseAssetRef(saved.assetRef, "ai-kit");
    expect(parsed).not.toBeNull();
    expect(parsed?.objectKey).toBe(saved.storagePath);

    const storedObject = client.storageObject("ai-kit", saved.storagePath);
    expect(storedObject).not.toBeNull();
    expect(Buffer.from(storedObject?.bytes ?? []).equals(ONE_PIXEL_PNG)).toBe(true);

    const resolved = await storage.resolveForLlm({ assetRef: saved.assetRef });
    expect(resolved).toEqual({
      mode: "url",
      url: `https://example.supabase.test/storage/v1/object/sign/ai-kit/${encodeURIComponent(saved.storagePath)}?expiresIn=123`,
    });
  });

  it("saves generic files with inferred extensions", async () => {
    const client = createFakeSupabaseClient();
    const storage = new SupabasePublicAssetStorage({
      appName: "chat",
      bucket: "ai-kit",
      client,
    });

    const saved = await storage.saveFile({
      agentId: "support-agent",
      sessionId: "session/2",
      mimeType: "text/markdown",
      fileName: "notes.md",
      bytes: Buffer.from("# Notes"),
      now: new Date("2026-03-17T00:00:00.000Z"),
    });

    expect(saved.storagePath).toMatch(
      /^chat\/support-agent\/uploads\/2026\/03\/17\/session_2\/.+\.md$/,
    );
    const storedObject = client.storageObject("ai-kit", saved.storagePath);
    expect(storedObject?.contentType).toBe("text/markdown");
  });
});
