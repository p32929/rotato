const https = require('https');
const { URL } = require('url');
const { resolveKey, maskKey } = require('./keyValues');


// Read a (small) upstream response body in full; '' if it fails
function readBody(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => resolve(''));
  });
}

class GeminiClient {
  constructor(keyRotator, baseUrl = 'https://generativelanguage.googleapis.com', proxyManager = null) {
    this.keyRotator = keyRotator;
    this.baseUrl = baseUrl;
    this.proxyManager = proxyManager;
  }

  async makeRequest(method, path, body, headers = {}, customStatusCodes = null, streaming = false) {
    // Check if an API key was provided in headers
    const providedApiKey = headers['x-goog-api-key'];

    // If an API key was provided, use it directly without rotation
    if (providedApiKey) {
      const maskedKey = this.maskApiKey(providedApiKey);
      console.log(`[GEMINI::${maskedKey}] Using provided API key${streaming ? ' (streaming)' : ''}`);

      const cleanHeaders = { ...headers };
      delete cleanHeaders['x-goog-api-key'];

      try {
        if (streaming) {
          const response = await this._withProxyRetry((tried) => this.sendStreamingRequest(method, path, body, cleanHeaders, providedApiKey, true, tried));
          console.log(`[GEMINI::${maskedKey}] Response (${response.statusCode}) - streaming`);
          response._keyInfo = { keyUsed: maskedKey, failedKeys: [] };
          return response;
        } else {
          const response = await this._withProxyRetry((tried) => this.sendRequest(method, path, body, cleanHeaders, providedApiKey, true, tried));
          console.log(`[GEMINI::${maskedKey}] Response (${response.statusCode})`);
          response._keyInfo = { keyUsed: maskedKey, failedKeys: [] };
          return response;
        }
      } catch (error) {
        console.log(`[GEMINI::${maskedKey}] Request failed: ${error.message}`);
        throw error;
      }
    }

    // No API key provided, use rotation system
    const requestContext = this.keyRotator.createRequestContext();
    let lastError = null;
    let lastResponse = null;
    const failedKeys = []; // { key, status, reason, proxy, ms, at } - one log row each
    const usedProxies = new Set(); // a rotated key never reuses the previous key's proxy

    const rotationStatusCodes = customStatusCodes || new Set([429]);

    let apiKey;
    while ((apiKey = requestContext.getNextKey()) !== null) {
      const maskedKey = this.maskApiKey(apiKey);

      const startedAt = Date.now();
      const attempt = (status, reason, proxy) => ({ key: maskedKey, status, reason, proxy: proxy || null, ms: Date.now() - startedAt, at: new Date(startedAt).toISOString() });
      console.log(`[GEMINI::${maskedKey}] Attempting ${method} ${path}${streaming ? ' (streaming)' : ''}`);

      try {
        if (streaming) {
          const response = await this._withProxyRetry((tried) => this.sendStreamingRequest(method, path, body, headers, apiKey, false, tried), usedProxies);

          if (rotationStatusCodes.has(response.statusCode)) {
            console.log(`[GEMINI::${maskedKey}] Status ${response.statusCode} triggers rotation - trying next key`);
            // Keep the error body: if every key fails this is what the caller gets,
            // and an empty body under the upstream's content-length would hang them
            const data = await readBody(response.stream);
            requestContext.markKeyAsRateLimited(apiKey);
            failedKeys.push(attempt(response.statusCode, 'rate_limited', response.proxyUsed));
            lastResponse = { statusCode: response.statusCode, headers: response.headers, data, proxyUsed: response.proxyUsed };
            continue;
          }

          console.log(`[GEMINI::${maskedKey}] Success (${response.statusCode}) - streaming`);
          this.keyRotator.incrementKeyUsage(apiKey);
          response._keyInfo = { keyUsed: maskedKey, failedKeys };
          return response;
        } else {
          const response = await this._withProxyRetry((tried) => this.sendRequest(method, path, body, headers, apiKey, false, tried), usedProxies);

          if (rotationStatusCodes.has(response.statusCode)) {
            console.log(`[GEMINI::${maskedKey}] Status ${response.statusCode} triggers rotation - trying next key`);
            requestContext.markKeyAsRateLimited(apiKey);
            failedKeys.push(attempt(response.statusCode, 'rate_limited', response.proxyUsed));
            lastResponse = response;
            continue;
          }

          console.log(`[GEMINI::${maskedKey}] Success (${response.statusCode})`);
          this.keyRotator.incrementKeyUsage(apiKey);
          response._keyInfo = { keyUsed: maskedKey, failedKeys };
          return response;
        }
      } catch (error) {
        console.log(`[GEMINI::${maskedKey}] Request failed: ${error.message}`);
        failedKeys.push(attempt(null, error.message, error.proxyUsed));
        lastError = error;
        continue;
      }
    }

    const stats = requestContext.getStats();
    console.log(`[GEMINI] All ${stats.totalKeys} keys tried for this request. ${stats.rateLimitedKeys} were rate limited.`);

    const lastFailedKey = requestContext.getLastFailedKey();
    this.keyRotator.updateLastFailedKey(lastFailedKey);

    // Some keys rate-limited and others failed outright: the provider's real
    // answer beats a generic error
    if (requestContext.allTriedKeysRateLimited() || lastResponse) {
      console.log('[GEMINI] All keys rate limited for this request - returning 429');
      const response = lastResponse || {
        statusCode: 429,
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({
          error: {
            code: 429,
            message: 'All API keys have been rate limited for this request',
            status: 'RESOURCE_EXHAUSTED'
          }
        })
      };
      response._keyInfo = { keyUsed: null, failedKeys };
      return response;
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('All API keys exhausted without clear error');
  }

  _buildRequestOptions(method, path, body, headers, rawKey, useHeader, tried = null) {
    // A full https:// URL (a provider's custom models URL) stands in for the base URL
    const absolute = /^https:\/\//i.test(path || '');
    const baseUrl = absolute ? path : this.baseUrl;
    if (absolute) path = '';

    let fullUrl;
    if (!path || path === '/') {
      fullUrl = baseUrl;
    } else if (path.startsWith('/')) {
      let effectiveBaseUrl = baseUrl;

      const pathVersionMatch = path.match(/^\/v[^\/]+\//);
      const baseVersionMatch = baseUrl.match(/\/v[^\/]+$/);

      if (pathVersionMatch && baseVersionMatch) {
        const pathVersion = pathVersionMatch[0].slice(0, -1);
        const baseVersion = baseVersionMatch[0];

        if (pathVersion !== baseVersion) {
          effectiveBaseUrl = baseUrl.replace(baseVersion, pathVersion);
          path = path.substring(pathVersion.length);
        }
      }

      fullUrl = effectiveBaseUrl.endsWith('/') ? effectiveBaseUrl + path.substring(1) : effectiveBaseUrl + path;
    } else {
      fullUrl = baseUrl.endsWith('/') ? baseUrl + path : baseUrl + '/' + path;
    }

    // The key may carry values for {placeholders} anywhere in the URL
    const { token: apiKey, baseUrl: resolvedUrl } = resolveKey(rawKey, fullUrl);
    const url = new URL(resolvedUrl);

    const finalHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };

    if (useHeader) {
      finalHeaders['x-goog-api-key'] = apiKey;
    } else {
      url.searchParams.append('key', apiKey);
    }

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: method,
      headers: finalHeaders
    };

    if (body && method !== 'GET') {
      const bodyData = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    // Route through a rotating proxy if one is configured and enabled
    if (this.proxyManager && this.proxyManager.isEnabled()) {
      const picked = this.proxyManager.pick(tried);
      if (picked) {
        options.agent = picked.agent;
        options._proxyMasked = picked.maskedUrl;
        options._proxyUrl = picked.url;
        const known = picked.latencyMs != null ? ` (~${picked.latencyMs}ms)` : '';
        console.log(`[GEMINI] Routing request via proxy ${picked.maskedUrl}${known}`);
      } else {
        console.log(`[GEMINI] Proxy list is empty - sending this request direct`);
      }
    }

    return options;
  }

  sendRequest(method, path, body, headers, apiKey, useHeader = false, tried = null) {
    return new Promise((resolve, reject) => {
      const options = this._buildRequestOptions(method, path, body, headers, apiKey, useHeader, tried);

      const timeoutMs = this._responseTimeoutFor(options);
      let settled = false;
      let timer = null;
      let req = null;

      const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };

      // Runs until the body is fully read, so a stall part-way through the
      // response is caught too, not just a silent connect.
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stop();
        this._reportProxyOutcome(options, false, true);
        const via = options._proxyMasked ? ` via ${options._proxyMasked}` : '';
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[GEMINI::${maskedKey}] No response after ${Math.round(timeoutMs / 1000)}s${via} - abandoning`);
        if (req) req.destroy();
        const err = new Error(`Upstream did not respond within ${Math.round(timeoutMs / 1000)}s${via}`);
        err._proxyFailure = !!options._proxyUrl;
        err.proxyUsed = options._proxyMasked || null;
        reject(err);
      }, timeoutMs);

      req = https.request(options, (res) => {
        if (settled) { res.resume(); return; }
        // Decoded once at the end - per-chunk decoding garbles multi-byte characters
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));

        res.on('end', () => {
          if (settled) return;
          settled = true;
          stop();
          this._reportProxyOutcome(options, true, false, res.statusCode);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            _proxyBlocked: !!options._proxyUrl && (res.statusCode === 403 || res.statusCode === 407),
            data: Buffer.concat(chunks).toString('utf8'),
            proxyUsed: options._proxyMasked || null
          });
        });
      });

      req.on('error', (error) => {
        if (settled) return;
        settled = true;
        stop();
        this._reportProxyOutcome(options, false);
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[GEMINI::${maskedKey}] HTTP request error: ${error.message}`);
        if (options._proxyUrl) error._proxyFailure = true;
        error.proxyUsed = options._proxyMasked || null;
        reject(error);
      });

      if (body && method !== 'GET') {
        const bodyData = typeof body === 'string' ? body : JSON.stringify(body);
        req.write(bodyData);
      }

      req.end();
    });
  }

  sendStreamingRequest(method, path, body, headers, apiKey, useHeader = false, tried = null) {
    return new Promise((resolve, reject) => {
      const options = this._buildRequestOptions(method, path, body, headers, apiKey, useHeader, tried);

      const timeoutMs = this._responseTimeoutFor(options);
      let settled = false;
      let timer = null;
      let req = null;

      const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };

      // Only bounds the wait for response headers - once the stream is flowing
      // it is allowed to take as long as it needs.
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stop();
        this._reportProxyOutcome(options, false, true);
        const via = options._proxyMasked ? ` via ${options._proxyMasked}` : '';
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[GEMINI::${maskedKey}] No stream headers after ${Math.round(timeoutMs / 1000)}s${via} - abandoning`);
        if (req) req.destroy();
        const err = new Error(`Upstream did not start streaming within ${Math.round(timeoutMs / 1000)}s${via}`);
        err._proxyFailure = !!options._proxyUrl;
        err.proxyUsed = options._proxyMasked || null;
        reject(err);
      }, timeoutMs);

      req = https.request(options, (res) => {
        if (settled) { res.resume(); return; }
        settled = true;
        stop();
        this._reportProxyOutcome(options, true, false, res.statusCode);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          _proxyBlocked: !!options._proxyUrl && (res.statusCode === 403 || res.statusCode === 407),
          stream: res,
          proxyUsed: options._proxyMasked || null
        });
      });

      req.on('error', (error) => {
        if (settled) return;
        settled = true;
        stop();
        this._reportProxyOutcome(options, false);
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[GEMINI::${maskedKey}] HTTP streaming request error: ${error.message}`);
        if (options._proxyUrl) error._proxyFailure = true;
        error.proxyUsed = options._proxyMasked || null;
        reject(error);
      });

      if (body && method !== 'GET') {
        const bodyData = typeof body === 'string' ? body : JSON.stringify(body);
        req.write(bodyData);
      }

      req.end();
    });
  }

  /**
   * Feed the proxy's health back to the manager. Only connection-level results
   * count: reaching the provider at all means the proxy works, whatever status
   * code comes back.
   */
  _reportProxyOutcome(options, ok, stalled = false, statusCode = null) {
    const url = options && options._proxyUrl;
    if (!url || !this.proxyManager) return;

    if (ok) {
      // A proxy whose IP is blocked upstream answers 403/407 quickly, so pure
      // latency ranking would promote it to the front of the rotation. Treat it
      // as a strike instead - three of them and it is benched. Not immediate,
      // in case the provider itself is genuinely rejecting the request.
      if (statusCode === 403 || statusCode === 407) {
        console.log(`[GEMINI] Proxy ${options._proxyMasked} got HTTP ${statusCode} - likely blocked upstream`);
        this.proxyManager.reportFailure(url);
        return;
      }
      this.proxyManager.reportSuccess(url);
    } else {
      // A stall is conclusive - don't leave it in rotation for two more hangs
      this.proxyManager.reportFailure(url, stalled);
    }
  }

  /**
   * Upper bound on a request. Without this a proxy that accepts the tunnel and
   * then stops forwarding hangs the caller forever. Proxied requests get a
   * tighter bound, since a silent proxy is far more likely than a provider
   * genuinely taking that long.
   */
  /**
   * Retry through a different proxy before giving up on the key. Key rotation
   * alone doesn't cover this: with a single API key one bad proxy would fail
   * the whole request, which is the common case for a free-proxy pool where
   * entries die constantly. Each attempt re-picks, so it lands on the next
   * fastest proxy - and the dead one has already been benched by then.
   */
  async _withProxyRetry(send, tried = new Set()) {
    // Like key rotation, but for proxies: each attempt takes a different random
    // green proxy (never one this request already tried, across all its keys),
    // up to maxTries of them.
    const maxTries = (this.proxyManager && this.proxyManager.maxTries) || 1;
    // Just after a start the list may still be loading: wait for it, don't go direct
    if (this.proxyManager) await this.proxyManager.waitForProxies();
    let attempt = 1;
    for (;;) {
      const more = () => attempt < maxTries && this.proxyManager && this.proxyManager.isEnabled();
      let response;
      try {
        response = await send(tried);
      } catch (error) {
        if (!(error && error._proxyFailure && more())) throw error;
        console.log(`[GEMINI] Proxy attempt ${attempt}/${maxTries} failed - trying the same key through another proxy`);
        attempt += 1;
        continue;
      }
      // 403/407 through a proxy usually means the provider blocks that IP: try the
      // next proxy. If they all get it, the provider's answer is passed on.
      if (response._proxyBlocked && more()) {
        if (response.stream) response.stream.destroy();
        console.log(`[GEMINI] Proxy attempt ${attempt}/${maxTries} got HTTP ${response.statusCode} - trying the same key through another proxy`);
        attempt += 1;
        continue;
      }
      return response;
    }
  }


  _responseTimeoutFor(options) {
    return options._proxyUrl
      ? GeminiClient.PROXIED_TIMEOUT_MS
      : GeminiClient.DIRECT_TIMEOUT_MS;
  }

  maskApiKey(key) {
    return maskKey(key);
  }
}

// A provider can legitimately take a while to answer a large non-streaming
// completion, so the direct bound is generous. Through a proxy, silence is far
// more likely to mean a dead proxy than a slow provider.
GeminiClient.DIRECT_TIMEOUT_MS = 120000;
GeminiClient.PROXIED_TIMEOUT_MS = 60000;

module.exports = GeminiClient;