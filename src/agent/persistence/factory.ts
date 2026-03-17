import path from "node:path";
import { FileSystemStorage } from "../../storage/fs.js";
import { FileSystemPublicAssetStorage } from "../public-assets/filesystem.js";
import { SupabasePublicAssetStorage } from "../public-assets/supabase.js";
import type { PublicAssetStorage } from "../public-assets/storage.js";
import { FilesystemPersistence } from "./filesystem.js";
import { PostgresPersistence } from "./postgres.js";
import { SupabasePersistence } from "./supabase.js";
import type { AgentPersistence } from "./types.js";
import { createPostgresClient } from "../postgres/client.js";
import { createSupabaseBackendClient } from "../supabase/client.js";

export interface FileSystemBackend {
  kind: "filesystem";
  dataDir?: string;
}

export interface SupabaseBackend {
  kind: "supabase";
  url: string;
  serviceRoleKey: string;
  schema?: string;
  tablePrefix?: string;
  bucket?: string;
  signedUrlExpiresInSeconds?: number;
}

export interface PostgresBackend {
  kind: "postgres";
  connectionString: string;
  schema?: string;
  tablePrefix?: string;
  assetDataDir?: string;
}

export type PersistenceBackendOptions =
  | FileSystemBackend
  | SupabaseBackend
  | PostgresBackend;

export interface PersistenceBundle {
  persistence: AgentPersistence;
  publicAssetStorage: PublicAssetStorage;
  /**
   * Compatibility bridge for pre-Phase 3 filesystem-based HTTP public asset
   * serving. Future backends can leave this undefined.
   */
  publicAssetsDir?: string;
}

export interface CreatePersistenceBundleOptions {
  persistence: PersistenceBackendOptions;
}

export async function createPersistenceBundle(
  appName: string,
  options: CreatePersistenceBundleOptions,
): Promise<PersistenceBundle> {
  switch (options.persistence.kind) {
    case "filesystem":
      return createFilesystemPersistenceBundle(appName, options.persistence);
    case "supabase":
      return createSupabasePersistenceBundle(appName, options.persistence);
    case "postgres":
      return createPostgresPersistenceBundle(appName, options.persistence);
    default:
      return assertNever(options.persistence);
  }
}

function createFilesystemPersistenceBundle(
  appName: string,
  options: FileSystemBackend,
): PersistenceBundle {
  const rootDir = path.resolve(options.dataDir ?? "data", appName);
  const publicAssetsDir = path.join(rootDir, "public");

  return {
    persistence: new FilesystemPersistence(new FileSystemStorage(rootDir)),
    publicAssetStorage: new FileSystemPublicAssetStorage({
      appName,
      publicDir: publicAssetsDir,
    }),
    publicAssetsDir,
  };
}

function createSupabasePersistenceBundle(
  appName: string,
  options: SupabaseBackend,
): PersistenceBundle {
  const client = createSupabaseBackendClient({
    url: options.url,
    serviceRoleKey: options.serviceRoleKey,
    schema: options.schema,
  });

  return {
    persistence: new SupabasePersistence({
      appName,
      tablePrefix: options.tablePrefix,
      client,
    }),
    publicAssetStorage: new SupabasePublicAssetStorage({
      appName,
      bucket: options.bucket,
      signedUrlExpiresInSeconds: options.signedUrlExpiresInSeconds,
      client,
    }),
  };
}

function createPostgresPersistenceBundle(
  appName: string,
  options: PostgresBackend,
): PersistenceBundle {
  const rootDir = path.resolve(options.assetDataDir ?? "data", appName);
  const publicAssetsDir = path.join(rootDir, "public");
  const sql = createPostgresClient({
    connectionString: options.connectionString,
  });

  return {
    persistence: new PostgresPersistence({
      appName,
      schema: options.schema,
      tablePrefix: options.tablePrefix,
      sql,
    }),
    publicAssetStorage: new FileSystemPublicAssetStorage({
      appName,
      publicDir: publicAssetsDir,
    }),
    publicAssetsDir,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported persistence backend: ${JSON.stringify(value)}`);
}
