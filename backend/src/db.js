import pg from 'pg';
export function createPool(config) {
  const pool = new pg.Pool(config.pg);
  pool.on('error', () => console.error('PostgreSQL pool connection error'));
  return pool;
}
export async function transaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
