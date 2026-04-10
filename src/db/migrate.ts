import postgres from 'postgres';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Run database migrations on startup.
 *
 * Reads SQL files from the drizzle/ directory and executes them
 * against the database. Uses IF NOT EXISTS so it's safe to run
 * multiple times (idempotent).
 */
export async function runMigrations(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('DATABASE_URL is not set — skipping migrations');
    return;
  }

  const sql = postgres(connectionString);

  try {
    // Read and execute the initial migration
    // __dirname equivalent for ESM
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const migrationPath = join(currentDir, '..', '..', 'drizzle', '0001_initial.sql');

    let migrationSql: string;
    try {
      migrationSql = readFileSync(migrationPath, 'utf-8');
    } catch {
      // In production Docker, the path is different
      const altPath = join(currentDir, '..', 'drizzle', '0001_initial.sql');
      migrationSql = readFileSync(altPath, 'utf-8');
    }

    await sql.unsafe(migrationSql);
    console.log('Database migrations completed successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Migration failed: ${message}`);
    throw error;
  } finally {
    await sql.end();
  }
}
