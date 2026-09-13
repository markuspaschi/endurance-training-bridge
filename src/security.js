import crypto from 'node:crypto';

const SAFE_ATHLETE_ID = /^[A-Za-z0-9._@+-]{1,128}$/;

export function getBearerToken(authHeader) {
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7).trim();
  return token || null;
}

export function validateApiKey(authHeader, configuredKey = process.env.MCP_API_KEY) {
  const providedKey = getBearerToken(authHeader);
  if (!providedKey || !configuredKey || Buffer.byteLength(configuredKey, 'utf8') < 32) return false;

  const provided = Buffer.from(providedKey, 'utf8');
  const expected = Buffer.from(configuredKey, 'utf8');
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

export function isStrongAccessKey(value) {
  return typeof value === 'string' && /^etb_[A-Za-z0-9_-]{43}$/.test(value);
}

export function hashAccessKey(value) {
  if (!isStrongAccessKey(value)) return null;
  return crypto.createHash('sha256').update(value, 'utf8').digest('base64url');
}

export function validateAccessKey(value, expectedHash) {
  const actualHash = hashAccessKey(value);
  if (!actualHash || typeof expectedHash !== 'string') return false;

  const actual = Buffer.from(actualHash, 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function validateAthleteId(value) {
  return typeof value === 'string' && SAFE_ATHLETE_ID.test(value);
}

export function allowedOrigins(value = process.env.CORS_ALLOWED_ORIGINS || '') {
  return new Set(
    value
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean)
  );
}

export function isOriginAllowed(origin, configuredOrigins = allowedOrigins()) {
  if (!origin) return true;
  return configuredOrigins.has(origin);
}

export function createSignedState(payload, secret = process.env.MCP_API_KEY) {
  if (!secret) throw new Error('MCP_API_KEY is not configured');

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifySignedState(state, secret = process.env.MCP_API_KEY, maxAgeMs = 10 * 60 * 1000) {
  if (!secret || typeof state !== 'string') return null;
  const [encoded, signature, extra] = state.split('.');
  if (!encoded || !signature || extra) return null;

  const expected = crypto.createHmac('sha256', secret).update(encoded).digest();
  let provided;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Number.isFinite(payload.iat) || Date.now() - payload.iat > maxAgeMs || payload.iat > Date.now() + 60_000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function validateRedirectUrl(value, configuredOrigins = allowedOrigins()) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const isLocalHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !isLocalHttp) return null;
    return configuredOrigins.has(url.origin) ? url.toString() : null;
  } catch {
    return null;
  }
}
