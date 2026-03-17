import type { SetupCommandOptions } from "../shared.js";
import {
  ensureDirectoryReady,
  resolveCliPersistence,
  resolveFilesystemDataDir,
  resolveSupabaseConfig,
  runSupabaseSetup,
} from "../shared.js";

export async function runSetupCommand(options: SetupCommandOptions): Promise<string> {
  const persistence = await resolveCliPersistence(options);

  if (persistence.kind === "filesystem") {
    const targetDir = resolveFilesystemDataDir(persistence, options.cwd);
    await ensureDirectoryReady(targetDir);
    return `Filesystem backend is ready at ${targetDir}`;
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
