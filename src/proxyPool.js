const https = require('https');
const ProxyManager = require('./proxyManager');

/**
 * Auto-fetched pool of free public proxies.
 *
 * Lists come from monosans/proxy-list, which publishes small, frequently
 * regenerated SOCKS4 and SOCKS5 lists (a couple hundred entries between them,
 * versus ~10k in the big HTTP lists). Small enough that every entry can be
 * validated on each refresh instead of sampling.
 *
 * Nothing here is ever written to .env - the pool lives in memory only.
 *
 * Validation opens the proxy tunnel to a host we actually care about and
 * completes the TLS handshake, then drops it. No HTTP request is sent, no API
 * key is used, and no third-party "what is my IP" service is involved; it tests
 * exactly the path a real request would take.
 */

const SOURCES = [
  { scheme: 'socks5', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt' },
  { scheme: 'socks4', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt' },
];

const ENTRY_RE = /^(?:(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9][a-z0-9.-]*):\d{1,5}$/i;
const MAX_LIST_BYTES = 2 * 1024 * 1024;

class ProxyPool {
  constructor(options = {}) {
    this.getProbeTarget = options.getProbeTarget || (() => 'api.openai.com');
    this.onUpdate = options.onUpdate || (() => {});

    this.enabled = false;
    this.concurrency = options.concurrency || 25;
    this.probeTimeoutMs = options.probeTimeoutMs || 6000;
    this.refreshIntervalMs = options.refreshIntervalMs || 30 * 60 * 1000;
    // Floor between refreshes so a burst of failures can't hammer GitHub
    this.minRefreshGapMs = options.minRefreshGapMs || 5 * 60 * 1000;

    this.live = [];
    this.lastRefreshAt = null;
    this.lastTested = 0;
    this.lastError = null;
    this.refreshing = false;
    this.timer = null;
    this._activeRefresh = null;   // in-flight sweep, shared by concurrent callers

    // Live counters for the panel - a sweep takes the better part of a minute,
    // so it has to be able to show something moving.
    this.progress = { phase: 'idle', tested: 0, total: 0, live: 0 };
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.refresh('enabled');
    if (!this.timer) {
      this.timer = setInterval(() => this.refresh('scheduled'), this.refreshIntervalMs);
      if (this.timer.unref) this.timer.unref();
    }
  }

  stop() {
    this.enabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.live = [];
    this.onUpdate(this);
  }

  getStatus() {
    return {
      enabled: this.enabled,
      refreshing: this.refreshing,
      live: this.live.length,
      tested: this.lastTested,
      lastRefreshAt: this.lastRefreshAt,
      lastError: this.lastError,
      progress: { ...this.progress },
      proxies: this.live.map((url) => ({ url, masked: ProxyManager.maskProxyUrl(url) })),
    };
  }

  /**
   * Fetch, validate and swap in a new live set.
   * `force` bypasses the minimum gap (used by the panel's "Refresh now").
   *
   * Callers that arrive while a sweep is already running join that sweep and
   * get its real result. Returning the current (empty) status instead would
   * make "Refresh now" during the startup sweep look like it found nothing.
   */
  async refresh(reason = 'manual', force = false) {
    if (!this.enabled) return this.getStatus();

    if (this._activeRefresh) return this._activeRefresh;

    if (!force && this.lastRefreshAt && Date.now() - this.lastRefreshAt < this.minRefreshGapMs) {
      return this.getStatus(); // too soon - a failure storm shouldn't spam the source
    }

    this._activeRefresh = this._runRefresh(reason);
    try {
      return await this._activeRefresh;
    } finally {
      this._activeRefresh = null;
    }
  }

  async _runRefresh(reason) {
    this.refreshing = true;
    this.lastError = null;
    this.progress = { phase: 'fetching', tested: 0, total: 0, live: 0 };
    const startedAt = Date.now();

    try {
      const candidates = await this.fetchCandidates();
      if (candidates.length === 0) throw new Error('no usable entries in the source lists');

      this.progress = { phase: 'testing', tested: 0, total: candidates.length, live: 0 };
      const target = this.getProbeTarget() || 'api.openai.com';
      console.log(`[PROXY-POOL] ${reason}: validating ${candidates.length} proxies against ${target}...`);

      const live = await this.validate(candidates, target);

      this.live = live;
      this.lastTested = candidates.length;
      this.lastRefreshAt = Date.now();
      console.log(`[PROXY-POOL] ${live.length} of ${candidates.length} proxies alive (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    } catch (err) {
      this.lastError = err.message;
      this.lastRefreshAt = Date.now();
      console.log(`[PROXY-POOL] Refresh failed: ${err.message}`);
    } finally {
      this.refreshing = false;
      this.progress = { ...this.progress, phase: 'idle' };
      this.onUpdate(this);
    }

    return this.getStatus();
  }

  /** Pull every source list and turn it into deduped scheme-qualified URLs. */
  async fetchCandidates() {
    const seen = new Set();
    const out = [];

    for (const source of SOURCES) {
      let text;
      try {
        text = await ProxyPool.httpGetWithRetry(source.url);
      } catch (err) {
        // One source failing is survivable - carry on with whatever else loaded
        console.log(`[PROXY-POOL] Could not fetch ${source.scheme} list: ${err.message}`);
        continue;
      }

      let added = 0;
      for (const raw of text.split('\n')) {
        const entry = raw.trim();
        if (!ENTRY_RE.test(entry)) continue;
        const url = `${source.scheme}://${entry}`;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
        added += 1;
      }
      console.log(`[PROXY-POOL] ${source.scheme}: ${added} entries`);
    }

    return out;
  }

  /** Probe every candidate, `concurrency` at a time, keeping the ones that answer. */
  async validate(candidates, targetHost) {
    const live = [];
    let cursor = 0;

    const worker = async () => {
      while (cursor < candidates.length) {
        const url = candidates[cursor++];
        if (!this.enabled) return; // turned off mid-run
        const ok = await this.probe(url, targetHost);
        this.progress.tested += 1;
        if (ok) {
          live.push(url);
          this.progress.live += 1;
        }
      }
    };

    const workers = Array.from({ length: Math.min(this.concurrency, candidates.length) }, worker);
    await Promise.all(workers);
    return live;
  }

  /**
   * Open the tunnel and complete the TLS handshake to `targetHost`, then hang
   * up. Resolves true only if the proxy carried a real connection.
   */
  probe(proxyUrl, targetHost) {
    return new Promise((resolve) => {
      let settled = false;
      let socket = null;

      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (socket) { try { socket.destroy(); } catch (e) { /* ignore */ } }
        resolve(ok);
      };

      const timer = setTimeout(() => done(false), this.probeTimeoutMs + 500);

      let agent;
      try {
        agent = ProxyManager.createAgent(proxyUrl, { proxyTimeoutMs: this.probeTimeoutMs });
      } catch (e) {
        return done(false); // unparseable entry
      }

      try {
        agent.createConnection(
          { host: targetHost, port: 443, servername: targetHost },
          (err, tlsSocket) => {
            socket = tlsSocket || null;
            done(!err && !!tlsSocket);
          }
        );
      } catch (e) {
        done(false);
      }
    });
  }

  /**
   * raw.githubusercontent.com serves an occasional 503, which would otherwise
   * silently cost us a whole list for the next 30 minutes. One retry is enough
   * to ride out the blips seen in practice.
   */
  static async httpGetWithRetry(url, attempts = 2, delayMs = 1500) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
      try {
        return await ProxyPool.httpGet(url);
      } catch (err) {
        lastError = err;
        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    throw lastError;
  }

  static httpGet(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 15000, headers: { 'User-Agent': 'rotato-proxy-pool' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let data = '';
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_LIST_BYTES) {
            req.destroy();
            return reject(new Error('list is unexpectedly large'));
          }
          data += chunk;
        });
        res.on('end', () => resolve(data));
      });

      req.on('timeout', () => { req.destroy(); reject(new Error('timed out')); });
      req.on('error', (err) => reject(err));
    });
  }
}

module.exports = ProxyPool;
