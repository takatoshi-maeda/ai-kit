import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  FileSystemPublicAssetStorage,
  fromFileSystemAssetRef,
} from "../../../src/agent/public-assets/filesystem.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7G8AAAAASUVORK5CYII=",
  "base64",
);

describe("FileSystemPublicAssetStorage", () => {
  it("saves, resolves, and reads filesystem-backed public assets", async () => {
    const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-kit-public-"));
    const storage = new FileSystemPublicAssetStorage({
      appName: "chat-app",
      publicDir,
    });

    const saved = await storage.saveImage({
      sessionId: "session/1",
      mediaType: "image/png",
      bytes: ONE_PIXEL_PNG,
      now: new Date("2026-03-17T00:00:00.000Z"),
    });

    expect(saved.storagePath).toMatch(/^chat-app\/public\/uploads\/2026\/03\/17\/session_1\/.+\.png$/);
    expect(saved.assetRef).toMatch(/^storage\+file:\/\/\/chat-app\/public\/uploads\/2026\/03\/17\/session_1\/.+\.png$/);
    expect(fromFileSystemAssetRef(saved.assetRef, "chat-app")).toMatch(
      /^uploads\/2026\/03\/17\/session_1\/.+\.png$/,
    );

    const asset = await storage.readPublicAsset(saved.assetRef);
    expect(asset).not.toBeNull();
    expect(asset?.contentType).toBe("image/png");
    expect(Buffer.from(asset?.bytes ?? []).equals(ONE_PIXEL_PNG)).toBe(true);

    const resolved = await storage.resolveForLlm({ assetRef: saved.assetRef });
    expect(resolved.mode).toBe("data-url");
    if (resolved.mode === "data-url") {
      expect(resolved.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    }
  });

  it("saves generic files and preserves their content type", async () => {
    const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-kit-public-file-"));
    const storage = new FileSystemPublicAssetStorage({
      appName: "chat-app",
      publicDir,
    });

    const saved = await storage.saveFile({
      sessionId: "session/2",
      mimeType: "application/pdf",
      fileName: "requirements.pdf",
      bytes: Buffer.from("%PDF-1.4"),
      now: new Date("2026-03-17T00:00:00.000Z"),
    });

    expect(saved.storagePath).toMatch(/^chat-app\/public\/uploads\/2026\/03\/17\/session_2\/.+\.pdf$/);
    const asset = await storage.readPublicAsset(saved.assetRef);
    expect(asset?.contentType).toBe("application/pdf");
  });
});
