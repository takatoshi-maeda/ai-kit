import path from "node:path";
import { FileSystemStorage } from "../../storage/fs.js";
import { FileSystemPublicAssetStorage } from "../public-assets/filesystem.js";
import { SupabasePublicAssetStorage } from "../public-assets/supabase.js";
import type { PublicAssetStorage } from "../public-assets/storage.js";
import { FilesystemPersistence } from "./filesystem.js";
import { PostgresPersistence } from "./postgres.js";
import { SupabasePersistence } from "./supabase.js";
import type { AgentPersistence } from "./types.js";
import { createPostgresClient, type PostgresSqlLike } from "../postgres/client.js";
import {
  createSupabaseBackendClient,
  type SupabaseClientLike,
} from "../supabase/client.js";

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
  publicAssetsDir?: string;
}

export interface PersistenceScope {
  userId?: string;
}

export interface CreatePersistenceBundleOptions {
  persistence: PersistenceBackendOptions;
  scope?: PersistenceScope;
}

export interface PersistenceBundleResolver {
  getBundle(scope?: PersistenceScope): Promise<PersistenceBundle>;
}

export async function createPersistenceBundle(
  appName: string,
  options: CreatePersistenceBundleOptions,
): Promise<PersistenceBundle> {
  const resolver = await createPersistenceBundleResolver(appName, options);
  return resolver.getBundle(options.scope);
}

export async function createPersistenceBundleResolver(
  appName: string,
  options: CreatePersistenceBundleOptions,
): Promise<PersistenceBundleResolver> {
  switch (options.persistence.kind) {
    case "filesystem":
      return createFilesystemBundleResolver(appName, options.persistence);
    case "supabase":
      return createSupabaseBundleResolver(appName, options.persistence);
    case "postgres":
      return createPostgresBundleResolver(appName, options.persistence);
    default:
      return assertNever(options.persistence);
  }
}

async function createFilesystemBundleResolver(
  appName: string,
  options: FileSystemBackend,
): Promise<PersistenceBundleResolver> {
  const cache = new Map<string, PersistenceBundle>();
  return {
    async getBundle(scope?: PersistenceScope): Promise<PersistenceBundle> {
      const userId = normalizeUserId(scope?.userId);
      const cached = cache.get(userId);
      if (cached) {
        return cached;
      }
      const rootDir = path.resolve(
        options.dataDir ?? "data",
        appName,
        "users",
        toSafeUserPath(userId),
      );
      const publicAssetsDir = path.join(rootDir, "public");
      const bundle: PersistenceBundle = {
        persistence: new FilesystemPersistence(new FileSystemStorage(rootDir)),
        publicAssetStorage: new FileSystemPublicAssetStorage({
          appName,
          publicDir: publicAssetsDir,
        }),
        publicAssetsDir,
      };
      cache.set(userId, bundle);
      return bundle;
    },
  };
}

async function createSupabaseBundleResolver(
  appName: string,
  options: SupabaseBackend,
): Promise<PersistenceBundleResolver> {
  const client = createSupabaseBackendClient({
    url: options.url,
    serviceRoleKey: options.serviceRoleKey,
    schema: options.schema,
  });
  return createSupabaseBundleResolverWithClient(appName, options, client);
}

function createSupabaseBundleResolverWithClient(
  appName: string,
  options: SupabaseBackend,
  client: SupabaseClientLike,
): PersistenceBundleResolver {
  const cache = new Map<string, PersistenceBundle>();
  return {
    async getBundle(scope?: PersistenceScope): Promise<PersistenceBundle> {
      const userId = normalizeUserId(scope?.userId);
      const cached = cache.get(userId);
      if (cached) {
        return cached;
      }
      const bundle: PersistenceBundle = {
        persistence: new SupabasePersistence({
          appName,
          userId,
          tablePrefix: options.tablePrefix,
          client,
        }),
        publicAssetStorage: new SupabasePublicAssetStorage({
          appName,
          bucket: options.bucket,
          signedUrlExpiresInSeconds: options.signedUrlExpiresInSeconds,
          objectKeyPrefix: `users/${toSafeUserPath(userId)}`,
          client,
        }),
      };
      cache.set(userId, bundle);
      return bundle;
    },
  };
}

async function createPostgresBundleResolver(
  appName: string,
  options: PostgresBackend,
): Promise<PersistenceBundleResolver> {
  const sql = createPostgresClient({
    connectionString: options.connectionString,
  });
  return createPostgresBundleResolverWithClient(appName, options, sql);
}

function createPostgresBundleResolverWithClient(
  appName: string,
  options: PostgresBackend,
  sql: PostgresSqlLike,
): PersistenceBundleResolver {
  const cache = new Map<string, PersistenceBundle>();
  return {
    async getBundle(scope?: PersistenceScope): Promise<PersistenceBundle> {
      const userId = normalizeUserId(scope?.userId);
      const cached = cache.get(userId);
      if (cached) {
        return cached;
      }
      const rootDir = path.resolve(
        options.assetDataDir ?? "data",
        appName,
        "users",
        toSafeUserPath(userId),
      );
      const publicAssetsDir = path.join(rootDir, "public");
      const bundle: PersistenceBundle = {
        persistence: new PostgresPersistence({
          appName,
          userId,
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
      cache.set(userId, bundle);
      return bundle;
    },
  };
}

function normalizeUserId(value: string | undefined): string {
  return typeof value === "string" && value.length > 0
    ? value
    : "anonymous";
}

function toSafeUserPath(value: string): string {
  return encodeURIComponent(value);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported persistence backend: ${JSON.stringify(value)}`);
}
