import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('static UI keeps executable code external for a strict CSP', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
});

test('static UI does not embed deployment credentials or endpoints', async () => {
  const files = await Promise.all([
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/app.js', import.meta.url), 'utf8')
  ]);
  const source = files.join('\n');
  assert.doesNotMatch(source, /Authorization:\s*Bearer\s+[A-Za-z0-9_-]{20,}/i);
  assert.doesNotMatch(source, /https:\/\/[^\s"'`]+\.run\.app/i);
  assert.doesNotMatch(source, /cloudfunctions\.net/i);
});

test('static UI links to the public source repository', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /https:\/\/github\.com\/markuspaschi\/endurance-training-bridge/);
});
