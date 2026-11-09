import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { createPool, transaction } from '../src/db.js';
import { hashPassword } from '../src/security.js';

// No public bootstrap endpoint, password flags, environment password, or default account.
async function hiddenPrompt(label) {
  if (!process.stdin.isTTY) throw new Error('Provisioning requires an interactive terminal (docker compose run --rm -it).');
  process.stdout.write(label);
  const input = process.stdin;
  input.setRawMode(true); input.resume(); input.setEncoding('utf8');
  try {
    return await new Promise((resolve, reject) => {
      let value = '';
      const onData = data => {
        for (const char of data) {
          if (char === '\u0003' || char === '\u0004') { input.off('data', onData); reject(new Error('Cancelled.')); return; }
          if (char === '\r' || char === '\n') { input.off('data', onData); resolve(value); return; }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else if (char >= ' ' && value.length < 1024) value += char;
        }
      };
      input.on('data', onData);
    });
  } finally { input.setRawMode(false); input.pause(); process.stdout.write('\n'); }
}
let pool;
try {
  const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
  const operator = z.object({ email: z.email().trim().toLowerCase().max(254), name: z.string().trim().min(2).max(100) }).parse(values);
  const password = await hiddenPrompt('New operator password (16+ characters, hidden): ');
  if (password.length < 16 || password.length > 1024) throw new Error('Password must contain 16–1024 characters.');
  const confirmation = await hiddenPrompt('Confirm password (hidden): ');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  const passwordHash = await hashPassword(password);
  pool = createPool(loadConfig());
  await transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('photobooth-operator-provision', 0))");
    const exists = await db.query('SELECT id FROM app_users WHERE lower(email)=lower($1)', [operator.email]);
    if (exists.rowCount) throw new Error('That email already exists. Provisioning never changes existing accounts.');
    await db.query("INSERT INTO app_users(full_name,email,password_hash,role,is_active) VALUES($1,$2,$3,'operator',TRUE)", [operator.name, operator.email, passwordHash]);
  });
  console.log('Operator provisioned. Log in through the dashboard.');
} catch (error) { console.error(`Provisioning failed: ${error.code || (error instanceof z.ZodError ? 'Invalid --email or --name.' : error.message)}`); process.exitCode = 1; }
finally { if (pool) await pool.end(); }
