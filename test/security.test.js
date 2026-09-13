import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSignedState,
  getBearerToken,
  isOriginAllowed,
  validateApiKey,
  validateAthleteId,
  validateRedirectUrl,
  verifySignedState
} from '../src/security.js';

const TEST_KEY = 'a'.repeat(64);

test('bearer authentication requires an exact strong key', () => {
  assert.equal(getBearerToken(`Bearer ${TEST_KEY}`), TEST_KEY);
  assert.equal(getBearerToken('Basic abc'), null);
  assert.equal(validateApiKey(`Bearer ${TEST_KEY}`, TEST_KEY), true);
  assert.equal(validateApiKey(`Bearer ${'b'.repeat(64)}`, TEST_KEY), false);
  assert.equal(validateApiKey('Bearer short', 'short'), false);
});

test('athlete identifiers reject path traversal and oversized input', () => {
  assert.equal(validateAthleteId('athlete-123@example.test'), true);
  assert.equal(validateAthleteId('../athlete'), false);
  assert.equal(validateAthleteId('a/b'), false);
  assert.equal(validateAthleteId('x'.repeat(129)), false);
});

test('signed OAuth state verifies and rejects tampering or expiry', () => {
  const state = createSignedState({ nonce: 'test', iat: Date.now(), redirect: null }, TEST_KEY);
  assert.equal(verifySignedState(state, TEST_KEY).nonce, 'test');
  assert.equal(verifySignedState(`${state}x`, TEST_KEY), null);

  const expired = createSignedState({ nonce: 'old', iat: Date.now() - 700_000 }, TEST_KEY);
  assert.equal(verifySignedState(expired, TEST_KEY), null);
});

test('origins and redirects require an exact allow-list match', () => {
  const allowed = new Set(['https://ui.example.test']);
  assert.equal(isOriginAllowed('https://ui.example.test', allowed), true);
  assert.equal(isOriginAllowed('https://api.example.test', allowed), false);
  assert.equal(isOriginAllowed('https://evil.example.test', allowed), false);
  assert.equal(validateRedirectUrl('https://ui.example.test/callback', allowed), 'https://ui.example.test/callback');
  assert.equal(validateRedirectUrl('https://evil.example.test/callback', allowed), null);
  assert.equal(validateRedirectUrl('javascript:alert(1)', allowed), null);
});
