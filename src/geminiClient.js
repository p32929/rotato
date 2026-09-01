const https = require('https');
const { URL } = require('url');

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
          const response = await this._withProxyRetry(() => this.sendStreamingRequest(method, path, body, cleanHeaders, providedApiKey, true));
          console.log(`[GEMINI::${maskedKey}] Response (${response.statusCode}) - streaming`);
          response._keyInfo = { keyUsed: maskedKey, failedKeys: [] };
          return response;
        } else {
          const response = await this._withProxyRetry(() => this.sendRequest(method, path, body, cleanHeaders, providedApiKey, true));
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
    const failedKeys = [];

    const rotationStatusCodes = customStatusCodes || new Set([429]);

    let apiKey;
    while ((apiKey = requestContext.getNextKey()) !== null) {
      const maskedKey = this.maskApiKey(apiKey);

      console.log(`[GEMINI::${maskedKey}] Attempting ${method} ${path}${streaming ? ' (streaming)' : ''}`);

      try {
        if (streaming) {
          const response = await this._withProxyRetry(() => this.sendStreamingRequest(method, path, body, headers, apiKey, false));

          if (rotationStatusCodes.has(response.statusCode)) {
            console.log(`[GEMINI::${maskedKey}] Status ${response.statusCode} triggers rotation - trying next key`);
            response.stream.resume();
            requestContext.markKeyAsRateLimited(apiKey);
            failedKeys.push({ key: maskedKey, status: response.statusCode, reason: 'rate_limited' });
            lastResponse = { statusCode: response.statusCode, headers: response.headers, data: '' };
            continue;
          }

          console.log(`[GEMINI::${maskedKey}] Success (${response.statusCode}) - streaming`);
          this.keyRotator.incrementKeyUsage(apiKey);
          response._keyInfo = { keyUsed: maskedKey, failedKeys };
          return response;
        } else {
          const response = await this._withProxyRetry(() => this.sendRequest(method, path, body, headers, apiKey, false));

          if (rotationStatusCodes.has(response.statusCode)) {
            console.log(`[GEMINI::${maskedKey}] Status ${response.statusCode} triggers rotation - trying next key`);
            requestContext.markKeyAsRateLimited(apiKey);
            failedKeys.push({ key: maskedKey, status: response.statusCode, reason: 'rate_limited' });
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
        failedKeys.push({ key: maskedKey, status: null, reason: error.message });
        lastError = error;
        continue;
      }
    }

    const stats = requestContext.getStats();
    console.log(`[GEMINI] All ${stats.totalKeys} keys tried for this request. ${stats.rateLimitedKeys} were rate limited.`);

    const lastFailedKey = requestContext.getLastFailedKey();
    this.keyRotator.updateLastFailedKey(lastFailedKey);

    if (requestContext.allTriedKeysRateLimited()) {
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

  _buildRequestOptions(method, path, body, headers, apiKey, useHeader) {
    let fullUrl;
    if (!path || path === '/') {
      fullUrl = this.baseUrl;
    } else if (path.startsWith('/')) {
      let effectiveBaseUrl = this.baseUrl;

      const pathVersionMatch = path.match(/^\/v[^\/]+\//);
      const baseVersionMatch = this.baseUrl.match(/\/v[^\/]+$/);

      if (pathVersionMatch && baseVersionMatch) {
        const pathVersion = pathVersionMatch[0].slice(0, -1);
        const baseVersion = baseVersionMatch[0];

        if (pathVersion !== baseVersion) {
          effectiveBaseUrl = this.baseUrl.replace(baseVersion, pathVersion);
          path = path.substring(pathVersion.length);
        }
      }

      fullUrl = effectiveBaseUrl.endsWith('/') ? effectiveBaseUrl + path.substring(1) : effectiveBaseUrl + path;
    } else {
      fullUrl = this.baseUrl.endsWith('/') ? this.baseUrl + path : this.baseUrl + '/' + path;
    }

    const url = new URL(fullUrl);

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
      const picked = this.proxyManager.pick();
      if (picked) {
        options.agent = picked.agent;
        options._proxyMasked = picked.maskedUrl;
        options._proxyUrl = picked.url;
        options._proxyStartedAt = Date.now();
        const known = picked.latencyMs != null ? ` (~${picked.latencyMs}ms)` : '';
        console.log(`[GEMINI] Routing request via proxy ${picked.maskedUrl}${known}`);
      }
    }

    return options;
  }

  sendRequest(method, path, body, headers, apiKey, useHeader = false) {
    return new Promise((resolve, reject) => {
      const options = this._buildRequestOptions(method, path, body, headers, apiKey, useHeader);

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
        reject(err);
      }, timeoutMs);

      req = https.request(options, (res) => {
        if (settled) { res.resume(); return; }
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (settled) return;
          settled = true;
          stop();
          this._reportProxyOutcome(options, true, false, res.statusCode);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: data,
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
        reject(error);
      });

      if (body && method !== 'GET') {
        const bodyData = typeof body === 'string' ? body : JSON.stringify(body);
        req.write(bodyData);
      }

      req.end();
    });
  }

  sendStreamingRequest(method, path, body, headers, apiKey, useHeader = false) {
    return new Promise((resolve, reject) => {
      const options = this._buildRequestOptions(method, path, body, headers, apiKey, useHeader);

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
      const startedAt = options._proxyStartedAt;
      this.proxyManager.reportSuccess(url, startedAt ? Date.now() - startedAt : null);
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
  async _withProxyRetry(send) {
    let attempt = 0;
    for (;;) {
      try {
        return await send();
      } catch (error) {
        const canRetry = error && error._proxyFailure
          && this.proxyManager && this.proxyManager.isEnabled()
          && attempt < GeminiClient.MAX_PROXY_RETRIES;
        if (!canRetry) throw error;
        attempt += 1;
        console.log(`[GEMINI] Proxy attempt ${attempt} failed - retrying the same key through another proxy`);
      }
    }
  }

  _responseTimeoutFor(options) {
    return options._proxyUrl
      ? GeminiClient.PROXIED_TIMEOUT_MS
      : GeminiClient.DIRECT_TIMEOUT_MS;
  }

  maskApiKey(key) {
    if (!key || key.length < 8) return '***';
    return key.substring(0, 4) + '...' + key.substring(key.length - 4);
  }
}

// A provider can legitimately take a while to answer a large non-streaming
// completion, so the direct bound is generous. Through a proxy, silence is far
// more likely to mean a dead proxy than a slow provider.
GeminiClient.MAX_PROXY_RETRIES = 2;
GeminiClient.DIRECT_TIMEOUT_MS = 120000;
GeminiClient.PROXIED_TIMEOUT_MS = 60000;

module.exports = GeminiClient;