import pg from 'pg';

/**
 * Schema migrations, applied in order and recorded in schema_migrations.
 * Append new entries; never edit one that has shipped.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        entra_oid text NOT NULL UNIQUE,
        email text,
        name text,
        timezone text NOT NULL DEFAULT 'America/Los_Angeles',
        custom_rate_cents numeric(6,2),
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE vehicles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('car','truck','van','other')),
        is_tesla boolean NOT NULL DEFAULT false,
        qualified_nonpersonal_use boolean NOT NULL DEFAULT false,
        archived boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX vehicles_user_idx ON vehicles(user_id);

      CREATE TABLE trips (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vehicle_id uuid REFERENCES vehicles(id) ON DELETE SET NULL,
        started_at timestamptz NOT NULL,
        ended_at timestamptz,
        start_label text,
        end_label text,
        start_lat double precision,
        start_lng double precision,
        end_lat double precision,
        end_lng double precision,
        start_odometer numeric(10,1),
        end_odometer numeric(10,1),
        miles numeric(8,1) NOT NULL CHECK (miles > 0),
        classification text NOT NULL CHECK (classification IN ('business','personal','commute','unclassified')),
        purpose text,
        client text,
        notes text,
        source text NOT NULL CHECK (source IN ('manual','tesla','gps')),
        external_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      );
      CREATE INDEX trips_user_started_idx ON trips(user_id, started_at DESC) WHERE deleted_at IS NULL;
      -- Lets Tesla/GPS ingestion upsert without creating duplicates.
      CREATE UNIQUE INDEX trips_external_idx ON trips(user_id, source, external_id) WHERE external_id IS NOT NULL;
    `,
  },
];

export function createPool(): pg.Pool {
  const sslRequired = ['require', 'verify-ca', 'verify-full'].includes(process.env.PGSSLMODE ?? '');
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    // Azure Database for PostgreSQL presents a publicly trusted certificate.
    ssl: sslRequired ? { rejectUnauthorized: true } : undefined,
    max: Number(process.env.PG_POOL_MAX ?? 5),
    idleTimeoutMillis: 30_000,
  });
}

const MIGRATION_LOCK = 4_812_377; // arbitrary advisory-lock key for this app

/** Applies pending migrations. Safe to call from several instances at once. */
export async function migrate(pool: pg.Pool, log: (msg: string) => void = () => {}): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version int PRIMARY KEY,
         name text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ version: number }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    let count = 0;
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      log(`Applied migration ${m.version} (${m.name})`);
      count++;
    }
    return count;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
