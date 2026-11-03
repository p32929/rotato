const fs = require('fs');
const path = require('path');

/**
 * The fetched proxy list and what the checks have learned about each proxy
 * (speed, strikes, bench), kept on disk so a restart doesn't start from an
 * empty list. Some free hosts kill the server every so often; without this,
 * every restart meant a minute of proxied providers going direct while the
 * list was fetched and checked again.
 *
 * One JSON file, written atomically (temp file + rename) so a kill mid-write
 * can't leave it half written. Gitignored.
 */
const FILE = 'proxy-cache.json';

function cachePath() {
  return path.join(process.cwd(), FILE);
}

/** { lastRefreshAt, lastTested, live: [{url, ms}], health: {url: entry} } or null */
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    if (!data || !Array.isArray(data.live) || typeof data.health !== 'object') return null;
    return data;
  } catch (e) {
    return null; // missing or unreadable: start fresh
  }
}

/** Returns the JSON written, so callers can skip writes when nothing changed. */
function save(pool, manager, lastJson = null) {
  const json = JSON.stringify({
    lastRefreshAt: pool.lastRefreshAt,
    lastTested: pool.lastTested,
    live: pool.live,
    health: Object.fromEntries(manager.health),
  });
  if (json === lastJson) return json;
  const file = cachePath();
  try {
    fs.writeFileSync(`${file}.tmp`, json);
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.log(`[PROXY-CACHE] Could not save ${FILE}: ${err.message}`);
  }
  return json;
}

module.exports = { load, save, FILE };
