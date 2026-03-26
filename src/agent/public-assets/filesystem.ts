import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  PublicAssetReadResult,
  PublicAssetResolution,
  PublicAssetStorage,
  SavePublicFileInput,
  SavePublicFileResult,
  SavePublicImageInput,
  SavePublicImageResult,
} from "./storage.js";

const IMAGE_MEDIA_TYPE_TO_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const IMAGE_EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export interface FileSystemPublicAssetStorageOptions {
  appName: string;
  publicDir: string;
}

export class FileSystemPublicAssetStorage implements PublicAssetStorage {
  private readonly appName: string;
  private readonly publicDir: string;

  constructor(options: FileSystemPublicAssetStorageOptions) {
    this.appName = options.appName;
    this.publicDir = path.resolve(options.publicDir);
  }

  async saveImage(input: SavePublicImageInput): Promise<SavePublicImageResult> {
    const mediaType = normalizeMediaType(input.mediaType);
    const extension = IMAGE_MEDIA_TYPE_TO_EXTENSION[mediaType];
    if (!extension) {
      throw new Error(`unsupported image mediaType: ${mediaType}`);
    }
    return this.saveBytes({
      sessionId: input.sessionId,
      extension,
      bytes: input.bytes,
      now: input.now,
    });
  }

  async saveFile(input: SavePublicFileInput): Promise<SavePublicFileResult> {
    const mimeType = normalizeMediaType(input.mimeType);
    const extension = inferFileExtension(mimeType, input.fileName);
    return this.saveBytes({
      sessionId: input.sessionId,
      extension,
      bytes: input.bytes,
      now: input.now,
    });
  }

  async resolveForLlm(input: { assetRef: string }): Promise<PublicAssetResolution> {
    const asset = await this.readPublicAsset(input.assetRef);
    if (!asset) {
      throw new Error(`public asset not found for ref: ${input.assetRef}`);
    }
    return {
      mode: "data-url",
      dataUrl: `data:${asset.contentType};base64,${Buffer.from(asset.bytes).toString("base64")}`,
    };
  }

  async readPublicAsset(assetRef: string): Promise<PublicAssetReadResult | null> {
    const relativePath = fromFileSystemAssetRef(assetRef, this.appName);
    if (!relativePath) {
      return null;
    }
    const fullPath = resolveSafePublicAssetFilePath(this.publicDir, relativePath);
    try {
      const bytes = await fs.readFile(fullPath);
      return {
        bytes,
        contentType: contentTypeFromPath(fullPath),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async saveBytes(input: {
    sessionId: string;
    extension: string;
    bytes: Uint8Array;
    now?: Date;
  }): Promise<SavePublicImageResult | SavePublicFileResult> {
    const now = input.now ?? new Date();
    const relativePath = [
      "uploads",
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
      toSafePathSegment(input.sessionId),
      `${crypto.randomUUID()}.${input.extension}`,
    ].join("/");
    const fullPath = resolveSafePublicAssetFilePath(this.publicDir, relativePath);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, input.bytes);

    return {
      storagePath: `${this.appName}/public/${relativePath}`,
      assetRef: toFileSystemAssetRef(this.appName, relativePath),
    };
  }
}

export function toFileSystemAssetRef(appName: string, relativePath: string): string {
  const segments = [appName, "public", ...relativePath.split("/")]
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment));
  return `storage+file:///${segments.join("/")}`;
}

export function fromFileSystemAssetRef(
  assetRef: string,
  expectedAppName?: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(assetRef);
  } catch {
    return null;
  }
  if (parsed.protocol !== "storage+file:") {
    return null;
  }
  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
  if (segments.length < 3) {
    return null;
  }
  if (expectedAppName && segments[0] !== expectedAppName) {
    return null;
  }
  if (segments[1] !== "public") {
    return null;
  }
  const relativePath = segments.slice(2).join("/");
  return relativePath.length > 0 ? relativePath : null;
}

function resolveSafePublicAssetFilePath(publicDir: string, relativePath: string): string {
  const normalized = path.posix.normalize(`/${relativePath}`);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("invalid public asset path");
  }

  const root = path.resolve(publicDir);
  const fullPath = path.resolve(root, ...segments);
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error("public asset path escapes public directory");
  }
  return fullPath;
}

function contentTypeFromPath(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (IMAGE_EXTENSION_TO_MEDIA_TYPE[extension]) {
    return IMAGE_EXTENSION_TO_MEDIA_TYPE[extension];
  }
  if (extension === "txt") return "text/plain";
  if (extension === "md") return "text/markdown";
  if (extension === "pdf") return "application/pdf";
  return "application/octet-stream";
}

function normalizeMediaType(mediaType: string): string {
  return mediaType.trim().toLowerCase().split(";")[0] ?? "";
}

function toSafePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "session";
}

function inferFileExtension(mimeType: string, fileName: string): string {
  const explicit = path.extname(fileName).slice(1).toLowerCase();
  if (/^[a-z0-9]+$/.test(explicit)) {
    return explicit;
  }
  if (mimeType === "text/plain") return "txt";
  if (mimeType === "text/markdown") return "md";
  if (mimeType === "application/pdf") return "pdf";
  return "bin";
}
