import postgres from 'postgres';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Ordered list of migration files to execute
const MIGRATION_FILES = [
  '0001_initial.sql',
  '0002_add_email.sql',
];

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
    console.warn('DATABASE_URL is not set -- skipping migrations');
    return;
  }

  const sql = postgres(connectionString);

  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));

    for (const fileName of MIGRATION_FILES) {
      const migrationSql = readMigrationFile(currentDir, fileName);
      await sql.unsafe(migrationSql);
    }

    console.log('Database migrations completed successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Migration failed: ${message}`);
    throw error;
  } finally {
    await sql.end();
  }
}

/**
 * Read a migration file from the drizzle/ directory.
 *
 * Tries two paths because the relative location of drizzle/
 * differs between development (src/) and production (dist/).
 */
function readMigrationFile(currentDir: string, fileName: string): string {
  // Development path: src/db/migrate.ts -> ../../drizzle/
  const devPath = join(currentDir, '..', '..', 'drizzle', fileName);
  try {
    return readFileSync(devPath, 'utf-8');
  } catch {
    // Production path: dist/db/migrate.js -> ../drizzle/
    const prodPath = join(currentDir, '..', 'drizzle', fileName);
    return readFileSync(prodPath, 'utf-8');
  }
}
