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
          const response = await this.sendStreamingRequest(method, path, body, cleanHeaders, providedApiKey, true);
          console.log(`[GEMINI::${maskedKey}] Response (${response.statusCode}) - streaming`);
          response._keyInfo = { keyUsed: maskedKey, failedKeys: [] };
          return response;
        } else {
          const response = await this.sendRequest(method, path, body, cleanHeaders, providedApiKey, true);
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
          const response = await this.sendStreamingRequest(method, path, body, headers, apiKey, false);

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
          const response = await this.sendRequest(method, path, body, headers, apiKey, false);

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

    // Google's OpenAI-compatibility layer (paths like /openai/chat/completions,
    // or a base URL that already points at .../v1beta/openai) does NOT accept
    // the native `key` query param or `x-goog-api-key` header - it requires a
    // standard `Authorization: Bearer <key>` header, same as OpenAI itself.
    // Without this, requests routed to that surface fail with a missing/invalid
    // authorization error even though a valid Gemini key was supplied.
    if (this.isOpenAICompatiblePath(path) || this.isOpenAICompatiblePath(this.baseUrl)) {
      if (!headers || !headers.authorization) {
        finalHeaders['Authorization'] = `Bearer ${apiKey}`;
      }
    } else if (useHeader) {
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
        console.log(`[GEMINI] Routing request via proxy ${picked.maskedUrl}`);
      }
    }

    return options;
  }

  sendRequest(method, path, body, headers, apiKey, useHeader = false) {
    return new Promise((resolve, reject) => {
      const options = this._buildRequestOptions(method, path, body, headers, apiKey, useHeader);

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: data,
            proxyUsed: options._proxyMasked || null
          });
        });
      });

      req.on('error', (error) => {
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[GEMINI::${maskedKey}] HTTP request error: ${error.message}`);
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

      const req = https.request(options, (res) => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          stream: res,
          proxyUsed: options._proxyMasked || null
        });
      });

      req.on('error', (error) => {
        const maskedKey = this.maskApiKey(apiKey);
        console.log(`[GEMINI::${maskedKey}] HTTP streaming request error: ${error.message}`);
        reject(error);
      });

      if (body && method !== 'GET') {
        const bodyData = typeof body === 'string' ? body : JSON.stringify(body);
        req.write(bodyData);
      }

      req.end();
    });
  }

  maskApiKey(key) {
    if (!key || key.length < 8) return '***';
    return key.substring(0, 4) + '...' + key.substring(key.length - 4);
  }

  /**
   * Detects whether a path or base URL targets Gemini's OpenAI-compatibility
   * surface (e.g. "/openai/chat/completions", ".../v1beta/openai") rather
   * than the native Gemini API (e.g. "/v1beta/models/gemini-pro:generateContent").
   * That surface authenticates like OpenAI - via an Authorization: Bearer
   * header - not via the `key` query param or `x-goog-api-key` header used
   * by native Gemini endpoints.
   * @param {string} value A path or URL to inspect
   * @returns {boolean}
   */
  isOpenAICompatiblePath(value) {
    if (!value) return false;
    return /\/openai(\/|$)/i.test(value) || /\/chat\/completions(\?|$)/i.test(value);
  }
}

module.exports = GeminiClient;