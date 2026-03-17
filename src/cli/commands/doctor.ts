import { FileSystemStorage } from "../../storage/fs.js";
import { FilesystemPersistence } from "../../agent/persistence/filesystem.js";
import { SupabasePersistence } from "../../agent/persistence/supabase.js";
import type { DoctorCommandOptions, DoctorReport } from "../shared.js";
import {
  formatDoctorReport,
  inspectSupabaseResources,
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
    };
  }

  const config = resolveSupabaseConfig(persistence, options);
  const backend = new SupabasePersistence({
    appName: "ai-kit-doctor",
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
  checks.push(...await inspectSupabaseResources(config));

  return {
    ok: checks.every((check) => check.ok),
    backend: "supabase",
    config: {
      url: config.url,
      schema: config.schema,
      tablePrefix: config.tablePrefix,
      bucket: config.bucket,
    },
    checks,
  };
}
