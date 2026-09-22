const fs = require('fs');
const path = require('path');

const ID_WIDTH = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const DETAIL_FILE_RE = /^(\d{10})\.json$/;

/**
 * Storage for API request logs.
 *
 * Two modes, chosen by API_LOGS in .env (logging is never fully off):
 *
 *   memory  - summaries and bodies live in RAM only, capped at `memoryLimit`
 *             entries, and are gone on restart. This is the default.
 *
 *   file    - every request also gets its own file on disk holding the full
 *             request and response, kept for `retentionDays` days:
 *
 *               logs/
 *                 2026-08-30/
 *                   index.jsonl        one summary line per request
 *                   0000001849.json    that request's full record
 *
 *             Sharding by day makes retention a directory delete instead of a
 *             file rewrite, and the per-day index keeps the log list cheap to
 *             render - it never has to open the (potentially large) detail
 *             files just to draw a table row.
 */
class ApiLogStore {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.join(process.cwd(), 'logs');
    this.memoryLimit = options.memoryLimit || 100;
    this.detailMemoryLimit = options.detailMemoryLimit || 100;
    this.flushDelay = options.flushDelay != null ? options.flushDelay : 5000;
    this.pruneInterval = options.pruneInterval || 60 * 60 * 1000;

    this.settings = { mode: 'memory', retentionDays: null };

    this.buffer = [];             // recent summaries, oldest first
    this.details = new Map();     // requestId -> full detail, insertion-ordered
    this.pendingIndex = [];       // summaries awaiting an index.jsonl append
    this.flushTimer = null;
    this.pruneTimer = null;
    this.knownDays = new Set();   // day dirs already created this process
    this.storedCount = 0;         // entries currently on disk
    this.sequence = 0;            // last issued request id
  }

  /** Sequential, zero-padded, monotonic across restarts: "0000001849". */
  nextRequestId() {
    this.sequence += 1;
    return String(this.sequence).padStart(ID_WIDTH, '0');
  }

  isFileMode() {
    return this.settings.mode === 'file';
  }

  /**
   * Adopt a new API_LOGS setting. In file mode this resumes the id counter,
   * prunes expired days and refills the RAM buffer from disk, so a restart no
   * longer wipes the panel's history.
   */
  applySettings(settings) {
    const previousMode = this.settings.mode;
    this.settings = {
      mode: settings && settings.mode === 'file' ? 'file' : 'memory',
      retentionDays: settings ? settings.retentionDays : null
    };

    if (!this.isFileMode()) {
      // Memory mode: nothing may touch the disk. Drop anything queued.
      this.pendingIndex = [];
      this.clearTimer('flushTimer');
      this.clearTimer('pruneTimer', true);
      if (previousMode === 'file') {
        console.log('[LOG] API logs switched to memory only - no longer writing to disk');
      }
      return;
    }

    this.ensureDir(this.rootDir);
    this.restoreSequence();
    this.prune();
    if (previousMode !== 'file' || this.buffer.length === 0) {
      this.rehydrate();
    }
    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(() => this.prune(), this.pruneInterval);
      if (this.pruneTimer.unref) this.pruneTimer.unref();
    }
  }

  clearTimer(name, isInterval = false) {
    if (!this[name]) return;
    if (isInterval) clearInterval(this[name]);
    else clearTimeout(this[name]);
    this[name] = null;
  }

  // ---------------------------------------------------------------- writing

  /**
   * Stage the full request/response for a request. Always kept in RAM; it is
   * written to disk by record(), which fires once the summary is known.
   */
  stageDetail(requestId, detail) {
    if (!requestId) return;
    this.details.set(requestId, detail);
    while (this.details.size > this.detailMemoryLimit) {
      this.details.delete(this.details.keys().next().value);
    }
  }

  /**
   * Record a completed request. Adds the summary to the RAM buffer and, in file
   * mode, writes the one detail file for it and queues its index line.
   */
  record(summary) {
    this.buffer.push(summary);
    while (this.buffer.length > this.memoryLimit) this.buffer.shift();

    if (!this.isFileMode()) return;

    const day = ApiLogStore.dayKey(summary.timestamp);
    const detail = this.details.get(summary.requestId) || null;

    this.writeDetailFile(day, summary, detail);

    this.pendingIndex.push({ day, summary });
    this.clearTimer('flushTimer');
    this.flushTimer = setTimeout(() => this.flush(), this.flushDelay);
  }

  writeDetailFile(day, summary, detail) {
    const dir = path.join(this.rootDir, day);
    if (!this.knownDays.has(day)) {
      if (!this.ensureDir(dir)) return;
      this.knownDays.add(day);
    }

    const payload = JSON.stringify({ summary, detail: detail || null });
    fs.writeFile(path.join(dir, `${summary.requestId}.json`), payload, (err) => {
      if (err) console.log(`[LOG] Failed to write ${summary.requestId}.json: ${err.message}`);
    });
  }

  /**
   * Append queued summaries to their day's index.jsonl. Batched on a debounce so
   * a burst of requests costs one append per day instead of one per request.
   */
  flush(sync = false) {
    if (!this.isFileMode()) {
      this.pendingIndex = [];
      return;
    }
    if (this.pendingIndex.length === 0) return;

    const queued = this.pendingIndex;
    this.pendingIndex = [];
    this.clearTimer('flushTimer');

    const byDay = new Map();
    for (const { day, summary } of queued) {
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(JSON.stringify(summary));
    }

    for (const [day, lines] of byDay.entries()) {
      const dir = path.join(this.rootDir, day);
      if (!this.knownDays.has(day)) {
        if (!this.ensureDir(dir)) continue;
        this.knownDays.add(day);
      }
      const indexPath = path.join(dir, 'index.jsonl');
      const payload = lines.join('\n') + '\n';
      this.storedCount += lines.length;

      if (sync) {
        try {
          fs.appendFileSync(indexPath, payload);
        } catch (err) {
          console.log(`[LOG] Failed to write ${day}/index.jsonl: ${err.message}`);
        }
      } else {
        fs.appendFile(indexPath, payload, (err) => {
          if (err) console.log(`[LOG] Failed to write ${day}/index.jsonl: ${err.message}`);
        });
      }
    }
  }

  // ---------------------------------------------------------------- reading

  /** Most recent summaries, oldest first. Served from RAM. */
  listRecent(limit) {
    return this.buffer.slice(-limit);
  }

  /**
   * Summaries older than `beforeTs`, oldest first - the "load older" path.
   * Walks day directories newest-first and stops as soon as it has enough.
   */
  listBefore(beforeTs, limit) {
    if (!this.isFileMode() || !beforeTs) return { entries: [], hasMore: false };

    const collected = [];
    let hasMore = false;

    for (const day of this.listDays().reverse()) {
      // Skip whole days that start after the cutoff - nothing in them qualifies
      if (Date.parse(day + 'T00:00:00.000Z') > beforeTs) continue;

      const matches = this.readIndex(day).filter(entry => {
        const ts = Date.parse(entry.timestamp);
        return !isNaN(ts) && ts < beforeTs;
      });
      collected.unshift(...matches);

      if (collected.length > limit) {
        hasMore = true;
        break;
      }
    }

    return { entries: collected.slice(-limit), hasMore };
  }

  /** Full request/response for one id - RAM first, then disk. */
  getDetail(requestId) {
    if (this.details.has(requestId)) return this.details.get(requestId);
    if (!this.isFileMode() || !DETAIL_FILE_RE.test(`${requestId}.json`)) return null;

    for (const day of this.listDays().reverse()) {
      const file = path.join(this.rootDir, day, `${requestId}.json`);
      let raw;
      try {
        if (!fs.existsSync(file)) continue;
        raw = fs.readFileSync(file, 'utf8');
      } catch (err) {
        console.log(`[LOG] Failed to read ${requestId}.json: ${err.message}`);
        return null;
      }

      try {
        const record = JSON.parse(raw);
        // Requests that never produced a body (rejected before proxying) still
        // get a file - fall back to a detail view built from the summary.
        return record.detail || ApiLogStore.detailFromSummary(record.summary);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  listDays() {
    try {
      return fs.readdirSync(this.rootDir).filter(name => DAY_DIR_RE.test(name)).sort();
    } catch (err) {
      return [];
    }
  }

  readIndex(day) {
    const indexPath = path.join(this.rootDir, day, 'index.jsonl');
    let content;
    try {
      if (!fs.existsSync(indexPath)) return [];
      content = fs.readFileSync(indexPath, 'utf8');
    } catch (err) {
      console.log(`[LOG] Failed to read ${day}/index.jsonl: ${err.message}`);
      return [];
    }

    const entries = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === 'object') entries.push(entry);
      } catch (e) { /* skip malformed line */ }
    }
    return entries;
  }

  /** Refill the RAM buffer from the newest day indexes after a restart. */
  rehydrate() {
    const days = this.listDays();
    const restored = [];
    let total = 0;

    for (const day of days) total += this.readIndex(day).length;
    this.storedCount = total;

    for (const day of days.slice().reverse()) {
      restored.unshift(...this.readIndex(day));
      if (restored.length >= this.memoryLimit) break;
    }

    const live = new Set(this.buffer.map(entry => entry && entry.requestId));
    this.buffer = [...restored.filter(entry => !live.has(entry.requestId)), ...this.buffer]
      .slice(-this.memoryLimit);

    if (restored.length > 0) {
      console.log(`[LOG] Restored ${Math.min(restored.length, this.memoryLimit)} entr(ies) from ${this.rootDir} (${total} within retention)`);
    }
  }

  /** Resume the id counter from the highest id already on disk. */
  restoreSequence() {
    for (const day of this.listDays().reverse()) {
      let files;
      try {
        files = fs.readdirSync(path.join(this.rootDir, day));
      } catch (err) {
        continue;
      }

      let max = 0;
      for (const name of files) {
        const match = name.match(DETAIL_FILE_RE);
        if (match) max = Math.max(max, parseInt(match[1], 10));
      }
      if (max > 0) {
        this.sequence = Math.max(this.sequence, max);
        return;
      }
    }
  }

  // --------------------------------------------------------------- lifecycle

  /**
   * Drop day directories outside the retention window. Retention is counted in
   * whole days, so API_LOGS=7D keeps today plus the previous six days.
   */
  prune() {
    if (!this.isFileMode() || !this.settings.retentionDays) return;

    const today = new Date();
    const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const cutoff = startOfToday - (this.settings.retentionDays - 1) * DAY_MS;

    let removed = 0;
    for (const day of this.listDays()) {
      const dayTs = Date.parse(day + 'T00:00:00.000Z');
      if (isNaN(dayTs) || dayTs >= cutoff) continue;
      try {
        fs.rmSync(path.join(this.rootDir, day), { recursive: true, force: true });
        this.knownDays.delete(day);
        removed += 1;
      } catch (err) {
        console.log(`[LOG] Failed to prune ${day}: ${err.message}`);
      }
    }

    if (removed > 0) {
      console.log(`[LOG] Pruned ${removed} day(s) older than ${this.settings.retentionDays} day(s)`);
      this.storedCount = this.listDays().reduce((sum, day) => sum + this.readIndex(day).length, 0);
    }
  }

  clear() {
    this.buffer = [];
    this.details.clear();
    this.pendingIndex = [];
    this.knownDays.clear();
    this.storedCount = 0;
    this.clearTimer('flushTimer');

    try {
      fs.rmSync(this.rootDir, { recursive: true, force: true });
    } catch (err) {
      console.log(`[LOG] Failed to clear ${this.rootDir}: ${err.message}`);
    }
    if (this.isFileMode()) this.ensureDir(this.rootDir);
  }

  stop() {
    this.flush(true);
    this.clearTimer('pruneTimer', true);
  }

  ensureDir(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch (err) {
      console.log(`[LOG] Failed to create ${dir}: ${err.message}`);
      return false;
    }
  }

  // ----------------------------------------------------------------- helpers

  static dayKey(timestamp) {
    const ts = Date.parse(timestamp);
    return new Date(isNaN(ts) ? Date.now() : ts).toISOString().slice(0, 10);
  }

  /** Minimal viewer payload for requests that never produced a body. */
  static detailFromSummary(summary) {
    if (!summary) return null;
    return {
      method: summary.method,
      endpoint: summary.endpoint,
      apiType: null,
      status: summary.status,
      statusText: null,
      contentType: null,
      responseData: summary.error || '',
      requestBody: null,
      provider: summary.provider,
      proxyUsed: summary.proxyUsed,
      keyInfo: { keyUsed: summary.keyUsed, failedKeys: summary.failedKeys || [] }
    };
  }

  /**
   * Strip credentials before anything reaches the disk. Provider API keys are
   * already masked upstream, but the caller's own Authorization header carries
   * the proxy's ACCESS_KEY and must not sit in a log file for days.
   */
  static maskHeaders(headers) {
    if (!headers || typeof headers !== 'object') return {};
    const masked = {};
    for (const [key, value] of Object.entries(headers)) {
      const name = key.toLowerCase();
      if (name === 'authorization' || name === 'x-goog-api-key' || name === 'cookie') {
        masked[key] = ApiLogStore.maskSecret(String(value));
      } else {
        masked[key] = value;
      }
    }
    return masked;
  }

  static maskSecret(value) {
    return value
      .replace(/\[ACCESS_KEY:[^\]]+\]/gi, '[ACCESS_KEY:***]')
      .replace(/(Bearer\s+)([^\s\[]{4})[^\s\[]*/i, '$1$2***')
      .replace(/^(?!Bearer)([^\s\[]{4})[^\s\[]{4,}$/i, '$1***');
  }
}

module.exports = ApiLogStore;
