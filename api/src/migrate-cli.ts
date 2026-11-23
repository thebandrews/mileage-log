import { createPool, migrate } from './db.js';

const pool = createPool();
try {
  const n = await migrate(pool, console.log);
  console.log(n === 0 ? 'Database is up to date.' : `Applied ${n} migration(s).`);
} finally {
  await pool.end();
}
