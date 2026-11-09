import { readFile, readdir } from 'node:fs/promises';

export async function applyTestMigrations(pool) {
  await pool.query('CREATE TABLE operator_schema_migrations(name TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const directory = new URL('../../../database/migrations/', import.meta.url);
  const names = (await readdir(directory)).filter(name => /^\d{2}-.+\.sql$/.test(name)).sort();
  for (const name of names) await pool.query(await readFile(new URL(name, directory), 'utf8'));
}
