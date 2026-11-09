const accountIdPattern = /^[a-f0-9]{32}$/i;
const bucketPattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** Validate Cloudflare's account-scoped S3 endpoint without exposing credential values. */
export function parseR2Config(env) {
  const accountId = env.R2_ACCOUNT_ID;
  const bucket = env.R2_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accountIdPattern.test(accountId || '') || !bucketPattern.test(bucket || '')
      || typeof accessKeyId !== 'string' || accessKeyId.length < 16
      || typeof secretAccessKey !== 'string' || secretAccessKey.length < 16) {
    throw new Error('Cloudflare R2 storage configuration is incomplete or invalid.');
  }
  return {
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: 'auto',
    bucket,
    credentials: { accessKeyId, secretAccessKey },
  };
}
