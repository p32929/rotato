class QuarantineTracker {
  constructor() {
    this.deadKeys = new Map();
    this.stateFile = require('path').join(require('os').homedir(), 'rotato', 'quarantine_state.json');
    this.load();
    setInterval(() => this.save(), 30000);
  }

  load() {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        for (const [k, v] of Object.entries(data)) {
          this.deadKeys.set(k, v);
        }
        console.log(`[QUARANTINE] Loaded ${this.deadKeys.size} dead key entries from disk`);
      }
    } catch (e) {
      console.log(`[QUARANTINE] Failed to load state: ${e.message}`);
    }
  }

  save() {
    try {
      const fs = require('fs');
      const data = Object.fromEntries(this.deadKeys);
      fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
    } catch (e) {}
  }

  isDead(key) {
    const entry = this.deadKeys.get(key);
    if (!entry) return false;
    return Date.now() < entry.expiresAt;
  }

  markDead(key, apiType, statusCode) {
    const quarantineDurationMs = 24 * 60 * 60 * 1000;
    const expiresAt = Date.now() + quarantineDurationMs;
    this.deadKeys.set(key, {
      apiType,
      statusCode,
      markedAt: Date.now(),
      expiresAt,
    });
    const masked = key.length > 12 ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}` : '***';
    console.log(`[QUARANTINE] Marked ${apiType} key ${masked} as DEAD (status ${statusCode}), quarantined for 24h`);
  }

  unmarkDead(key) {
    this.deadKeys.delete(key);
    console.log(`[QUARANTINE] Unmarked key as alive`);
  }

  getDeadKeys(apiType = null) {
    const now = Date.now();
    const result = [];
    for (const [key, entry] of this.deadKeys.entries()) {
      if (now >= entry.expiresAt) {
        this.deadKeys.delete(key);
        continue;
      }
      if (!apiType || entry.apiType === apiType) {
        result.push({ key, ...entry });
      }
    }
    return result;
  }
}


class KeyRotator {
  constructor(apiKeys, apiType = 'unknown', providerName = null) {
    this.apiKeys = [...apiKeys];
    this.apiType = apiType;
    this.providerName = providerName || apiType;
    this.lastFailedKey = null;
    this.keyUsageCount = new Map();
    this.quarantineTracker = global.__rotatoQuarantineTracker || (global.__rotatoQuarantineTracker = new QuarantineTracker());
    this.latencyTracker = global.__rotatoLatencyTracker || (global.__rotatoLatencyTracker = new LatencyTracker());
    this.costTracker = global.__rotatoCostTracker || (global.__rotatoCostTracker = new CostTracker());
    for (const key of this.apiKeys) {
      this.keyUsageCount.set(key, 0);
    }
    console.log(`[${apiType.toUpperCase()}-ROTATOR] Initialized with ${this.apiKeys.length} API keys`);
  }

  /**
   * Creates a new request context for per-request key rotation with smart shuffling
   * @returns {RequestKeyContext} A new context for managing keys for a single request
   */
  createRequestContext() {
    return new RequestKeyContext(this.apiKeys, this.apiType, this.lastFailedKey);
  }

  /**
   * Updates the last failed key from the completed request
   * @param {string|null} failedKey The key that failed in the last request, or null if no key failed
   */
  updateLastFailedKey(failedKey) {
    this.lastFailedKey = failedKey;
    if (failedKey) {
      const maskedKey = this.maskApiKey(failedKey);
      console.log(`[${this.apiType.toUpperCase()}-ROTATOR] Last failed key updated: ${maskedKey}`);
    }
  }

  /**
   * Increment usage count for a key (called on successful use)
   */
  incrementKeyUsage(key) {
    if (this.keyUsageCount.has(key)) {
      this.keyUsageCount.set(key, this.keyUsageCount.get(key) + 1);
    }
  }

  /**
   * Get usage statistics for all keys
   */
  getKeyUsageStats() {
    const stats = [];
    for (const key of this.apiKeys) {
      stats.push({
        key: this.maskApiKey(key),
        fullKey: key,
        usageCount: this.keyUsageCount.get(key) || 0
      });
    }
    return stats;
  }

  getTotalKeysCount() {
    return this.apiKeys.length;
  }

  maskApiKey(key) {
    if (!key || key.length < 8) return '***';
    return key.substring(0, 4) + '...' + key.substring(key.length - 4);
  }
}

/**
 * Manages API key rotation for a single request
 * Each request gets its own context to try all available keys with smart shuffling
 */
class RequestKeyContext {
  constructor(apiKeys, apiType, lastFailedKey = null) {
    this.originalApiKeys = [...apiKeys];
    this.apiType = apiType;
    this.currentIndex = 0;
    this.triedKeys = new Set();
    this.rateLimitedKeys = new Set();
    this.lastFailedKeyForThisRequest = null;
    
    // Apply smart shuffling: shuffle keys but move last failed key to end
    this.apiKeys = this.smartShuffle(apiKeys, lastFailedKey);
    
    if (lastFailedKey) {
      const maskedKey = this.maskApiKey(lastFailedKey);
      console.log(`[${this.apiType.toUpperCase()}] Smart shuffle applied - last failed key ${maskedKey} moved to end`);
    }
  }
  
  /**
   * Smart shuffle: randomize key order but move last failed key to the end
   * @param {Array} keys Array of API keys
   * @param {string|null} lastFailedKey The key that failed in the previous request
   * @returns {Array} Shuffled array with last failed key at the end
   */
  smartShuffle(keys, lastFailedKey) {
    const shuffled = [...keys];
    
    // Fisher-Yates shuffle algorithm
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    // If we have a last failed key, move it to the end
    if (lastFailedKey && keys.includes(lastFailedKey)) {
      const failedKeyIndex = shuffled.indexOf(lastFailedKey);
      if (failedKeyIndex !== -1) {
        // Remove the failed key from its current position
        shuffled.splice(failedKeyIndex, 1);
        // Add it to the end
        shuffled.push(lastFailedKey);
      }
    }
    
    return shuffled;
  }

  /**
   * Gets the next available key to try for this request
   * @returns {string|null} The next API key to try, or null if all keys have been tried
   */
  getNextKey() {
    if (this.triedKeys.size >= this.apiKeys.length) {
      return null;
    }

    const candidates = this.apiKeys.filter(k => !this.triedKeys.has(k) && !(this.quarantineTracker && this.quarantineTracker.isDead(k)));
    if (candidates.length === 0) return null;

    if (this.latencyTracker && candidates.length > 1) {
      candidates.sort((a, b) => {
        const sa = this.latencyTracker.getStats(a);
        const sb = this.latencyTracker.getStats(b);
        if (!sa && !sb) return 0;
        if (!sa) return 1;
        if (!sb) return -1;
        return sa.avg - sb.avg;
      });
    }

    const key = candidates[0];
    this.triedKeys.add(key);
    const maskedKey = this.maskApiKey(key);
    const latencyInfo = this.latencyTracker ? this.latencyTracker.getStats(key) : null;
    const latencyHint = latencyInfo ? ` (latency p50: ${latencyInfo.p50}ms, p95: ${latencyInfo.p95}ms)` : '';
    console.log(`[${this.apiType.toUpperCase()}::${maskedKey}] Trying key (${this.triedKeys.size}/${this.apiKeys.length} tried)${latencyHint} [smart_routing]`);
    return key;
  }

  /**
   * Marks the current key as rate limited for this request
   * @param {string} key The API key that was rate limited
   */
  markKeyAsRateLimited(key) {
    this.rateLimitedKeys.add(key);
    this.lastFailedKeyForThisRequest = key; // Track the most recent failed key
    const maskedKey = this.maskApiKey(key);
    console.log(`[${this.apiType.toUpperCase()}::${maskedKey}] Rate limited for this request (${this.rateLimitedKeys.size}/${this.triedKeys.size} rate limited)`);
    
    // Move to next key for the next attempt
    this.currentIndex = (this.currentIndex + 1) % this.apiKeys.length;
  }

  /**
   * Gets the key that failed most recently in this request (for updating global state)
   * @returns {string|null} The last key that was rate limited in this request
   */
  getLastFailedKey() {
    return this.lastFailedKeyForThisRequest;
  }

  /**
   * Checks if all tried keys were rate limited
   * @returns {boolean} True if all keys that were tried returned 429
   */
  allTriedKeysRateLimited() {
    return this.triedKeys.size > 0 && this.rateLimitedKeys.size === this.triedKeys.size;
  }

  /**
   * Checks if all available keys have been tried
   * @returns {boolean} True if all keys have been attempted
   */
  allKeysTried() {
    return this.triedKeys.size >= this.apiKeys.length;
  }

  /**
   * Gets statistics about this request's key usage
   * @returns {object} Statistics object
   */
  getStats() {
    return {
      totalKeys: this.apiKeys.length,
      triedKeys: this.triedKeys.size,
      rateLimitedKeys: this.rateLimitedKeys.size,
      hasUntriedKeys: this.triedKeys.size < this.apiKeys.length
    };
  }

  maskApiKey(key) {
    if (!key || key.length < 8) return '***';
    return key.substring(0, 4) + '...' + key.substring(key.length - 4);
  }
}

module.exports = KeyRotator;
module.exports.QuarantineTracker = QuarantineTracker;


class LatencyTracker {
  constructor() {
    this.samples = new Map();
    this.maxSamplesPerKey = 20;
    this.stateFile = require('path').join(require('os').homedir(), 'rotato', 'latency_state.json');
    this.load();
    setInterval(() => this.save(), 60000);
  }

  load() {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        for (const [k, v] of Object.entries(data)) {
          this.samples.set(k, v);
        }
        console.log(`[LATENCY] Loaded latency samples for ${this.samples.size} keys`);
      }
    } catch (e) {}
  }

  save() {
    try {
      const fs = require('fs');
      const data = Object.fromEntries(this.samples);
      fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
    } catch (e) {}
  }

  record(key, latencyMs) {
    if (!this.samples.has(key)) this.samples.set(key, []);
    const arr = this.samples.get(key);
    arr.push({ ts: Date.now(), ms: latencyMs });
    if (arr.length > this.maxSamplesPerKey) arr.shift();
  }

  getStats(key) {
    const arr = this.samples.get(key);
    if (!arr || arr.length === 0) return null;
    const ms = arr.map(s => s.ms);
    const sum = ms.reduce((a, b) => a + b, 0);
    const avg = sum / ms.length;
    const sorted = [...ms].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    return { avg: Math.round(avg), p50, p95, samples: arr.length };
  }

  getAll() {
    const result = {};
    for (const [key, _] of this.samples) {
      result[key] = this.getStats(key);
    }
    return result;
  }

  clear() {
    this.samples.clear();
  }
}


class CostTracker {
  constructor() {
    this.records = [];
    this.maxRecords = 10000;
    this.stateFile = require('path').join(require('os').homedir(), 'rotato', 'cost_state.json');
    this.load();
    setInterval(() => this.save(), 120000);
  }

  load() {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        this.records = data.records || [];
        console.log(`[COST] Loaded ${this.records.length} cost records`);
      }
    } catch (e) {}
  }

  save() {
    try {
      const fs = require('fs');
      const trimmed = this.records.slice(-this.maxRecords);
      fs.writeFileSync(this.stateFile, JSON.stringify({ records: trimmed }, null, 2));
    } catch (e) {}
  }

  record(provider, model, tokensIn, tokensOut, cost) {
    this.records.push({
      ts: Date.now(),
      provider,
      model: model || 'unknown',
      tokensIn: tokensIn || 0,
      tokensOut: tokensOut || 0,
      cost: cost || 0
    });
    if (this.records.length > this.maxRecords) this.records.shift();
  }

  getSummary(sinceMs = null) {
    const since = sinceMs || (Date.now() - 24 * 60 * 60 * 1000);
    const filtered = this.records.filter(r => r.ts >= since);
    const byProvider = {};
    const byModel = {};
    let totalCost = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    for (const r of filtered) {
      totalCost += r.cost;
      totalTokensIn += r.tokensIn;
      totalTokensOut += r.tokensOut;
      if (!byProvider[r.provider]) byProvider[r.provider] = { cost: 0, tokensIn: 0, tokensOut: 0, calls: 0 };
      byProvider[r.provider].cost += r.cost;
      byProvider[r.provider].tokensIn += r.tokensIn;
      byProvider[r.provider].tokensOut += r.tokensOut;
      byProvider[r.provider].calls += 1;
      if (!byModel[r.model]) byModel[r.model] = { cost: 0, tokensIn: 0, tokensOut: 0, calls: 0 };
      byModel[r.model].cost += r.cost;
      byModel[r.model].tokensIn += r.tokensIn;
      byModel[r.model].tokensOut += r.tokensOut;
      byModel[r.model].calls += 1;
    }
    return {
      total: {
        cost: Math.round(totalCost * 1e8) / 1e8,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        calls: filtered.length
      },
      byProvider,
      byModel
    };
  }

  getRecent(limit = 50) {
    return this.records.slice(-limit).reverse();
  }
}


class AutoRevival {
  constructor(quarantineTracker, config) {
    this.quarantineTracker = quarantineTracker;
    this.config = config;
    this.checkIntervalMs = 60 * 60 * 1000;
    this.testTimeoutMs = 10000;
    setInterval(() => this.runOnce(), this.checkIntervalMs);
    setTimeout(() => this.runOnce(), 30000);
  }

  async runOnce() {
    const dead = this.quarantineTracker.getDeadKeys();
    if (dead.length === 0) return { checked: 0, revived: 0 };
    console.log(`[AUTO-REVIVAL] Checking ${dead.length} quarantined keys…`);
    let revived = 0;
    for (const entry of dead) {
      const alive = await this.testKey(entry.key, entry.apiType);
      if (alive) {
        this.quarantineTracker.unmarkDead(entry.key);
        console.log(`[AUTO-REVIVAL] Revived key ${entry.key.substring(0, 8)}...`);
        revived += 1;
      }
    }
    return { checked: dead.length, revived };
  }

  async testKey(key, apiType) {
    const providerConfig = this.findProviderConfig(key);
    if (!providerConfig) return false;
    const https = require('https');
    const http = require('http');
    const { URL } = require('url');
    const baseUrl = providerConfig.baseUrl || this.defaultBaseUrl(apiType);
    const u = new URL(baseUrl);
    const protocol = u.protocol === 'http:' ? http : https;
    const testPath = this.testPathForApiType(apiType);
    return new Promise(resolve => {
      const req = protocol.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: testPath,
        method: 'GET',
        timeout: this.testTimeoutMs,
        headers: {
          'Authorization': `Bearer ${key}`,
          'User-Agent': 'rotato-auto-revival/1.0'
        }
      }, res => {
        res.resume();
        const ok = res.statusCode < 400;
        resolve(ok);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  defaultBaseUrl(apiType) {
    const map = {
      openai: 'https://api.openai.com',
      openrouter: 'https://openrouter.ai/api',
      omniroute: 'http://localhost:20128',
      gemini: 'https://generativelanguage.googleapis.com',
      mistral: 'https://api.mistral.ai',
      groq: 'https://api.groq.com/openai',
      opencoderouter: 'https://opencode.ai/zen'
    };
    return map[apiType] || 'https://api.openai.com';
  }

  testPathForApiType(apiType) {
    const map = {
      openai: '/v1/models',
      openrouter: '/v1/models',
      omniroute: '/v1/models',
      gemini: '/v1beta/models',
      mistral: '/v1/models',
      groq: '/v1/models',
      opencoderouter: '/v1/models'
    };
    return map[apiType] || '/v1/models';
  }

  findProviderConfig(key) {
    if (!this.config || !this.config.providers) return null;
    for (const [name, cfg] of Object.entries(this.config.providers)) {
      if (cfg.apiKeys && cfg.apiKeys.includes(key)) return cfg;
    }
    return null;
  }
}


module.exports.LatencyTracker = LatencyTracker;
module.exports.CostTracker = CostTracker;
module.exports.AutoRevival = AutoRevival;