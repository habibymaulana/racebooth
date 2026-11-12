import { createHmac } from 'node:crypto';

const PRUNE_EVERY = 500;
const PRUNE_BATCH = 500;

/** Shared, database-backed express-rate-limit store for horizontally scaled APIs. */
export class PostgresRateLimitStore {
  constructor(pool, secret, namespace) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required.');
    if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('A strong rate-limit key is required.');
    if (!/^[a-z0-9_-]{1,40}$/i.test(namespace)) throw new TypeError('Invalid rate-limit namespace.');
    this.pool = pool;
    this.secret = secret;
    this.namespace = namespace;
    this.prefix = `racebooth:${namespace}:`;
    this.localKeys = false;
    this.windowMs = 60_000;
    this.incrementCount = 0;
  }

  init(options) { this.windowMs = options.windowMs; }

  hashKey(key) {
    return createHmac('sha256', this.secret).update(`${this.namespace}\0${key}`).digest('hex');
  }

  async increment(key) {
    const result = await this.pool.query(`
      INSERT INTO api_rate_limit_counters(namespace,key_hash,hits,reset_at)
      VALUES($1,$2,1,NOW()+($3::integer * INTERVAL '1 millisecond'))
      ON CONFLICT(namespace,key_hash) DO UPDATE SET
        hits=CASE WHEN api_rate_limit_counters.reset_at<=NOW() THEN 1 ELSE api_rate_limit_counters.hits+1 END,
        reset_at=CASE WHEN api_rate_limit_counters.reset_at<=NOW()
          THEN NOW()+($3::integer * INTERVAL '1 millisecond') ELSE api_rate_limit_counters.reset_at END
      RETURNING hits,reset_at
    `, [this.namespace, this.hashKey(key), this.windowMs]);

    this.incrementCount += 1;
    if (this.incrementCount % PRUNE_EVERY === 0) {
      void this.pool.query(`
        DELETE FROM api_rate_limit_counters WHERE ctid IN (
          SELECT ctid FROM api_rate_limit_counters
          WHERE reset_at<NOW()-INTERVAL '1 hour'
          ORDER BY reset_at LIMIT $1
        )
      `, [PRUNE_BATCH]).catch(() => {});
    }
    return { totalHits: Number(result.rows[0].hits), resetTime: new Date(result.rows[0].reset_at) };
  }

  async decrement(key) {
    await this.pool.query(`UPDATE api_rate_limit_counters SET hits=GREATEST(hits-1,0)
      WHERE namespace=$1 AND key_hash=$2 AND reset_at>NOW()`, [this.namespace, this.hashKey(key)]);
  }

  async resetKey(key) {
    await this.pool.query('DELETE FROM api_rate_limit_counters WHERE namespace=$1 AND key_hash=$2', [this.namespace, this.hashKey(key)]);
  }

  async resetAll() {
    await this.pool.query('DELETE FROM api_rate_limit_counters WHERE namespace=$1', [this.namespace]);
  }
}
