import type { SetupCommandOptions } from "../shared.js";
import {
  ensureDirectoryReady,
  resolvePostgresConfig,
  resolveCliPersistence,
  resolveFilesystemDataDir,
  resolveSupabaseConfig,
  runPostgresSetup,
  runSupabaseSetup,
} from "../shared.js";

export async function runSetupCommand(options: SetupCommandOptions): Promise<string> {
  const persistence = await resolveCliPersistence(options);

  if (persistence.kind === "filesystem") {
    const targetDir = resolveFilesystemDataDir(persistence, options.cwd);
    await ensureDirectoryReady(targetDir);
    return `Filesystem backend is ready at ${targetDir}`;
  }

  if (persistence.kind === "postgres") {
    const config = resolvePostgresConfig(persistence, options, options.cwd);
    await ensureDirectoryReady(config.assetDataDir);
    await runPostgresSetup(config, {
      dbUrl: options.dbUrl ?? process.env.AI_KIT_POSTGRES_DB_URL,
    });
    return [
      "Postgres backend setup completed.",
      `schema=${config.schema}`,
      `tablePrefix=${config.tablePrefix}`,
      `assetDataDir=${config.assetDataDir}`,
    ].join(" ");
  }

  const config = resolveSupabaseConfig(persistence, options);
  await runSupabaseSetup(config, {
    cwd: options.cwd,
    dbUrl: options.dbUrl ?? process.env.AI_KIT_SUPABASE_DB_URL,
    local: options.local,
    debug: options.debug,
  });
  return [
    "Supabase backend setup completed.",
    `schema=${config.schema}`,
    `tablePrefix=${config.tablePrefix}`,
    `bucket=${config.bucket}`,
  ].join(" ");
}
