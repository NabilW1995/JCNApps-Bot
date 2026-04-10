import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let db: DrizzleDb | null = null;

/**
 * Get or create the shared database connection.
 *
 * Uses a singleton so the connection pool is reused across requests.
 * Throws if DATABASE_URL is not set — callers should catch this and
 * degrade gracefully.
 */
export function getDb(): DrizzleDb {
  if (!db) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not configured');
    }
    const client = postgres(connectionString);
    db = drizzle(client, { schema });
  }
  return db;
}

export type Database = DrizzleDb;
