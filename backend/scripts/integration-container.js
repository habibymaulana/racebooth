import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

// Creates only a disposable container. Does not touch the existing DB, n8n, or volumes.
const name = 'photobooth-phase1-test-db';
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'photobooth-integration-'));
const envPath = join(directory, 'test.env');
const password = randomBytes(32).toString('hex');
writeFileSync(envPath, `POSTGRES_PASSWORD=${password}\nPOSTGRES_USER=phase1_test\nPOSTGRES_DB=photobooth_phase1_test\nPGHOST=${name}\nPGPORT=5432\nPGDATABASE=photobooth_phase1_test\nPGUSER=phase1_test\nPGPASSWORD=${password}\nSESSION_SECRET=${randomBytes(48).toString('hex')}\nTOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nCOOKIE_SECURE=false\nAPP_ORIGINS=http://localhost:8088\nALLOW_INTEGRATION_DB_SETUP=disposable-container\n`, { mode: 0o600 });
function docker(args, inherit = false) {
  const result = spawnSync('docker', args, { cwd: workspace, stdio: inherit ? 'inherit' : 'pipe', encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Docker operation failed (${args[0]}). ${result.stderr || result.error?.message || ''}`);
  return result.stdout?.trim();
}
let started = false;
try {
  // Do not remove/reuse any pre-existing container that happens to have our test name.
  const existing = spawnSync('docker', ['container', 'inspect', name], { stdio: 'ignore' });
  if (existing.status === 0) throw new Error(`${name} already exists. Inspect it manually before running this suite.`);
  docker(['run', '--rm', '-d', '--name', name, '--network', 'photobooth-net', '--tmpfs', '/var/lib/postgresql/data', '--env-file', envPath, 'postgres:16-alpine']);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'phase1_test', '-d', 'photobooth_phase1_test'], { stdio: 'ignore' });
    if (result.status === 0) { ready = true; break; }
    await setTimeout(1000);
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready.');
  const result = spawnSync('docker', ['run', '--rm', '--network', 'photobooth-net', '--env-file', envPath,
    '-v', `${resolve(workspace, 'database')}:/app/database:ro`,
    '-v', `${resolve(workspace, 'backend/src')}:/app/backend/src:ro`,
    '-v', `${resolve(workspace, 'shared')}:/app/shared:ro`,
    '-v', `${resolve(workspace, 'backend/test/integration')}:/app/backend/test/integration:ro`,
    'photobooth-backend', 'npm', 'run', 'test:integration'], { cwd: workspace, stdio: 'inherit' });
  process.exitCode = result.status || (result.error ? 1 : 0);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (started) { try { docker(['stop', '--time', '5', name]); } catch { console.error('Could not stop the disposable test container; inspect it manually.'); process.exitCode = 1; } }
  rmSync(directory, { recursive: true, force: true });
}
