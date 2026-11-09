const https = require('https');
const ProxyManager = require('./proxyManager');

/**
 * Auto-fetched pool of free public proxies.
 *
 * Lists come from monosans/proxy-list and proxifly/free-proxy-list, both
 * regenerated every few minutes: SOCKS5, SOCKS4 and HTTP, ~10k entries after
 * de-duplication. Free proxies are mostly dead or slow, so the more lists the
 * more usable ones survive - a sweep keeps several hundred, against a few
 * dozen from monosans alone. Every entry is validated, a few hundred at a time.
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
  { scheme: 'http', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt' },
  { scheme: 'socks5', url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt' },
  { scheme: 'socks4', url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks4/data.txt' },
  { scheme: 'http', url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt' },
];

const ENTRY_RE = /^(?:(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9][a-z0-9.-]*):\d{1,5}$/i;
const MAX_LIST_BYTES = 2 * 1024 * 1024;

class ProxyPool {
  constructor(options = {}) {
    this.getProbeTarget = options.getProbeTarget || (() => 'api.openai.com');
    this.onUpdate = options.onUpdate || (() => {});

    this.enabled = false;
    this.concurrency = options.concurrency || 300;
    // A proxy that needs over 4s just to open a tunnel is no use for requests
    this.probeTimeoutMs = options.probeTimeoutMs || 4000;
    // Set from the Proxy tab (PROXY_FETCH_MINUTES); setRefreshInterval() changes it live
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
    this._activeGen = 0;
    this.generation = 0;          // bumped on stop(), so a sweep from before is thrown away

    // Live counters for the panel - a sweep takes the better part of a minute,
    // so it has to be able to show something moving.
    this.progress = { phase: 'idle', tested: 0, total: 0, live: 0 };
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    // A list restored from disk that is still fresh is used as is; the
    // scheduled refresh and the background checks take it from there.
    // Otherwise fetch now - forced, so turning it back on soon after turning
    // it off still refills.
    const fresh = this.live.length && this.lastRefreshAt && Date.now() - this.lastRefreshAt < this.refreshIntervalMs;
    if (!fresh) this.refresh('enabled', true);
    if (!this.timer) {
      this.timer = setInterval(() => this.refresh('scheduled'), this.refreshIntervalMs);
      if (this.timer.unref) this.timer.unref();
    }
  }

  setRefreshInterval(ms) {
    if (!(ms > 0) || ms === this.refreshIntervalMs) return;
    this.refreshIntervalMs = ms;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.refresh('scheduled'), this.refreshIntervalMs);
      if (this.timer.unref) this.timer.unref();
    }
  }

  /** Take over the list saved before a restart (see proxyCache.js). */
  restore(cache) {
    this.live = cache.live.filter((e) => e && typeof e.url === 'string');
    this.lastRefreshAt = cache.lastRefreshAt || null;
    this.lastTested = cache.lastTested || 0;
  }

  /** Forget proxies the background checks found dead; the next sweep can bring them back. */
  remove(urls) {
    const gone = new Set(urls);
    this.live = this.live.filter((e) => !gone.has(e.url));
  }

  stop() {
    this.enabled = false;
    this.generation += 1;
    this.refreshing = false;
    this.progress = { phase: 'idle', tested: 0, total: 0, live: 0 };
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.live = [];
    this.lastRefreshAt = null;
    this.lastTested = 0;
    this.lastError = null;
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
      proxies: this.live.map((e) => ({ url: e.url, masked: ProxyManager.maskProxyUrl(e.url), ms: e.ms })),
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

    if (this._activeRefresh && this._activeGen === this.generation) return this._activeRefresh;
    // A sweep from before a stop() is still winding down - let it finish first
    if (this._activeRefresh) await this._activeRefresh.catch(() => {});
    if (this._activeRefresh) return this._activeRefresh; // someone else started the new one
    if (!this.enabled) return this.getStatus();

    if (!force && this.lastRefreshAt && Date.now() - this.lastRefreshAt < this.minRefreshGapMs) {
      return this.getStatus(); // too soon - a failure storm shouldn't spam the source
    }

    const run = this._runRefresh(reason, this.generation);
    this._activeRefresh = run;
    this._activeGen = this.generation;
    try {
      return await run;
    } finally {
      if (this._activeRefresh === run) this._activeRefresh = null;
    }
  }

  async _runRefresh(reason, gen) {
    const stale = () => gen !== this.generation;
    this.refreshing = true;
    this.lastError = null;
    this.progress = { phase: 'fetching', tested: 0, total: 0, live: 0 };
    const startedAt = Date.now();

    try {
      // The ones we have are re-tested along with the fresh lists, so a good
      // proxy isn't lost just because it dropped off its source list
      const candidates = await this.fetchCandidates();
      const seen = new Set(candidates.map(ProxyManager.hostPort));
      for (const e of this.live) if (!seen.has(ProxyManager.hostPort(e.url))) { seen.add(ProxyManager.hostPort(e.url)); candidates.push(e.url); }
      if (candidates.length === 0) throw new Error('no usable entries in the source lists');

      this.progress = { phase: 'testing', tested: 0, total: candidates.length, live: 0 };
      const target = this.getProbeTarget() || 'api.openai.com';
      console.log(`[PROXY-POOL] ${reason}: validating ${candidates.length} proxies against ${target}...`);

      // Nothing to use yet (first start, no cache): hand over proxies as they
      // are found instead of after the whole sweep, which takes a few minutes
      let lastPublish = 0;
      const onFound = this.live.length ? null : (found) => {
        if (Date.now() - lastPublish < 2000 || stale()) return;
        lastPublish = Date.now();
        this.live = found.slice().sort((a, b) => a.ms - b.ms);
        this.onUpdate(this);
      };
      const live = await this.validate(candidates, target, stale, onFound);
      if (stale()) return this.getStatus(); // turned off mid-sweep - keep it empty

      this.live = live;
      this.lastTested = candidates.length;
      this.lastRefreshAt = Date.now();
      const fastest = live.length ? `${live[0].ms}ms` : 'n/a';
      console.log(`[PROXY-POOL] ${live.length} of ${candidates.length} proxies alive (${Math.round((Date.now() - startedAt) / 1000)}s, fastest ${fastest})`);
    } catch (err) {
      if (stale()) return this.getStatus();
      this.lastError = err.message;
      this.lastRefreshAt = Date.now();
      console.log(`[PROXY-POOL] Refresh failed: ${err.message}`);
    } finally {
      if (!stale()) {
        this.refreshing = false;
        this.progress = { ...this.progress, phase: 'idle' };
        this.onUpdate(this);
      }
    }

    return this.getStatus();
  }

  /** Pull every source list and turn it into deduped scheme-qualified URLs. */
  async fetchCandidates() {
    const seen = new Set();
    const out = [];
    const texts = await Promise.all(SOURCES.map((source) => ProxyPool.httpGetWithRetry(source.url).catch((err) => {
      // One source failing is survivable - carry on with whatever else loaded
      console.log(`[PROXY-POOL] Could not fetch ${source.url}: ${err.message}`);
      return '';
    })));

    SOURCES.forEach((source, i) => {
      let added = 0;
      for (const raw of texts[i].split('\n')) {
        const entry = raw.trim().replace(/^[a-z0-9]+:\/\//i, ''); // some lists write socks5://host:port
        if (!ENTRY_RE.test(entry)) continue;
        if (seen.has(entry)) continue; // same host:port in another list is the same machine
        seen.add(entry);
        out.push(`${source.scheme}://${entry}`);
        added += 1;
      }
      console.log(`[PROXY-POOL] ${new URL(source.url).pathname.split('/')[1]} ${source.scheme}: ${added} new entries`);
    });

    return out;
  }

  /**
   * Probe every candidate, `concurrency` at a time, keeping the ones that
   * answer along with how long they took - that timing seeds the rotator's
   * ranking so the first request already picks a fast proxy.
   */
  async validate(candidates, targetHost, stale = () => false, onFound = null) {
    const live = [];
    let cursor = 0;

    const worker = async () => {
      while (cursor < candidates.length) {
        const url = candidates[cursor++];
        if (stale()) return; // turned off mid-run
        const result = await this.probe(url, targetHost);
        this.progress.tested += 1;
        if (result.ok) {
          live.push({ url, ms: result.ms });
          this.progress.live += 1;
          if (onFound) onFound(live);
        }
      }
    };

    const workers = Array.from({ length: Math.min(this.concurrency, candidates.length) }, worker);
    await Promise.all(workers);

    live.sort((a, b) => a.ms - b.ms); // fastest first
    return live;
  }

  /**
   * Open the tunnel and complete the TLS handshake to `targetHost`, then hang
   * up. Resolves { ok, ms } - ms is how long tunnel + handshake took, which is
   * a fair proxy for how slow it will be under real traffic.
   */
  probe(proxyUrl, targetHost) {
    return new Promise((resolve) => {
      let settled = false;
      let socket = null;
      const startedAt = Date.now();

      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (socket) { try { socket.destroy(); } catch (e) { /* ignore */ } }
        resolve({ ok, ms: Date.now() - startedAt });
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
