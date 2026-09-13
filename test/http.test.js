import test from 'node:test';
import assert from 'node:assert/strict';

import { mcpHandler } from '../src/index.js';

function invoke(request) {
  return new Promise((resolve, reject) => {
    const response = {
      headers: {},
      statusCode: 200,
      set(name, value) {
        this.headers[name] = value;
        return this;
      },
      status(value) {
        this.statusCode = value;
        return this;
      },
      send(value) {
        resolve({ status: this.statusCode, headers: this.headers, body: value });
        return this;
      }
    };
    Promise.resolve(mcpHandler(request, response)).catch(reject);
  });
}

function request(method, path, overrides = {}) {
  return {
    method,
    path,
    headers: {},
    query: {},
    body: undefined,
    protocol: 'https',
    ...overrides
  };
}

test('health reports a securely configured service', async () => {
  const previous = process.env.MCP_API_KEY;
  process.env.MCP_API_KEY = 'h'.repeat(64);
  try {
    const response = await invoke(request('GET', '/health'));
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).status, 'healthy');
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  } finally {
    if (previous === undefined) delete process.env.MCP_API_KEY;
    else process.env.MCP_API_KEY = previous;
  }
});

test('private Garmin routes reject missing authentication before storage access', async () => {
  const previous = process.env.MCP_API_KEY;
  process.env.MCP_API_KEY = 'h'.repeat(64);
  try {
    const response = await invoke(request('GET', '/auth/garmin/status', {
      query: { athleteId: 'synthetic-athlete' }
    }));
    assert.equal(response.status, 401);
    assert.equal(response.headers['WWW-Authenticate'], 'Bearer');
  } finally {
    if (previous === undefined) delete process.env.MCP_API_KEY;
    else process.env.MCP_API_KEY = previous;
  }
});

test('oversized requests fail before route handling', async () => {
  const response = await invoke(request('POST', '/mcp', {
    headers: { 'content-length': String(65 * 1024) }
  }));
  assert.equal(response.status, 413);
});

test('oversized parsed bodies fail even without a content-length header', async () => {
  const response = await invoke(request('POST', '/mcp', {
    body: { payload: 'x'.repeat(65 * 1024) }
  }));
  assert.equal(response.status, 413);
});

test('disallowed CORS preflight is rejected', async () => {
  const previous = process.env.CORS_ALLOWED_ORIGINS;
  process.env.CORS_ALLOWED_ORIGINS = 'https://ui.example.test';
  try {
    const response = await invoke(request('OPTIONS', '/mcp', {
      headers: { origin: 'https://evil.example.test', host: 'api.example.test' }
    }));
    assert.equal(response.status, 403);
    assert.equal(response.headers['Access-Control-Allow-Origin'], undefined);
  } finally {
    if (previous === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previous;
  }
});
