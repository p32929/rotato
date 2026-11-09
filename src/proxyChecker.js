/**
 * Keeps the proxy list fresh.
 *
 * Every couple of minutes it walks the list (least recently checked first) and:
 *   1. handshake-checks every proxy: tunnel + TLS handshake to a provider's
 *      host, then hang up - no request, no API key. This is the only thing
 *      that sets a proxy's speed, so proxies move between green and red and
 *      the list re-sorts. A benched proxy that passes is back in play at once.
 *      It runs under traffic too: real requests never use red proxies, so
 *      without it a proxy that turned red during a burst would stay red.
 *   2. while idle only, lists models through green proxies, each at most once
 *      per modelEveryMs, one call every modelGapMs, taking turns across the
 *      providers routed through the proxy and their keys. Listing models is
 *      free, and unlike a handshake it catches a provider blocking the proxy's
 *      IP. It stops the moment real traffic shows up.
 *
 * A fetched proxy that fails DEAD_AFTER checks in a row is dropped (onDead):
 * free proxies die for good all the time, and keeping them as "red" hides how
 * many actually work. The next sweep brings it back if it revives. After each
 * pass, too few green asks for a rescue and a fresh list (onPoolExhausted).
 *
 * checkAll() is the panel's Refresh for proxies a sweep doesn't cover (yours).
 *
 * The one exception is rescue(): when green proxies run short during traffic,
 * red and benched ones get an immediate handshake check (no API calls), so
 * proxies that were only slow under load come back instead of requests going
 * direct.
 */
class ProxyChecker {
  constructor(options) {
    this.getManager = options.getManager;   // () => current ProxyManager
    this.probe = options.probe;             // (proxyUrl, host) => Promise<{ ok, ms }>
    this.getTargets = options.getTargets;   // () => hostnames of proxied providers
    this.modelCheck = options.modelCheck;   // (proxyUrl) => Promise<void>, reports its own outcome
    this.onDead = options.onDead || (() => {}); // (urls) => void, fetched proxies that stopped answering

    this.intervalMs = options.intervalMs || 2 * 60 * 1000;
    this.idleMs = options.idleMs || 30 * 1000;
    this.concurrency = options.concurrency || 50;
    this.modelEveryMs = options.modelEveryMs || 10 * 60 * 1000;
    this.modelGapMs = options.modelGapMs != null ? options.modelGapMs : 3000;

    this.rescueEveryMs = options.rescueEveryMs != null ? options.rescueEveryMs : 60 * 1000;
    this.rescueTarget = options.rescueTarget || 10; // stop once this many are green

    this.timer = null;
    this.running = false;
    this.rescuing = false;
    this.lastRescueAt = 0;
    this.checkProgress = { running: false, done: 0, total: 0, ok: 0, failed: 0 };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.cycle(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isIdle(manager) {
    return Date.now() - manager.lastPickAt > this.idleMs;
  }

  async cycle() {
    const manager = this.getManager();
    if (this.running || !manager || !manager.isEnabled()) return;
    const targets = this.getTargets();
    if (!targets.length) return;

    this.running = true;
    // Handshakes stop only if the settings were reloaded; model calls also wait for quiet
    const current = () => this.timer && this.getManager() === manager;
    const go = () => current() && this.isIdle(manager);
    let ok = 0, failed = 0, models = 0;
    try {
      ({ ok, failed } = await this.handshakePass(manager, manager.proxyUrls, targets, current));
      if (ok + failed) {
        const dropped = this.dropDead(manager);
        const stats = manager.getStats();
        console.log(`[PROXY-CHECK] Handshake pass: ${ok} ok, ${failed} failed${dropped ? `, ${dropped} dead dropped` : ''} - ${stats.green} green, ${stats.red} red, ${stats.benched} benched`);
        if (current() && manager.isRunningLow()) manager.notifyExhausted();
      }

      const due = manager.getGreen().filter((url) => {
        const entry = manager.health.get(url);
        return !entry || Date.now() - (entry.modelCheckedAt || 0) > this.modelEveryMs;
      });
      for (const url of due) {
        if (!go()) break;
        manager._entry(url).modelCheckedAt = Date.now();
        await this.modelCheck(url);
        models++;
        if (this.modelGapMs) await new Promise((r) => setTimeout(r, this.modelGapMs));
      }
    } finally {
      this.running = false;
    }
    if (models) {
      const stats = manager.getStats();
      console.log(`[PROXY-CHECK] Models pass: ${models} checked - ${stats.green} green, ${stats.red} red, ${stats.benched} benched`);
    }
  }

  async handshakePass(manager, urls, targets, go, progress = null) {
    // Least recently checked first, `concurrency` at a time, until done or go() says stop
    const checkedAt = (url) => (manager.health.get(url) || {}).checkedAt || 0;
    const queue = urls.slice().sort((a, b) => checkedAt(a) - checkedAt(b));
    let n = 0, ok = 0, failed = 0;
    const worker = async () => {
      while (queue.length && go()) {
        const url = queue.shift();
        const result = await this.probe(url, targets[n++ % targets.length]);
        if (!go()) return;
        if (result.ok) { manager.recordCheck(url, result.ms); ok++; } else {
          manager.reportFailure(url);
          const entry = manager._entry(url);
          entry.checkFails = (entry.checkFails || 0) + 1;
          failed++;
        }
        if (progress) Object.assign(progress, { done: ok + failed, ok, failed });
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));
    return { ok, failed };
  }

  /** Fetched proxies that failed their last DEAD_AFTER checks leave the list. Returns how many. */
  dropDead(manager) {
    const dead = manager.autoUrls.filter((u) => ((manager.health.get(u) || {}).checkFails || 0) >= ProxyChecker.DEAD_AFTER);
    if (dead.length) { manager.removeAuto(dead); this.onDead(dead); }
    return dead.length;
  }

  /** Handshake-check proxies now (all of them by default), idle or not. checkProgress follows it. */
  async checkAll(fallbackTarget, only = null) {
    if (this.checkProgress.running) return this.checkProgress;
    const manager = this.getManager();
    const urls = only || (manager ? manager.proxyUrls : []);
    const targets = this.getTargets();
    if (!targets.length && fallbackTarget) targets.push(fallbackTarget);
    this.checkProgress = { running: true, done: 0, total: urls.length, ok: 0, failed: 0 };
    try {
      if (urls.length && targets.length) {
        await this.handshakePass(manager, urls, targets, () => this.getManager() === manager, this.checkProgress);
        const stats = manager.getStats();
        console.log(`[PROXY-CHECK] Checked ${urls.length}: ${this.checkProgress.ok} ok, ${this.checkProgress.failed} failed - ${stats.green} green, ${stats.red} red, ${stats.benched} benched`);
      }
    } finally {
      this.checkProgress.running = false;
    }
    return this.checkProgress;
  }

  /** Green is running out: re-check the red and benched ones right away, even under traffic. */
  async rescue() {
    const manager = this.getManager();
    if (!this.timer || this.rescuing || !manager || !manager.isEnabled()) return;
    if (Date.now() - this.lastRescueAt < this.rescueEveryMs) return;
    const targets = this.getTargets();
    if (!targets.length) return;

    this.rescuing = true;
    this.lastRescueAt = Date.now();
    const enoughGreen = () => manager.getGreen().length >= this.rescueTarget;
    const go = () => this.timer && this.getManager() === manager && !enoughGreen();
    try {
      const notGreen = manager.proxyUrls.filter((url) => !manager.isGreen(url));
      const { ok, failed } = await this.handshakePass(manager, notGreen, targets, go);
      console.log(`[PROXY-CHECK] Green ran low - rescue checked ${ok + failed} (${ok} ok): now ${manager.getGreen().length} green`);
    } finally {
      this.rescuing = false;
    }
  }
}

ProxyChecker.DEAD_AFTER = 2;

module.exports = ProxyChecker;
