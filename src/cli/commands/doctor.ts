import { FileSystemStorage } from "../../storage/fs.js";
import { FilesystemPersistence } from "../../agent/persistence/filesystem.js";
import { SupabasePersistence } from "../../agent/persistence/supabase.js";
import type { DoctorCommandOptions, DoctorReport } from "../shared.js";
import {
  formatDoctorReport,
  inspectPostgresResources,
  inspectSupabaseResources,
  resolvePostgresConfig,
  resolveCliPersistence,
  resolveFilesystemDataDir,
  resolveSupabaseConfig,
} from "../shared.js";

export async function runDoctorCommand(options: DoctorCommandOptions): Promise<string> {
  const report = await collectDoctorReport(options);
  return formatDoctorReport(report, options.json === true);
}

export async function collectDoctorReport(options: DoctorCommandOptions): Promise<DoctorReport> {
  const persistence = await resolveCliPersistence(options);

  if (persistence.kind === "filesystem") {
    const targetDir = resolveFilesystemDataDir(persistence, options.cwd);
    const storage = new FileSystemStorage(targetDir);
    const backend = new FilesystemPersistence(storage);
    const health = await backend.checkHealth();
    const checks = [{
      name: `directory:${targetDir}`,
      ok: health.ok,
      detail: health.ok ? "read/write ok" : (health.error ?? "health check failed"),
    }];

    return {
      ok: checks.every((check) => check.ok),
      backend: "filesystem",
      config: {
        dataDir: targetDir,
      },
      checks,
      migrationStatus: [],
    };
  }

  if (persistence.kind === "postgres") {
    const config = resolvePostgresConfig(persistence, options, options.cwd);
    const { checks, migrationStatus } = await inspectPostgresResources(config);

    return {
      ok: [...checks, ...migrationStatus].every((check) => check.ok),
      backend: "postgres",
      config: {
        connectionString: redactConnectionString(config.connectionString),
        schema: config.schema,
        tablePrefix: config.tablePrefix,
        assetDataDir: config.assetDataDir,
      },
      checks,
      migrationStatus,
    };
  }

  const config = resolveSupabaseConfig(persistence, options);
  const backend = new SupabasePersistence({
    appName: "ai-kit-doctor",
    userId: "anonymous",
    url: config.url,
    serviceRoleKey: config.serviceRoleKey,
    schema: config.schema,
    tablePrefix: config.tablePrefix,
  });
  const health = await backend.checkHealth();
  const checks = [{
    name: "connectivity",
    ok: health.ok,
    detail: health.ok ? "query ok" : (health.error ?? "connectivity check failed"),
  }];
  const resources = await inspectSupabaseResources(config);
  checks.push(...resources.checks);

  return {
    ok: [...checks, ...resources.migrationStatus].every((check) => check.ok),
    backend: "supabase",
    config: {
      url: config.url,
      schema: config.schema,
      tablePrefix: config.tablePrefix,
      bucket: config.bucket,
    },
    checks,
    migrationStatus: resources.migrationStatus,
  };
}

function redactConnectionString(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "<invalid>";
  }
}
