import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPostgresClient } from "../agent/postgres/client.js";
import { PostgresPersistence } from "../agent/persistence/postgres.js";
import { createSupabaseBackendClient } from "../agent/supabase/client.js";
import { loadAiKitConfig } from "../config/loader.js";
import type {
  PersistenceBackendOptions,
  PostgresBackend,
  SupabaseBackend,
} from "../agent/persistence/factory.js";

const execFileAsync = promisify(execFile);
const DEFAULT_FILESYSTEM_DATA_DIR = "data";
const DEFAULT_SUPABASE_SCHEMA = "public";
const DEFAULT_SUPABASE_TABLE_PREFIX = "ai_kit_";
const DEFAULT_SUPABASE_BUCKET = "ai-kit";
let supabaseCommandRunner: { file: string; prefixArgs: string[] } | null = null;

export interface CliGlobalOptions {
  cwd?: string;
  configFile?: string | false;
  debug?: boolean;
}

export interface SetupCommandOptions extends CliGlobalOptions {
  schema?: string;
  tablePrefix?: string;
  bucket?: string;
  dbUrl?: string;
  local?: boolean;
}

export interface DoctorCommandOptions extends CliGlobalOptions {
  schema?: string;
  tablePrefix?: string;
  bucket?: string;
  json?: boolean;
}

export interface DoctorCheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  backend: PersistenceBackendOptions["kind"];
  config: Record<string, string | boolean | null>;
  checks: DoctorCheckResult[];
}

export interface ResolvedSupabaseCliConfig extends SupabaseBackend {
  schema: string;
  tablePrefix: string;
  bucket: string;
}

export interface ResolvedPostgresCliConfig extends PostgresBackend {
  schema: string;
  tablePrefix: string;
  assetDataDir: string;
}

export async function resolveCliPersistence(
  options: CliGlobalOptions,
): Promise<PersistenceBackendOptions> {
  const config = await loadAiKitConfig({
    cwd: options.cwd,
    configFile: options.configFile,
  });

  if (config?.persistence) {
    return { ...config.persistence };
  }

  return {
    kind: "filesystem",
    dataDir: DEFAULT_FILESYSTEM_DATA_DIR,
  };
}

export function resolveFilesystemDataDir(
  persistence: PersistenceBackendOptions,
  cwd?: string,
): string {
  if (persistence.kind !== "filesystem") {
    throw new Error(`Expected filesystem persistence, got "${persistence.kind}"`);
  }
  const baseDir = path.resolve(cwd ?? process.cwd());
  return path.resolve(baseDir, persistence.dataDir ?? DEFAULT_FILESYSTEM_DATA_DIR);
}

export function resolveSupabaseConfig(
  persistence: PersistenceBackendOptions,
  overrides: Pick<SetupCommandOptions, "schema" | "tablePrefix" | "bucket">,
): ResolvedSupabaseCliConfig {
  if (persistence.kind !== "supabase") {
    throw new Error(`Expected supabase persistence, got "${persistence.kind}"`);
  }

  return {
    ...persistence,
    schema: overrides.schema ?? persistence.schema ?? DEFAULT_SUPABASE_SCHEMA,
    tablePrefix: overrides.tablePrefix ?? persistence.tablePrefix ?? DEFAULT_SUPABASE_TABLE_PREFIX,
    bucket: overrides.bucket ?? persistence.bucket ?? DEFAULT_SUPABASE_BUCKET,
  };
}

export function resolvePostgresConfig(
  persistence: PersistenceBackendOptions,
  overrides: Pick<SetupCommandOptions, "schema" | "tablePrefix">,
  cwd?: string,
): ResolvedPostgresCliConfig {
  if (persistence.kind !== "postgres") {
    throw new Error(`Expected postgres persistence, got "${persistence.kind}"`);
  }

  const baseDir = path.resolve(cwd ?? process.cwd());
  return {
    ...persistence,
    schema: overrides.schema ?? persistence.schema ?? DEFAULT_SUPABASE_SCHEMA,
    tablePrefix: overrides.tablePrefix ?? persistence.tablePrefix ?? DEFAULT_SUPABASE_TABLE_PREFIX,
    assetDataDir: path.resolve(baseDir, persistence.assetDataDir ?? DEFAULT_FILESYSTEM_DATA_DIR),
  };
}

export function listSupabaseTables(config: ResolvedSupabaseCliConfig): string[] {
  return listPersistenceTables(config.tablePrefix);
}

export function listPostgresTables(config: ResolvedPostgresCliConfig): string[] {
  return listPersistenceTables(config.tablePrefix);
}

function listPersistenceTables(tablePrefix: string): string[] {
  return [
    `${tablePrefix}conversations`,
    `${tablePrefix}conversation_events`,
    `${tablePrefix}input_history`,
    `${tablePrefix}usage_entries`,
    `${tablePrefix}idempotency_records`,
  ];
}

export function formatDoctorReport(report: DoctorReport, asJson = false): string {
  if (asJson) {
    return JSON.stringify(report, null, 2);
  }

  const lines = [
    `Backend: ${report.backend}`,
    `Status: ${report.ok ? "ok" : "error"}`,
    "Config:",
    ...Object.entries(report.config).map(([key, value]) => `  ${key}: ${String(value)}`),
    "Checks:",
    ...report.checks.map((check) => `  [${check.ok ? "ok" : "error"}] ${check.name}: ${check.detail}`),
  ];
  return lines.join("\n");
}

export async function ensureDirectoryReady(targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const probeDir = path.join(targetDir, ".ai-kit-health");
  await mkdir(probeDir, { recursive: true });
  await rm(probeDir, { recursive: true, force: true });
}

export async function runSupabaseSetup(
  config: ResolvedSupabaseCliConfig,
  options: { cwd?: string; dbUrl?: string; local?: boolean; debug?: boolean },
): Promise<void> {
  await ensureSupabaseCliAvailable();
  if (typeof options.dbUrl === "string" && options.dbUrl.length > 0) {
    await runSupabaseSetupWithDbUrl(config, options.dbUrl, options.debug === true);
    return;
  }

  const projectDir = path.resolve(options.cwd ?? process.cwd());
  const migrationsDir = path.join(projectDir, "supabase", "migrations");
  const mode = options.local === true ? "local" : "linked";
  try {
    debugLog(options.debug === true, `${mode} setup projectDir=${projectDir}`);
    await logSupabaseProjectState(projectDir, options.debug === true);
    await mkdir(migrationsDir, { recursive: true });
    const migrationPath = path.join(migrationsDir, "20260317000000_ai_kit_setup.sql");
    await writeFile(migrationPath, buildSupabaseSetupSql(config), "utf8");
    debugLog(options.debug === true, `wrote migration ${migrationPath}`);
    await execSupabase(["db", "push", "--include-all", options.local === true ? "--local" : "--linked"], {
      cwd: projectDir,
      debug: options.debug,
    });
  } catch (error) {
    throw new Error(`Supabase setup failed: ${extractCommandError(error)}${await formatSupabaseSetupDiagnostics({
      debug: options.debug === true,
      mode,
      projectDir,
      migrationsDir,
    })}`);
  }
}

export async function runPostgresSetup(
  config: ResolvedPostgresCliConfig,
  options: { dbUrl?: string } = {},
): Promise<void> {
  const sql = createPostgresClient({
    connectionString: options.dbUrl ?? config.connectionString,
  });
  try {
    await sql.unsafe(buildPostgresSetupSql(config));
  } finally {
    await sql.end?.({ timeout: 0 });
  }
}

async function runSupabaseSetupWithDbUrl(
  config: ResolvedSupabaseCliConfig,
  dbUrl: string,
  debug: boolean,
): Promise<void> {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "ai-kit-supabase-setup-"));
  try {
    debugLog(debug, `db-url setup workdir=${workdir}`);
    await execSupabase(["--workdir", workdir, "init", "--force"], { debug });
    const migrationsDir = path.join(workdir, "supabase", "migrations");
    await mkdir(migrationsDir, { recursive: true });
    const migrationPath = path.join(migrationsDir, "20260317000000_ai_kit_setup.sql");
    await writeFile(migrationPath, buildSupabaseSetupSql(config), "utf8");
    debugLog(debug, `wrote migration ${migrationPath}`);
    await execSupabase(["--workdir", workdir, "db", "push", "--include-all", "--db-url", dbUrl], {
      debug,
    });
  } catch (error) {
    throw new Error(`Supabase setup failed: ${extractCommandError(error)}${await formatSupabaseSetupDiagnostics({
      debug,
      mode: "db-url",
      projectDir: workdir,
      migrationsDir: path.join(workdir, "supabase", "migrations"),
    })}`);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function inspectSupabaseResources(
  config: ResolvedSupabaseCliConfig,
): Promise<DoctorCheckResult[]> {
  const checks: DoctorCheckResult[] = [];
  const persistenceClient = createSupabaseBackendClient({
    url: config.url,
    serviceRoleKey: config.serviceRoleKey,
    schema: config.schema,
  });

  for (const table of listSupabaseTables(config)) {
    try {
      const { error } = await persistenceClient.from(table).select("*").limit(1);
      if (error) {
        throw new Error(error.message);
      }
      checks.push({
        name: `table:${config.schema}.${table}`,
        ok: true,
        detail: "reachable",
      });
    } catch (error) {
      checks.push({
        name: `table:${config.schema}.${table}`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const storageClient = createSupabaseBackendClient({
      url: config.url,
      serviceRoleKey: config.serviceRoleKey,
      schema: config.schema,
    });
    const { data, error } = await storageClient.storage.getBucket(config.bucket);
    if (error) {
      throw new Error(error.message);
    }
    if (!data) {
      throw new Error(`bucket "${config.bucket}" was not found`);
    }
    checks.push({
      name: `bucket:${config.bucket}`,
      ok: true,
      detail: "reachable",
    });
  } catch (error) {
    checks.push({
      name: `bucket:${config.bucket}`,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return checks;
}

export async function inspectPostgresResources(
  config: ResolvedPostgresCliConfig,
): Promise<DoctorCheckResult[]> {
  const checks: DoctorCheckResult[] = [];
  const backend = new PostgresPersistence({
    appName: "ai-kit-doctor",
    connectionString: config.connectionString,
    schema: config.schema,
    tablePrefix: config.tablePrefix,
  });
  try {
    const health = await backend.checkHealth();
    checks.push({
      name: "connectivity",
      ok: health.ok,
      detail: health.ok ? "query ok" : (health.error ?? "connectivity check failed"),
    });
  } finally {
    await backend.close();
  }

  const sql = createPostgresClient({ connectionString: config.connectionString });
  try {
    for (const table of listPostgresTables(config)) {
      try {
        await sql.unsafe(`select 1 from ${qualifiedTable(config.schema, table)} limit 1`);
        checks.push({
          name: `table:${config.schema}.${table}`,
          ok: true,
          detail: "reachable",
        });
      } catch (error) {
        checks.push({
          name: `table:${config.schema}.${table}`,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await sql.end?.({ timeout: 0 });
  }

  const assetDir = path.resolve(config.assetDataDir);
  try {
    await ensureDirectoryReady(assetDir);
    checks.push({
      name: `assetDir:${assetDir}`,
      ok: true,
      detail: "read/write ok",
    });
  } catch (error) {
    checks.push({
      name: `assetDir:${assetDir}`,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return checks;
}

export function buildSupabaseSetupSql(config: ResolvedSupabaseCliConfig): string {
  return [
    buildPersistenceSetupSql(config.schema, config.tablePrefix),
    buildSupabaseStorageSetupSql(config.bucket),
  ].join("\n\n");
}

export function buildPostgresSetupSql(config: ResolvedPostgresCliConfig): string {
  return buildPersistenceSetupSql(config.schema, config.tablePrefix);
}

function buildPersistenceSetupSql(schema: string, tablePrefix: string): string {
  const schemaName = quoteIdentifier(schema);
  const conversations = qualifiedTable(schema, `${tablePrefix}conversations`);
  const events = qualifiedTable(schema, `${tablePrefix}conversation_events`);
  const inputHistory = qualifiedTable(schema, `${tablePrefix}input_history`);
  const usageEntries = qualifiedTable(schema, `${tablePrefix}usage_entries`);
  const idempotency = qualifiedTable(schema, `${tablePrefix}idempotency_records`);

  return [
    `create schema if not exists ${schemaName};`,
    "",
    `create table if not exists ${conversations} (`,
    "  id bigint generated by default as identity primary key,",
    "  app_name text not null,",
    "  agent_id text null,",
    "  agent_name text null,",
    "  session_id text not null,",
    "  agent_scope text not null,",
    "  title text null,",
    "  created_at timestamptz not null,",
    "  updated_at timestamptz not null,",
    "  unique (app_name, session_id, agent_scope)",
    ");",
    `create index if not exists ${quoteIdentifier(`${tablePrefix}conversations_app_updated_idx`)}`,
    `  on ${conversations} (app_name, updated_at desc);`,
    "",
    `create table if not exists ${events} (`,
    "  id bigint generated by default as identity primary key,",
    `  conversation_id bigint not null references ${conversations} (id) on delete cascade,`,
    "  event_type text not null,",
    "  event_timestamp timestamptz not null,",
    "  data jsonb not null,",
    "  created_at timestamptz not null",
    ");",
    `create index if not exists ${quoteIdentifier(`${tablePrefix}conversation_events_conversation_idx`)}`,
    `  on ${events} (conversation_id, id);`,
    "",
    `create table if not exists ${inputHistory} (`,
    "  id bigint generated by default as identity primary key,",
    "  app_name text not null,",
    "  agent_id text null,",
    "  agent_name text null,",
    "  session_id text null,",
    "  entry text not null,",
    "  run_id text null,",
    "  created_at timestamptz not null",
    ");",
    `create index if not exists ${quoteIdentifier(`${tablePrefix}input_history_app_created_idx`)}`,
    `  on ${inputHistory} (app_name, created_at desc);`,
    "",
    `create table if not exists ${usageEntries} (`,
    "  id bigint generated by default as identity primary key,",
    "  app_name text not null,",
    "  agent_id text null,",
    "  agent_name text null,",
    "  session_id text null,",
    "  amount double precision not null,",
    "  currency text not null,",
    "  run_id text null,",
    "  created_at timestamptz not null",
    ");",
    `create index if not exists ${quoteIdentifier(`${tablePrefix}usage_entries_app_created_idx`)}`,
    `  on ${usageEntries} (app_name, created_at desc);`,
    "",
    `create table if not exists ${idempotency} (`,
    "  id bigint generated by default as identity primary key,",
    "  app_name text not null,",
    "  agent_id text null,",
    "  session_id text not null,",
    "  idempotency_key text not null,",
    "  run_id text not null,",
    "  status text not null,",
    "  result jsonb not null,",
    "  created_at timestamptz not null,",
    "  unique (app_name, idempotency_key)",
    ");",
  ].join("\n");
}

function buildSupabaseStorageSetupSql(bucket: string): string {
  const bucketLiteral = quoteLiteral(bucket);
  return [
    "create schema if not exists storage;",
    "insert into storage.buckets (id, name, public)",
    `select ${bucketLiteral}, ${bucketLiteral}, false`,
    `where not exists (select 1 from storage.buckets where id = ${bucketLiteral});`,
    "",
  ].join("\n");
}

async function ensureSupabaseCliAvailable(): Promise<void> {
  try {
    await execSupabase(["--version"]);
  } catch (error) {
    throw new Error(
      `Supabase CLI is required for setup: ${extractCommandError(error)}`,
    );
  }
}

async function execSupabase(
  args: string[],
  options: { cwd?: string; debug?: boolean } = {},
): Promise<void> {
  const runner = supabaseCommandRunner ?? await detectSupabaseCommandRunner();
  supabaseCommandRunner = runner;
  const finalArgs = [...runner.prefixArgs, ...args];
  debugLog(
    options.debug === true,
    `exec ${runner.file} ${finalArgs.map((value) => shellQuote(value)).join(" ")}${options.cwd ? ` (cwd=${options.cwd})` : ""}`,
  );
  try {
    const result = await execFileAsync(runner.file, finalArgs, {
      cwd: options.cwd,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    if ((result.stderr ?? "").trim().length > 0) {
      debugLog(options.debug === true, `stderr: ${(result.stderr ?? "").trim()}`);
    }
  } catch (error) {
    debugLog(options.debug === true, `command failed: ${extractCommandError(error)}`);
    throw error;
  }
}

async function detectSupabaseCommandRunner(): Promise<{ file: string; prefixArgs: string[] }> {
  try {
    await execFileAsync("supabase", ["--version"], {
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { file: "supabase", prefixArgs: [] };
  } catch (error) {
    if (!isCommandNotFoundError(error)) {
      throw error;
    }
  }

  await execFileAsync("npx", ["--yes", "supabase", "--version"], {
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { file: "npx", prefixArgs: ["--yes", "supabase"] };
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function qualifiedTable(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function extractCommandError(error: unknown): string {
  const asRecord = error as NodeJS.ErrnoException & {
    stdout?: string;
    stderr?: string;
    code?: string | number;
  };
  const stderr = asRecord.stderr?.trim();
  if (stderr) {
    return stderr;
  }
  if (typeof asRecord.code === "string" && asRecord.code.length > 0) {
    return asRecord.code;
  }
  return error instanceof Error ? error.message : String(error);
}

function isCommandNotFoundError(error: unknown): boolean {
  const asRecord = error as NodeJS.ErrnoException & { code?: string | number };
  return asRecord.code === "ENOENT";
}

async function logSupabaseProjectState(projectDir: string, debug: boolean): Promise<void> {
  if (!debug) {
    return;
  }
  const candidates = [
    path.join(projectDir, "supabase"),
    path.join(projectDir, "supabase", "config.toml"),
    path.join(projectDir, "supabase", ".temp"),
    path.join(projectDir, "supabase", ".temp", "project-ref"),
  ];
  for (const candidate of candidates) {
    debugLog(debug, `${candidate}: ${await pathState(candidate)}`);
  }
  const projectRefPath = path.join(projectDir, "supabase", ".temp", "project-ref");
  if (await fileExists(projectRefPath)) {
    const projectRef = (await readFile(projectRefPath, "utf8")).trim();
    debugLog(debug, `project-ref contents=${projectRef || "<empty>"}`);
  }
}

async function formatSupabaseSetupDiagnostics(input: {
  debug: boolean;
  mode: "linked" | "local" | "db-url";
  projectDir: string;
  migrationsDir: string;
}): Promise<string> {
  if (!input.debug) {
    return "";
  }
  const lines = [
    "",
    "",
    "[ai-kit debug]",
    `mode=${input.mode}`,
    `projectDir=${input.projectDir}`,
    `migrationsDir=${input.migrationsDir}`,
    `supabaseDir=${await pathState(path.join(input.projectDir, "supabase"))}`,
    `configToml=${await pathState(path.join(input.projectDir, "supabase", "config.toml"))}`,
    `projectRef=${await pathState(path.join(input.projectDir, "supabase", ".temp", "project-ref"))}`,
  ];
  return lines.join("\n");
}

async function pathState(targetPath: string): Promise<string> {
  try {
    await access(targetPath);
    return "present";
  } catch {
    return "missing";
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function debugLog(enabled: boolean, message: string): void {
  if (!enabled) {
    return;
  }
  process.stderr.write(`[ai-kit debug] ${message}\n`);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value)
    ? value
    : JSON.stringify(value);
}
