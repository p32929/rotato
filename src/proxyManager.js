const net = require('net');
const tls = require('tls');
const https = require('https');
const { URL } = require('url');

/**
 * Proxy support with ZERO external dependencies.
 *
 * Supports three proxy types, auto-detected from the URL scheme:
 *   - HTTP/HTTPS proxies via the CONNECT tunneling method
 *       http://[user:pass@]host:port   https://[user:pass@]host:port
 *   - SOCKS5 proxies (with optional username/password auth)
 *       socks5://[user:pass@]host:port  (socks5h:// is treated the same)
 *   - SOCKS4/4a proxies (no authentication in the protocol)
 *       socks4://host:port              (socks4a:// is treated the same)
 *
 * The upstream target is always reached over TLS (all provider clients use
 * https.request), so after the tunnel is established the socket is wrapped in
 * a TLS session to the target host.
 *
 * ProxyManager holds a list of proxies and rotates through them per request
 * (round-robin), mirroring how KeyRotator rotates API keys.
 */

function splitAuth(auth) {
  const i = auth.indexOf(':');
  if (i === -1) return [auth, ''];
  return [auth.slice(0, i), auth.slice(i + 1)];
}

/**
 * Parse a proxy URL into its parts. Throws on an unusable URL.
 * A bare `host:port` (no scheme) is assumed to be an HTTP proxy.
 */
function parseProxyUrl(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Empty proxy URL');
  }
  let s = raw.trim();
  if (!/^[a-z0-9]+:\/\//i.test(s)) {
    s = 'http://' + s;
  }

  const u = new URL(s);
  const scheme = u.protocol.replace(':', '').toLowerCase();

  let type;
  if (scheme === 'socks5' || scheme === 'socks' || scheme === 'socks5h') {
    type = 'socks5';
  } else if (scheme === 'socks4' || scheme === 'socks4a') {
    type = 'socks4';
  } else if (scheme === 'http' || scheme === 'https') {
    type = 'http';
  } else {
    throw new Error(`Unsupported proxy scheme "${scheme}" (use http, https, socks4, or socks5)`);
  }

  if (!u.hostname) {
    throw new Error('Proxy URL is missing a host');
  }

  const auth = u.username
    ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`
    : null;

  const defaultPort = (type === 'socks5' || type === 'socks4') ? 1080 : (u.protocol === 'https:' ? 443 : 80);

  return {
    type,
    protocol: u.protocol, // 'http:' | 'https:' | 'socks5:'
    hostname: u.hostname,
    port: parseInt(u.port, 10) || defaultPort,
    auth,
  };
}

/**
 * Establish a TCP (or TLS, for an https proxy) connection to the proxy and
 * open a CONNECT tunnel to targetHost:targetPort. Calls cb(err, socket) with a
 * raw duplex socket that is tunneled to the target (not yet TLS-wrapped).
 */
/**
 * Arm a connect-phase timeout on a tunnel socket. Without this a black-holed
 * proxy stalls the request until the OS TCP timeout (over a minute), which
 * matters a lot once the pool is full of unreliable free proxies.
 */
function armTimeout(socket, proxy, finish) {
  const ms = proxy.timeoutMs || 0;
  if (!ms) return;
  socket.setTimeout(ms, () => {
    finish(new Error(`Proxy connect timed out after ${ms}ms`));
    socket.destroy();
  });
}

function connectHttp(proxy, targetHost, targetPort, cb) {
  let settled = false;
  const finish = (err, socket) => {
    if (socket) socket.setTimeout(0);
    if (settled) return;
    settled = true;
    cb(err, err ? undefined : socket);
  };

  const onReady = () => {
    const lines = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`,
    ];
    if (proxy.auth) {
      const encoded = Buffer.from(proxy.auth).toString('base64');
      lines.push(`Proxy-Authorization: Basic ${encoded}`);
    }
    lines.push('Connection: keep-alive', '', '');
    socket.write(lines.join('\r\n'));
  };

  const connectOpts = { host: proxy.hostname, port: proxy.port };
  const socket = proxy.protocol === 'https:'
    ? tls.connect({ ...connectOpts, servername: proxy.hostname }, onReady)
    : net.connect(connectOpts, onReady);

  socket.once('error', (err) => finish(err));
  armTimeout(socket, proxy, finish);

  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return; // wait for the full status/header block

    socket.removeListener('data', onData);
    const header = buffer.slice(0, headerEnd).toString('utf8');
    const statusLine = header.split('\r\n')[0];
    const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/);
    const status = match ? parseInt(match[1], 10) : 0;

    if (status === 200) {
      const leftover = buffer.slice(headerEnd + 4);
      if (leftover.length > 0) socket.unshift(leftover);
      finish(null, socket);
    } else {
      finish(new Error(`Proxy CONNECT rejected: ${statusLine || 'no response'}`));
      socket.destroy();
    }
  };
  socket.on('data', onData);
}

/**
 * Perform a SOCKS5 handshake against the proxy and open a connection to
 * targetHost:targetPort. Calls cb(err, socket) with the raw tunneled socket.
 */
function connectSocks5(proxy, targetHost, targetPort, cb) {
  let settled = false;
  const finish = (err, socket) => {
    if (socket) socket.setTimeout(0);
    if (settled) return;
    settled = true;
    cb(err, err ? undefined : socket);
  };

  const socket = net.connect({ host: proxy.hostname, port: proxy.port });
  socket.once('error', (err) => finish(err));
  armTimeout(socket, proxy, finish);

  const [user, pass] = proxy.auth ? splitAuth(proxy.auth) : [null, null];
  let stage = 'greeting';
  let buffer = Buffer.alloc(0);

  const sendConnect = () => {
    const hostBuf = Buffer.from(targetHost, 'utf8');
    const req = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
      hostBuf,
      Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    ]);
    stage = 'reply';
    socket.write(req);
  };

  socket.once('connect', () => {
    if (user != null) {
      socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02])); // offer no-auth + user/pass
    } else {
      socket.write(Buffer.from([0x05, 0x01, 0x00])); // offer no-auth only
    }
  });

  const process = () => {
    if (stage === 'greeting') {
      if (buffer.length < 2) return;
      const method = buffer[1];
      buffer = buffer.slice(2);
      if (method === 0x00) {
        sendConnect();
      } else if (method === 0x02) {
        if (user == null) {
          finish(new Error('SOCKS5 proxy requires authentication but none was provided'));
          socket.destroy();
          return;
        }
        const u = Buffer.from(user, 'utf8');
        const p = Buffer.from(pass || '', 'utf8');
        const authReq = Buffer.concat([
          Buffer.from([0x01, u.length]), u,
          Buffer.from([p.length]), p,
        ]);
        stage = 'auth';
        socket.write(authReq);
      } else {
        finish(new Error('SOCKS5 proxy rejected all offered auth methods'));
        socket.destroy();
        return;
      }
      if (buffer.length > 0) process();
      return;
    }

    if (stage === 'auth') {
      if (buffer.length < 2) return;
      const statusByte = buffer[1];
      buffer = buffer.slice(2);
      if (statusByte !== 0x00) {
        finish(new Error('SOCKS5 authentication failed'));
        socket.destroy();
        return;
      }
      sendConnect();
      if (buffer.length > 0) process();
      return;
    }

    if (stage === 'reply') {
      if (buffer.length < 4) return;
      const rep = buffer[1];
      const atyp = buffer[3];
      let addrLen;
      if (atyp === 0x01) addrLen = 4;
      else if (atyp === 0x04) addrLen = 16;
      else if (atyp === 0x03) {
        if (buffer.length < 5) return;
        addrLen = 1 + buffer[4];
      } else {
        finish(new Error(`SOCKS5 reply had unknown address type ${atyp}`));
        socket.destroy();
        return;
      }
      const totalLen = 4 + addrLen + 2;
      if (buffer.length < totalLen) return;

      if (rep !== 0x00) {
        finish(new Error(`SOCKS5 connect failed (reply code ${rep})`));
        socket.destroy();
        return;
      }
      const leftover = buffer.slice(totalLen);
      socket.removeListener('data', onData);
      if (leftover.length > 0) socket.unshift(leftover);
      finish(null, socket);
    }
  };

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    process();
  };
  socket.on('data', onData);
}

/**
 * Perform a SOCKS4 (or SOCKS4a) handshake and open a connection to
 * targetHost:targetPort. Calls cb(err, socket) with the raw tunneled socket.
 *
 * SOCKS4 is a far simpler exchange than SOCKS5 - one request, one 8-byte reply -
 * and has no authentication at all, so the userid field is sent empty. Plain
 * SOCKS4 can only address an IPv4 destination; the SOCKS4a extension signals "a
 * hostname follows" by sending an otherwise-invalid 0.0.0.x address. We connect
 * to providers by name, so that is the path used unless the target is a literal
 * IPv4. Proxies that only speak plain SOCKS4 reject it, which is one reason a
 * chunk of any public socks4 list will never validate.
 */
function connectSocks4(proxy, targetHost, targetPort, cb) {
  let settled = false;
  const finish = (err, socket) => {
    if (socket) socket.setTimeout(0);
    if (settled) return;
    settled = true;
    cb(err, err ? undefined : socket);
  };

  const socket = net.connect({ host: proxy.hostname, port: proxy.port });
  socket.once('error', (err) => finish(err));
  armTimeout(socket, proxy, finish);

  socket.once('connect', () => {
    const portBuf = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
    const userIdTerminator = Buffer.from([0x00]); // empty userid
    const isIpv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(targetHost);

    let req;
    if (isIpv4) {
      const ip = Buffer.from(targetHost.split('.').map((n) => parseInt(n, 10) & 0xff));
      req = Buffer.concat([Buffer.from([0x04, 0x01]), portBuf, ip, userIdTerminator]);
    } else {
      const host = Buffer.from(targetHost, 'utf8');
      req = Buffer.concat([
        Buffer.from([0x04, 0x01]),
        portBuf,
        Buffer.from([0x00, 0x00, 0x00, 0x01]), // 0.0.0.1 -> SOCKS4a, hostname follows
        userIdTerminator,
        host,
        Buffer.from([0x00]),
      ]);
    }
    socket.write(req);
  });

  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 8) return; // the reply is always exactly 8 bytes

    socket.removeListener('data', onData);
    const code = buffer[1];
    if (code !== 0x5a) {
      const reason = {
        0x5b: 'request rejected or failed',
        0x5c: 'client is not running identd',
        0x5d: 'identd could not confirm the user id',
      }[code] || `reply code 0x${code.toString(16)}`;
      finish(new Error(`SOCKS4 connect failed (${reason})`));
      socket.destroy();
      return;
    }

    const leftover = buffer.slice(8);
    if (leftover.length > 0) socket.unshift(leftover);
    finish(null, socket);
  };
  socket.on('data', onData);
}

/**
 * An https.Agent that routes every connection through a single proxy.
 * https.request calls createConnection() for us; we build the tunnel, then
 * TLS-wrap it to the target host and hand the secure socket back.
 */
class ProxyAgent extends https.Agent {
  constructor(proxyUrl, options = {}) {
    super({ ...options, keepAlive: false, maxSockets: Infinity });
    this.proxy = parseProxyUrl(proxyUrl);
    this.proxy.timeoutMs = options.proxyTimeoutMs != null
      ? options.proxyTimeoutMs
      : ProxyAgent.DEFAULT_TIMEOUT_MS;
  }

  createConnection(options, callback) {
    const targetHost = options.host || options.hostname;
    const targetPort = parseInt(options.port, 10) || 443;

    const onTunnel = (err, rawSocket) => {
      if (err) return callback(err);
      const tlsOptions = {
        host: targetHost,
        servername: options.servername || targetHost,
        socket: rawSocket,
      };
      // Forward standard TLS options from the request so custom CAs and
      // rejectUnauthorized behave the same as a direct https.request.
      for (const k of ['rejectUnauthorized', 'ca', 'cert', 'key', 'passphrase', 'pfx', 'ciphers', 'secureProtocol', 'ALPNProtocols']) {
        if (options[k] !== undefined) tlsOptions[k] = options[k];
      }
      const tlsSocket = tls.connect(tlsOptions, () => callback(null, tlsSocket));
      tlsSocket.once('error', (e) => callback(e));
    };

    if (this.proxy.type === 'socks5') {
      connectSocks5(this.proxy, targetHost, targetPort, onTunnel);
    } else if (this.proxy.type === 'socks4') {
      connectSocks4(this.proxy, targetHost, targetPort, onTunnel);
    } else {
      connectHttp(this.proxy, targetHost, targetPort, onTunnel);
    }
  }
}

ProxyAgent.DEFAULT_TIMEOUT_MS = 15000;

class ProxyManager {
  constructor(proxyUrls = [], enabled = false) {
    this.manualUrls = ProxyManager.normalize(proxyUrls);
    this.autoUrls = [];                 // fetched pool, in memory only
    this.enabled = !!enabled;
    this.rotationIndex = 0;
    this._agentCache = new Map();

    // Circuit breaker. Free proxies die constantly, so a proxy that keeps
    // failing is benched for a while rather than deleted - it gets another
    // chance later instead of being lost for good.
    this.health = new Map();            // url -> { fails, deadUntil }
    this.maxFailures = 3;
    this.benchMs = 10 * 60 * 1000;

    // Set by the server: called when every proxy is benched, so an auto pool
    // can go and fetch a fresh batch.
    this.onPoolExhausted = null;
  }

  static normalize(urls) {
    return (Array.isArray(urls) ? urls : [])
      .map((u) => (u || '').trim())
      .filter((u) => u.length > 0);
  }

  /** Manual proxies first, then the auto-fetched ones. */
  get proxyUrls() {
    return [...this.manualUrls, ...this.autoUrls];
  }

  /** Replace the auto-fetched half of the pool. Manual entries are untouched. */
  setAutoProxies(urls) {
    const next = ProxyManager.normalize(urls);
    const keep = new Set(next);
    // Forget health for proxies that are no longer in the pool
    for (const url of [...this.health.keys()]) {
      if (!keep.has(url) && !this.manualUrls.includes(url)) this.health.delete(url);
    }
    this.autoUrls = next.filter((u) => !this.manualUrls.includes(u));
  }

  getAutoProxies() {
    return [...this.autoUrls];
  }

  isEnabled() {
    return this.enabled && this.proxyUrls.length > 0;
  }

  /** True while this proxy is serving out its penalty for repeated failures. */
  isBenched(url) {
    const entry = this.health.get(url);
    return !!(entry && entry.deadUntil && entry.deadUntil > Date.now());
  }

  getUsable() {
    return this.proxyUrls.filter((url) => !this.isBenched(url));
  }

  getProxyUrls() {
    return this.proxyUrls;
  }

  getAgentFor(proxyUrl) {
    if (!this._agentCache.has(proxyUrl)) {
      this._agentCache.set(proxyUrl, new ProxyAgent(proxyUrl));
    }
    return this._agentCache.get(proxyUrl);
  }

  /** A proxy worked - clear whatever failures it had accumulated. */
  reportSuccess(proxyUrl) {
    if (proxyUrl) this.health.delete(proxyUrl);
  }

  /**
   * A proxy failed to carry a request. Only connection-level failures should
   * land here - an HTTP error from the provider is not the proxy's fault and
   * must not get a working proxy benched.
   */
  reportFailure(proxyUrl) {
    if (!proxyUrl) return;

    const entry = this.health.get(proxyUrl) || { fails: 0, deadUntil: 0 };
    entry.fails += 1;

    if (entry.fails >= this.maxFailures) {
      entry.deadUntil = Date.now() + this.benchMs;
      entry.fails = 0;
      console.log(`[PROXY] ${ProxyManager.maskProxyUrl(proxyUrl)} benched for ${Math.round(this.benchMs / 60000)}m after ${this.maxFailures} consecutive failures`);
    }
    this.health.set(proxyUrl, entry);

    if (this.getUsable().length === 0) this.notifyExhausted();
  }

  notifyExhausted() {
    if (typeof this.onPoolExhausted === 'function') {
      try {
        this.onPoolExhausted();
      } catch (e) {
        console.log(`[PROXY] Pool refresh hook failed: ${e.message}`);
      }
    }
  }

  /**
   * Round-robin pick the next usable proxy. Returns
   * { url, maskedUrl, agent, index } or null when disabled, empty, or when
   * every proxy is currently benched - in which case the request goes direct
   * and a pool refresh is requested.
   */
  pick() {
    if (!this.isEnabled()) return null;

    const usable = this.getUsable();
    if (usable.length === 0) {
      this.notifyExhausted();
      return null;
    }

    const index = this.rotationIndex % usable.length;
    this.rotationIndex = (this.rotationIndex + 1) % usable.length;
    const url = usable[index];
    return {
      url,
      index,
      maskedUrl: ProxyManager.maskProxyUrl(url),
      agent: this.getAgentFor(url),
    };
  }

  /** Counts for the admin panel. */
  getStats() {
    const benched = this.proxyUrls.filter((url) => this.isBenched(url));
    return {
      total: this.proxyUrls.length,
      manual: this.manualUrls.length,
      auto: this.autoUrls.length,
      usable: this.getUsable().length,
      benched: benched.length,
    };
  }

  static parse(proxyUrl) {
    return parseProxyUrl(proxyUrl);
  }

  static createAgent(proxyUrl, options = {}) {
    return new ProxyAgent(proxyUrl, options);
  }

  /** Hide credentials when a proxy URL is shown in logs or the UI. */
  static maskProxyUrl(raw) {
    try {
      const p = parseProxyUrl(raw);
      const cred = p.auth ? '***:***@' : '';
      return `${p.protocol}//${cred}${p.hostname}:${p.port}`;
    } catch (e) {
      return raw;
    }
  }
}

module.exports = ProxyManager;
module.exports.ProxyAgent = ProxyAgent;
module.exports.parseProxyUrl = parseProxyUrl;
