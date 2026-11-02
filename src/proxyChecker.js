/**
 * Keeps the proxy list fresh while rotato is idle.
 *
 * Every couple of minutes, if no proxied request has gone out for a while, it
 * walks the list (least recently checked first) and:
 *   1. handshake-checks every proxy: tunnel + TLS handshake to a provider's
 *      host, then hang up - no request, no API key. The timing feeds the live
 *      average, so proxies move between green and red and the list re-sorts.
 *      A benched proxy that passes is back in play at once.
 *   2. lists models through green proxies, each at most once per
 *      modelEveryMs, one call every modelGapMs, taking turns across the
 *      providers routed through the proxy and their keys. Listing models is free,
 *      and unlike a handshake it catches a provider blocking the proxy's IP.
 *
 * It stops the moment real traffic shows up, so it never competes with it.
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

    this.intervalMs = options.intervalMs || 2 * 60 * 1000;
    this.idleMs = options.idleMs || 30 * 1000;
    this.concurrency = options.concurrency || 10;
    this.modelEveryMs = options.modelEveryMs || 10 * 60 * 1000;
    this.modelGapMs = options.modelGapMs != null ? options.modelGapMs : 3000;

    this.rescueEveryMs = options.rescueEveryMs != null ? options.rescueEveryMs : 60 * 1000;
    this.rescueTarget = options.rescueTarget || 10; // stop once this many are green

    this.timer = null;
    this.running = false;
    this.rescuing = false;
    this.lastRescueAt = 0;
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
    if (this.running || !manager || !manager.isEnabled() || !this.isIdle(manager)) return;
    const targets = this.getTargets();
    if (!targets.length) return;

    this.running = true;
    // Stop as soon as traffic arrives or the settings were reloaded
    const go = () => this.timer && this.getManager() === manager && this.isIdle(manager);
    let ok = 0, failed = 0, models = 0;
    try {
      ({ ok, failed } = await this.handshakePass(manager, manager.proxyUrls, targets, go));
      if (ok + failed) {
        const stats = manager.getStats();
        console.log(`[PROXY-CHECK] Handshake pass: ${ok} ok, ${failed} failed - ${stats.green} green, ${stats.red} red, ${stats.benched} benched`);
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

  async handshakePass(manager, urls, targets, go) {
    // Least recently checked first, `concurrency` at a time, until done or go() says stop
    const checkedAt = (url) => (manager.health.get(url) || {}).checkedAt || 0;
    const queue = urls.slice().sort((a, b) => checkedAt(a) - checkedAt(b));
    let n = 0, ok = 0, failed = 0;
    const worker = async () => {
      while (queue.length && go()) {
        const url = queue.shift();
        const result = await this.probe(url, targets[n++ % targets.length]);
        if (!go()) return;
        if (result.ok) { manager.recordCheck(url, result.ms); ok++; } else { manager.reportFailure(url); failed++; }
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));
    return { ok, failed };
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

module.exports = ProxyChecker;
