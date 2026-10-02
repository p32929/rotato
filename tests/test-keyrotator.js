const test = require('node:test');
const assert = require('node:assert/strict');
const KeyRotator = require('../src/keyRotator');

test('KeyRotator - initializes usage counts for all keys at zero', () => {
  const rotator = new KeyRotator(['k1', 'k2', 'k3'], 'gemini');
  const stats = rotator.getKeyUsageStats();

  assert.equal(stats.length, 3);
  for (const s of stats) {
    assert.equal(s.usageCount, 0);
  }
});

test('KeyRotator - incrementKeyUsage only affects the given key', () => {
  const rotator = new KeyRotator(['k1', 'k2'], 'gemini');
  rotator.incrementKeyUsage('k1');
  rotator.incrementKeyUsage('k1');

  const stats = rotator.getKeyUsageStats();
  const k1 = stats.find((s) => s.fullKey === 'k1');
  const k2 = stats.find((s) => s.fullKey === 'k2');

  assert.equal(k1.usageCount, 2);
  assert.equal(k2.usageCount, 0);
});

test('KeyRotator - maskApiKey hides the middle of a key', () => {
  const rotator = new KeyRotator(['sk-abcdefgh1234'], 'gemini');
  const masked = rotator.maskApiKey('sk-abcdefgh1234');

  assert.equal(masked, 'sk-a...1234');
  assert.ok(!masked.includes('bcdefgh'));
});

test('KeyRotator - maskApiKey returns a placeholder for short/empty keys', () => {
  const rotator = new KeyRotator(['k1'], 'gemini');
  assert.equal(rotator.maskApiKey(''), '***');
  assert.equal(rotator.maskApiKey('short'), '***');
});

test('RequestKeyContext - getNextKey returns every key exactly once', () => {
  const rotator = new KeyRotator(['k1', 'k2', 'k3'], 'gemini');
  const ctx = rotator.createRequestContext();

  const seen = new Set();
  let key;
  while ((key = ctx.getNextKey()) !== null) {
    assert.ok(!seen.has(key), `key ${key} returned more than once`);
    seen.add(key);
  }

  assert.equal(seen.size, 3);
  assert.deepEqual([...seen].sort(), ['k1', 'k2', 'k3']);
});

test('RequestKeyContext - getNextKey returns null once all keys are exhausted', () => {
  const rotator = new KeyRotator(['k1'], 'gemini');
  const ctx = rotator.createRequestContext();

  assert.equal(ctx.getNextKey(), 'k1');
  assert.equal(ctx.getNextKey(), null);
  assert.equal(ctx.getNextKey(), null);
});

test('RequestKeyContext - smart shuffle moves the last failed key to the end', () => {
  const rotator = new KeyRotator(['k1', 'k2', 'k3', 'k4'], 'gemini');
  rotator.updateLastFailedKey('k2');

  // Run several times since shuffling is randomized - k2 should always land last.
  for (let i = 0; i < 20; i++) {
    const ctx = rotator.createRequestContext();
    assert.equal(ctx.apiKeys[ctx.apiKeys.length - 1], 'k2');
    assert.equal(ctx.apiKeys.length, 4);
  }
});

test('RequestKeyContext - markKeyAsRateLimited tracks rate-limited keys', () => {
  const rotator = new KeyRotator(['k1', 'k2'], 'gemini');
  const ctx = rotator.createRequestContext();

  const first = ctx.getNextKey();
  ctx.markKeyAsRateLimited(first);

  assert.equal(ctx.getLastFailedKey(), first);
  assert.equal(ctx.allTriedKeysRateLimited(), true);
});

test('RequestKeyContext - allTriedKeysRateLimited is false if only some keys failed', () => {
  const rotator = new KeyRotator(['k1', 'k2'], 'gemini');
  const ctx = rotator.createRequestContext();

  const first = ctx.getNextKey();
  ctx.markKeyAsRateLimited(first);
  ctx.getNextKey(); // second key tried but not marked as rate limited

  assert.equal(ctx.allTriedKeysRateLimited(), false);
});

test('RequestKeyContext - allKeysTried reflects exhaustion correctly', () => {
  const rotator = new KeyRotator(['k1', 'k2'], 'gemini');
  const ctx = rotator.createRequestContext();

  assert.equal(ctx.allKeysTried(), false);
  ctx.getNextKey();
  assert.equal(ctx.allKeysTried(), false);
  ctx.getNextKey();
  assert.equal(ctx.allKeysTried(), true);
});

test('RequestKeyContext - getStats reports totals correctly', () => {
  const rotator = new KeyRotator(['k1', 'k2', 'k3'], 'gemini');
  const ctx = rotator.createRequestContext();

  ctx.getNextKey();
  const rateLimited = ctx.getNextKey();
  ctx.markKeyAsRateLimited(rateLimited);

  const stats = ctx.getStats();
  assert.equal(stats.totalKeys, 3);
  assert.equal(stats.triedKeys, 2);
  assert.equal(stats.rateLimitedKeys, 1);
  assert.equal(stats.hasUntriedKeys, true);
});
