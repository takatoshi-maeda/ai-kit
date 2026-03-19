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
  migrationStatus: DoctorCheckResult[];
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
    `${tablePrefix}versions`,
    `${tablePrefix}conversations`,
    `${tablePrefix}conversation_events`,
    `${tablePrefix}conversation_run_states`,
    `${tablePrefix}input_history`,
    `${tablePrefix}usage_entries`,
    `${tablePrefix}idempotency_records`,
  ];
}

function requiredPersistenceTableColumns(
  tablePrefix: string,
): Array<{ table: string; columns: string[] }> {
  return [
    {
      table: `${tablePrefix}versions`,
      columns: [
        "version",
        "applied_at",
      ],
    },
    {
      table: `${tablePrefix}conversations`,
      columns: [
        "id",
        "app_name",
        "user_id",
        "agent_id",
        "agent_name",
        "session_id",
        "agent_scope",
        "title",
        "created_at",
        "updated_at",
      ],
    },
    {
      table: `${tablePrefix}conversation_events`,
      columns: [
        "id",
        "conversation_id",
        "event_type",
        "event_timestamp",
        "data",
        "created_at",
      ],
    },
    {
      table: `${tablePrefix}conversation_run_states`,
      columns: [
        "conversation_id",
        "run_id",
        "turn_id",
        "status",
        "started_at",
        "updated_at",
        "user_message",
        "user_content",
        "assistant_message",
        "timeline",
        "agent_id",
        "agent_name",
        "created_at",
      ],
    },
    {
      table: `${tablePrefix}input_history`,
      columns: [
        "id",
        "app_name",
        "user_id",
        "agent_id",
        "agent_name",
        "session_id",
        "entry",
        "run_id",
        "created_at",
      ],
    },
    {
      table: `${tablePrefix}usage_entries`,
      columns: [
        "id",
        "app_name",
        "user_id",
        "agent_id",
        "agent_name",
        "session_id",
        "amount",
        "currency",
        "run_id",
        "created_at",
      ],
    },
    {
      table: `${tablePrefix}idempotency_records`,
      columns: [
        "id",
        "app_name",
        "user_id",
        "agent_id",
        "session_id",
        "idempotency_key",
        "run_id",
        "status",
        "result",
        "created_at",
      ],
    },
  ];
}

export function formatDoctorReport(report: DoctorReport, asJson = false): string {
  if (asJson) {
    return JSON.stringify(report, null, 2);
  }

  const color = createTerminalColorizer();
  const lines = [
    `${color.bold("Backend:")} ${report.backend}`,
    `${color.bold("Status:")} ${report.ok ? color.ok("ok") : color.error("error")}`,
    color.bold("Config:"),
    ...Object.entries(report.config).map(([key, value]) => `  ${key}: ${String(value)}`),
    color.bold("Checks:"),
    ...report.checks.map((check) =>
      `  ${check.ok ? color.ok("[ok]") : color.error("[error]")} ${check.name}: ${check.detail}`
    ),
    color.bold("MigrationStatus:"),
    ...report.migrationStatus.map((check) =>
      `  ${check.ok ? color.ok("[ok]") : color.error("[error]")} ${check.name}: ${check.detail}`
    ),
  ];
  return lines.join("\n");
}

function createTerminalColorizer(): {
  bold: (value: string) => string;
  ok: (value: string) => string;
  error: (value: string) => string;
} {
  if (!shouldUseTerminalColors()) {
    return {
      bold: (value) => value,
      ok: (value) => value,
      error: (value) => value,
    };
  }

  const wrap = (code: string) => (value: string) => `\u001B[${code}m${value}\u001B[0m`;
  return {
    bold: wrap("1"),
    ok: wrap("32"),
    error: wrap("31"),
  };
}

function shouldUseTerminalColors(): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return process.env.FORCE_COLOR !== "0";
  }
  return Boolean(process.stdout?.isTTY);
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
  const versionsTable = qualifiedTable(config.schema, `${config.tablePrefix}versions`);
  try {
    await sql.unsafe(buildMigrationBootstrapSql(config.schema, config.tablePrefix));
    const appliedRows = await sql.unsafe<{ version: string }>(
      `select version from ${versionsTable} order by version asc`,
    );
    const appliedVersions = new Set(
      appliedRows
        .map((row) => row.version)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    for (const migration of buildPersistenceMigrations(config.schema, config.tablePrefix)) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      await sql.unsafe(migration.statements.join("\n\n"));
      await sql.unsafe(
        `insert into ${versionsTable} (version, applied_at) values ($1, now())`,
        [migration.version],
      );
    }
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
): Promise<{ checks: DoctorCheckResult[]; migrationStatus: DoctorCheckResult[] }> {
  const checks: DoctorCheckResult[] = [];
  const migrationStatus: DoctorCheckResult[] = [];
  const persistenceClient = createSupabaseBackendClient({
    url: config.url,
    serviceRoleKey: config.serviceRoleKey,
    schema: config.schema,
  });
  const versionsTable = `${config.tablePrefix}versions`;
  let appliedVersions = new Set<string>();

  try {
    const { data, error } = await persistenceClient
      .from<{ version: string }>(versionsTable)
      .select("version")
      .order("version", { ascending: true });
    if (error) {
      throw new Error(error.message);
    }
    appliedVersions = new Set(
      (Array.isArray(data) ? data : data ? [data] : [])
        .map((row) => row.version)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
  } catch (error) {
    migrationStatus.push({
      name: `migrations:${config.schema}.${versionsTable}`,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  for (const { table, columns } of requiredPersistenceTableColumns(config.tablePrefix)) {
    try {
      const { error } = await persistenceClient
        .from(table)
        .select(columns.join(","))
        .limit(1);
      if (error) {
        throw new Error(error.message);
      }
      checks.push({
        name: `table:${config.schema}.${table}`,
        ok: true,
        detail: "required columns ok",
      });
    } catch (error) {
      checks.push({
        name: `table:${config.schema}.${table}`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const migration of buildPersistenceMigrations(config.schema, config.tablePrefix)) {
    migrationStatus.push({
      name: migration.version,
      ok: appliedVersions.has(migration.version),
      detail: appliedVersions.has(migration.version) ? "applied" : "pending",
    });
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

  return { checks, migrationStatus };
}

export async function inspectPostgresResources(
  config: ResolvedPostgresCliConfig,
): Promise<{ checks: DoctorCheckResult[]; migrationStatus: DoctorCheckResult[] }> {
  const checks: DoctorCheckResult[] = [];
  const migrationStatus: DoctorCheckResult[] = [];
  const sql = createPostgresClient({ connectionString: config.connectionString });
  let appliedVersions = new Set<string>();
  try {
    await sql.unsafe("select 1");
    checks.push({
      name: "connectivity",
      ok: true,
      detail: "query ok",
    });
    try {
      const rows = await sql.unsafe<{ version: string }>(
        `select version from ${qualifiedTable(config.schema, `${config.tablePrefix}versions`)} order by version asc`,
      );
      appliedVersions = new Set(
        rows
          .map((row) => row.version)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      );
    } catch (error) {
      migrationStatus.push({
        name: `migrations:${config.schema}.${config.tablePrefix}versions`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    for (const { table, columns } of requiredPersistenceTableColumns(config.tablePrefix)) {
      try {
        await sql.unsafe(
          `select ${columns.join(", ")} from ${qualifiedTable(config.schema, table)} limit 1`,
        );
        checks.push({
          name: `table:${config.schema}.${table}`,
          ok: true,
          detail: "required columns ok",
        });
      } catch (error) {
        checks.push({
          name: `table:${config.schema}.${table}`,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const migration of buildPersistenceMigrations(config.schema, config.tablePrefix)) {
      migrationStatus.push({
        name: migration.version,
        ok: appliedVersions.has(migration.version),
        detail: appliedVersions.has(migration.version) ? "applied" : "pending",
      });
    }
  } catch (error) {
    checks.push({
      name: "connectivity",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
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

  return { checks, migrationStatus };
}

export function buildSupabaseSetupSql(config: ResolvedSupabaseCliConfig): string {
  return [
    buildVersionedPersistenceSetupSql(config.schema, config.tablePrefix),
    buildSupabaseStorageSetupSql(config.bucket),
  ].join("\n\n");
}

export function buildPostgresSetupSql(config: ResolvedPostgresCliConfig): string {
  return [
    buildMigrationBootstrapSql(config.schema, config.tablePrefix),
    ...buildPersistenceMigrations(config.schema, config.tablePrefix).map((migration) =>
      [
        `-- migration:${migration.version}`,
        ...migration.statements,
        `insert into ${qualifiedTable(config.schema, `${config.tablePrefix}versions`)} (version, applied_at)`,
        `values (${quoteLiteral(migration.version)}, now())`,
        `on conflict (version) do nothing;`,
      ].join("\n")
    ),
  ].join("\n\n");
}

function buildVersionedPersistenceSetupSql(schema: string, tablePrefix: string): string {
  return [
    buildMigrationBootstrapSql(schema, tablePrefix),
    ...buildPersistenceMigrations(schema, tablePrefix).map((migration) =>
      buildVersionedMigrationSql(schema, tablePrefix, migration.version, migration.statements)
    ),
  ].join("\n\n");
}

function buildMigrationBootstrapSql(schema: string, tablePrefix: string): string {
  const schemaName = quoteIdentifier(schema);
  const versions = qualifiedTable(schema, `${tablePrefix}versions`);
  return [
    `create schema if not exists ${schemaName};`,
    "",
    `create table if not exists ${versions} (`,
    "  version text primary key,",
    "  applied_at timestamptz not null",
    ");",
  ].join("\n");
}

function buildVersionedMigrationSql(
  schema: string,
  tablePrefix: string,
  version: string,
  statements: string[],
): string {
  const versions = qualifiedTable(schema, `${tablePrefix}versions`);
  return [
    "do $$",
    "begin",
    `  if not exists (select 1 from ${versions} where version = ${quoteLiteral(version)}) then`,
    ...statements.map((statement) => statement.split("\n").map((line) => `    ${line}`).join("\n")),
    `    insert into ${versions} (version, applied_at) values (${quoteLiteral(version)}, now());`,
    "  end if;",
    "end $$;",
  ].join("\n");
}

function buildPersistenceMigrations(
  schema: string,
  tablePrefix: string,
): Array<{ version: string; statements: string[] }> {
  return [
    {
      version: "20260317000000",
      statements: buildInitialPersistenceMigrationStatements(schema, tablePrefix),
    },
    {
      version: "20260318000000",
      statements: buildUserIdMigrationStatements(schema, tablePrefix),
    },
    {
      version: "20260319000000",
      statements: buildRunStateSnapshotMigrationStatements(schema, tablePrefix),
    },
  ];
}

function buildInitialPersistenceMigrationStatements(schema: string, tablePrefix: string): string[] {
  const schemaName = quoteIdentifier(schema);
  const conversations = qualifiedTable(schema, `${tablePrefix}conversations`);
  const events = qualifiedTable(schema, `${tablePrefix}conversation_events`);
  const inputHistory = qualifiedTable(schema, `${tablePrefix}input_history`);
  const usageEntries = qualifiedTable(schema, `${tablePrefix}usage_entries`);
  const idempotency = qualifiedTable(schema, `${tablePrefix}idempotency_records`);
  return [[
    `create schema if not exists ${schemaName};`,
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
  ].join("\n")];
}

function buildUserIdMigrationStatements(schema: string, tablePrefix: string): string[] {
  const conversations = qualifiedTable(schema, `${tablePrefix}conversations`);
  const inputHistory = qualifiedTable(schema, `${tablePrefix}input_history`);
  const usageEntries = qualifiedTable(schema, `${tablePrefix}usage_entries`);
  const idempotency = qualifiedTable(schema, `${tablePrefix}idempotency_records`);
  const conversationsLegacyConstraint = quoteIdentifier(
    `${tablePrefix}conversations_app_name_session_id_agent_scope_key`,
  );
  const idempotencyLegacyConstraint = quoteIdentifier(
    `${tablePrefix}idempotency_records_app_name_idempotency_key_key`,
  );

  return [
    `alter table ${conversations} add column if not exists user_id text;`,
    `update ${conversations} set user_id = 'anonymous' where user_id is null;`,
    `alter table ${conversations} alter column user_id set not null;`,
    `alter table ${conversations} drop constraint if exists ${conversationsLegacyConstraint};`,
    `drop index if exists ${qualifiedTable(schema, `${tablePrefix}conversations_app_updated_idx`)};`,
    `create unique index if not exists ${quoteIdentifier(`${tablePrefix}conversations_identity_idx`)}`,
    `  on ${conversations} (app_name, user_id, session_id, agent_scope);`,
    `create index if not exists ${quoteIdentifier(`${tablePrefix}conversations_app_updated_idx`)}`,
    `  on ${conversations} (app_name, user_id, updated_at desc);`,

    `alter table ${inputHistory} add column if not exists user_id text;`,
    `update ${inputHistory} set user_id = 'anonymous' where user_id is null;`,
    `alter table ${inputHistory} alter column user_id set not null;`,
    `drop index if exists ${qualifiedTable(schema, `${tablePrefix}input_history_app_created_idx`)};`,
    `create index if not exists ${quoteIdentifier(`${tablePrefix}input_history_app_created_idx`)}`,
    `  on ${inputHistory} (app_name, user_id, created_at desc);`,

    `alter table ${usageEntries} add column if not exists user_id text;`,
    `update ${usageEntries} set user_id = 'anonymous' where user_id is null;`,
    `alter table ${usageEntries} alter column user_id set not null;`,
    `drop index if exists ${qualifiedTable(schema, `${tablePrefix}usage_entries_app_created_idx`)};`,
    `create index if not exists ${quoteIdentifier(`${tablePrefix}usage_entries_app_created_idx`)}`,
    `  on ${usageEntries} (app_name, user_id, created_at desc);`,

    `alter table ${idempotency} add column if not exists user_id text;`,
    `update ${idempotency} set user_id = 'anonymous' where user_id is null;`,
    `alter table ${idempotency} alter column user_id set not null;`,
    `alter table ${idempotency} drop constraint if exists ${idempotencyLegacyConstraint};`,
    `create unique index if not exists ${quoteIdentifier(`${tablePrefix}idempotency_identity_idx`)}`,
    `  on ${idempotency} (app_name, user_id, idempotency_key);`,
  ];
}

function buildRunStateSnapshotMigrationStatements(schema: string, tablePrefix: string): string[] {
  const conversations = qualifiedTable(schema, `${tablePrefix}conversations`);
  const runStates = qualifiedTable(schema, `${tablePrefix}conversation_run_states`);
  return [
    `create table if not exists ${runStates} (`,
    "  conversation_id bigint not null,",
    "  run_id text not null,",
    "  turn_id text null,",
    "  status text not null,",
    "  started_at timestamptz not null,",
    "  updated_at timestamptz not null,",
    "  user_message text null,",
    "  user_content jsonb null,",
    "  assistant_message text null,",
    "  timeline jsonb null,",
    "  agent_id text null,",
    "  agent_name text null,",
    "  created_at timestamptz not null,",
    `  primary key (conversation_id, run_id),`,
    `  foreign key (conversation_id) references ${conversations} (id) on delete cascade`,
    ");",
    `create index if not exists ${quoteIdentifier(`${tablePrefix}conversation_run_states_conversation_updated_idx`)}`,
    `  on ${runStates} (conversation_id, updated_at desc);`,
  ];
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
