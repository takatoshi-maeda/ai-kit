import {
  createSupabaseBackendClient,
  formatSupabaseError,
  type SupabaseClientLike,
} from "../supabase/client.js";
import type {
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

export interface SupabasePublicAssetStorageOptions {
  appName: string;
  objectKeyPrefix?: string;
  bucket?: string;
  signedUrlExpiresInSeconds?: number;
  url?: string;
  serviceRoleKey?: string;
  schema?: string;
  client?: SupabaseClientLike;
}

export class SupabasePublicAssetStorage implements PublicAssetStorage {
  private readonly client: SupabaseClientLike;
  private readonly appName: string;
  private readonly objectKeyPrefix: string;
  private readonly bucket: string;
  private readonly signedUrlExpiresInSeconds: number;

  constructor(options: SupabasePublicAssetStorageOptions) {
    this.appName = options.appName;
    this.objectKeyPrefix = options.objectKeyPrefix
      ? options.objectKeyPrefix.replace(/\/+$/, "")
      : "";
    this.bucket = options.bucket ?? "ai-kit";
    this.signedUrlExpiresInSeconds = options.signedUrlExpiresInSeconds ?? 60;
    this.client = options.client ?? createSupabaseBackendClient({
      url: requiredOption(options.url, "url"),
      serviceRoleKey: requiredOption(options.serviceRoleKey, "serviceRoleKey"),
      schema: options.schema,
    });
  }

  async saveImage(input: SavePublicImageInput): Promise<SavePublicImageResult> {
    const mediaType = normalizeMediaType(input.mediaType);
    const extension = IMAGE_MEDIA_TYPE_TO_EXTENSION[mediaType];
    if (!extension) {
      throw new Error(`unsupported image mediaType: ${mediaType}`);
    }

    return this.saveBytes({
      sessionId: input.sessionId,
      agentId: input.agentId,
      contentType: mediaType,
      extension,
      bytes: input.bytes,
      now: input.now,
    });
  }

  async saveFile(input: SavePublicFileInput): Promise<SavePublicFileResult> {
    return this.saveBytes({
      sessionId: input.sessionId,
      agentId: input.agentId,
      contentType: normalizeMediaType(input.mimeType),
      extension: inferFileExtension(input.mimeType, input.fileName),
      bytes: input.bytes,
      now: input.now,
    });
  }

  async resolveForLlm(input: { assetRef: string }): Promise<PublicAssetResolution> {
    const parsed = fromSupabaseAssetRef(input.assetRef, this.bucket);
    if (!parsed) {
      throw new Error(`invalid supabase asset ref: ${input.assetRef}`);
    }

    const { data, error } = await this.client.storage
      .from(parsed.bucket)
      .createSignedUrl(parsed.objectKey, this.signedUrlExpiresInSeconds);
    if (error) {
      throw new Error(formatSupabaseError(error));
    }
    if (!data?.signedUrl) {
      throw new Error(`failed to create signed URL for asset ref: ${input.assetRef}`);
    }

    return {
      mode: "url",
      url: data.signedUrl,
    };
  }

  private async saveBytes(input: {
    sessionId: string;
    agentId?: string;
    contentType: string;
    extension: string;
    bytes: Uint8Array;
    now?: Date;
  }): Promise<SavePublicImageResult | SavePublicFileResult> {
    const now = input.now ?? new Date();
    const agentId = input.agentId ?? this.appName;
    const objectKey = [
      ...(this.objectKeyPrefix ? [this.objectKeyPrefix] : []),
      this.appName,
      toSafePathSegment(agentId),
      "uploads",
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
      toSafePathSegment(input.sessionId),
      `${crypto.randomUUID()}.${input.extension}`,
    ].join("/");

    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(objectKey, input.bytes, {
        contentType: input.contentType,
        upsert: false,
      });
    if (error) {
      throw new Error(formatSupabaseError(error));
    }

    return {
      storagePath: objectKey,
      assetRef: toSupabaseAssetRef(this.bucket, objectKey),
    };
  }
}

export function toSupabaseAssetRef(bucket: string, objectKey: string): string {
  const normalizedBucket = bucket.trim();
  const segments = objectKey
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment));
  return `storage+supabase://${encodeURIComponent(normalizedBucket)}/${segments.join("/")}`;
}

export function fromSupabaseAssetRef(
  assetRef: string,
  expectedBucket?: string,
): { bucket: string; objectKey: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(assetRef);
  } catch {
    return null;
  }
  if (parsed.protocol !== "storage+supabase:") {
    return null;
  }

  const bucket = decodeURIComponent(parsed.hostname);
  if (!bucket || (expectedBucket && bucket !== expectedBucket)) {
    return null;
  }

  const objectKey = parsed.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment))
    .join("/");
  if (!objectKey) {
    return null;
  }

  return { bucket, objectKey };
}

function normalizeMediaType(mediaType: string): string {
  return mediaType.trim().toLowerCase().split(";")[0] ?? "";
}

function toSafePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "asset";
}

function requiredOption(value: string | undefined, name: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`Supabase public asset storage requires ${name}`);
}

function inferFileExtension(mimeType: string, fileName: string): string {
  const explicit = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (/^[a-z0-9]+$/.test(explicit)) {
    return explicit;
  }
  const normalized = normalizeMediaType(mimeType);
  if (normalized === "text/plain") return "txt";
  if (normalized === "text/markdown") return "md";
  if (normalized === "application/pdf") return "pdf";
  return "bin";
}
