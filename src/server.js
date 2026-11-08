const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TelegramBot = require('./telegramBot');
const ProxyManager = require('./proxyManager');
const ApiLogStore = require('./apiLogStore');
const ProxyPool = require('./proxyPool');
const ProxyChecker = require('./proxyChecker');
const proxyCache = require('./proxyCache');
const { resolveKey } = require('./keyValues');
const { parseStatusCodes, describeStatusCodes } = require('./statusCodes');

// A provider's own settings: {TYPE}_{NAME}_{SUFFIX}, or legacy {TYPE}_{SUFFIX}
const PROVIDER_VAR_RE = /^[^_]+(?:_.+?)?_(API_KEYS|BASE_URL|MODELS_URL|ACCESS_KEY|DEFAULT_MODEL|MODEL_HISTORY|DISABLED|PROXY)$/;

// The model a request asked for: the body's "model" (OpenAI style), else the
// /models/<name>:<action> path segment (Gemini style). Null when there isn't one.
function requestModel(body, url) {
  try {
    const model = body && JSON.parse(body).model;
    if (typeof model === 'string' && model) return model.slice(0, 200);
  } catch (e) { /* not JSON */ }
  const m = String(url || '').split('?')[0].match(/\/models\/([^/:]+)(?::[^/]*)?$/);
  return m ? decodeURIComponent(m[1]).slice(0, 200) : null;
}

// The provider's own reason from an error body ({error:{message}}, {error:"..."},
// {message}, Cloudflare's {errors:[{message}]}), so a failed key check says why
function upstreamErrorText(body) {
  try {
    const d = JSON.parse(body);
    const e = d.error;
    const msg = (e && typeof e === 'object' ? (e.message || e.code) : e)
      || d.message || (Array.isArray(d.errors) && d.errors[0] && d.errors[0].message) || '';
    return String(msg).slice(0, 200);
  } catch (err) {
    return '';
  }
}

class ProxyServer {
  constructor(config, geminiClient = null, openaiClient = null) {
    this.config = config;
    this.geminiClient = geminiClient;
    this.openaiClient = openaiClient;
    this.providerClients = new Map(); // Map of provider_name -> client instance
    this.server = null;
    this.adminSessionToken = null;
    this.startTime = Date.now(); // For uptime in the status bar (J2)
    this.totalApiRequests = 0;    // Cumulative API request counter (J2)

    // API request logging - memory vs. per-request files, driven by API_LOGS in .env
    this.apiLogs = new ApiLogStore();

    // Rate limiting for login, per client address - a global counter would let
    // anyone keep the real admin locked out
    this.loginAttempts = new Map(); // ip -> { fails, blockedUntil }
    this.adminSessionIssuedAt = 0;

    // Store required classes for reinitialization
    this.KeyRotator = require('./keyRotator');
    this.GeminiClient = require('./geminiClient');
    this.OpenAIClient = require('./openaiClient');

    // Auto-fetched proxy pool. Lives in memory; feeds the ProxyManager.
    this.proxyPool = new ProxyPool({
      getProbeTarget: () => this.getProxyProbeTarget(),
      onUpdate: () => {
        this.config.getProxyManager().setAutoProxies(this.proxyPool.live);
        this.saveProxyCache(); // a fresh list is worth keeping right away
      },
    });

    // Re-checks the proxies while idle, so green/red stays current
    this.proxyChecker = new ProxyChecker({
      getManager: () => this.config.getProxyManager(),
      probe: (url, host) => this.proxyPool.probe(url, host),
      getTargets: () => this.proxyedProviders().map(([, p]) => new URL(p.baseUrl).hostname),
      modelCheck: (url) => this.proxyModelCheck(url),
    });
    this._modelCheckTurn = 0;

    // Telegram bot (started after server.listen in start())
    this.telegramBot = new TelegramBot(this);
  }

  // The panel and the Telegram bot read these directly; keep them pointing at
  // the log store so it stays the single source of truth.
  get logBuffer() { return this.apiLogs.buffer; }
  set logBuffer(entries) { this.apiLogs.buffer = Array.isArray(entries) ? entries : []; }
  get responseStorage() { return this.apiLogs.details; }

  /** Adopt the current API_LOGS setting (at boot, and after an .env save). */
  applyLogSettings() {
    this.apiLogs.applySettings(this.config.getApiLogsConfig());
  }

  start() {
    // Restore persisted logs (and prune expired ones) before accepting traffic
    this.applyLogSettings();
    this.restoreProxyCache();

    this.server = http.createServer((req, res) => {
      // A stray throw in one request must never take the whole proxy down
      this.handleRequest(req, res).catch((err) => {
        console.log(`[SERVER] Unhandled request error: ${err && err.message}`);
        if (!res.headersSent) this.sendError(res, 500, 'Internal server error');
        else res.destroy();
      });
    });

    this.server.listen(this.config.getPort(), () => {
      console.log(`Multi-API proxy server running on port ${this.config.getPort()}`);
      
      const providers = this.config.getProviders();
      for (const [providerName, config] of providers.entries()) {
        console.log(`Provider '${providerName}' (${config.apiType}): /${providerName}/* → ${config.baseUrl}`);
      }
      
      // Backward compatibility logging
      if (this.config.hasGeminiKeys()) {
        console.log(`Legacy Gemini endpoints: /gemini/*`);
      }
      if (this.config.hasOpenaiKeys()) {
        console.log(`Legacy OpenAI endpoints: /openai/*`);
      }
      
      if (this.config.hasAdminPassword()) {
        console.log(`Admin panel available at: http://localhost:${this.config.getPort()}/admin`);
      }

      // Start Telegram bot after server is listening
      this.initTelegramBot();
    });

    this.server.on('error', (error) => {
      console.error('Server error:', error);
    });
  }

  async handleRequest(req, res) {
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const startTime = Date.now();

    // Set CORS headers for all responses - accept all origins
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours

    // Handle preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Only proxied API calls are logged; they get the sequential id that names
    // their log file. Admin and static traffic gets a throwaway console tag so it
    // can't punch gaps in the log sequence.
    const isApiCall = this.parseRoute(req.url) !== null;
    const requestId = isApiCall
      ? this.apiLogs.nextRequestId()
      : `adm-${Math.random().toString(36).substring(2, 8)}`;
    console.log(`[REQ-${requestId}] ${req.method} ${req.url} from ${clientIp}`);

    let model = null; // shown in the request log
    try {
      const body = await this.readRequestBody(req);
      if (isApiCall) model = requestModel(body, req.url);

      // Serve static files from public directory
      if (req.url === '/tailwind-3.4.17.js' && (req.method === 'GET' || req.method === 'HEAD')) {
        try {
          const filePath = path.join(process.cwd(), 'public', 'tailwind-3.4.17.js');
          console.log(`[STATIC] Serving file from: ${filePath}`);

          if (req.method === 'HEAD') {
            // For HEAD requests, just send headers without body
            const stats = fs.statSync(filePath);
            res.writeHead(200, {
              'Content-Type': 'application/javascript',
              'Content-Length': stats.size,
              'Cache-Control': 'public, max-age=31536000' // Cache for 1 year
            });
            res.end();
          } else {
            // For GET requests, send the file content
            const fileContent = fs.readFileSync(filePath, 'utf8');
            res.writeHead(200, {
              'Content-Type': 'application/javascript',
              'Content-Length': Buffer.byteLength(fileContent),
              'Cache-Control': 'public, max-age=31536000' // Cache for 1 year
            });
            res.end(fileContent);
          }
          console.log(`[STATIC] Successfully served: ${req.url}`);
          return;
        } catch (error) {
          console.log(`[STATIC] Error serving file: ${error.message}`);
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('File not found');
          return;
        }
      }

      // Handle root route - redirect to admin
      if (req.url === '/' || req.url === '') {
        res.writeHead(302, { 'Location': '/admin' });
        res.end();
        return;
      }

      // Handle admin routes
      if (/^\/admin(\/|\?|$)/.test(req.url)) {
        await this.handleAdminRequest(req, res, body);
        return;
      }

      // Handle common browser requests that aren't API calls
      if (req.url === '/favicon.ico' || req.url === '/robots.txt') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      
      const routeInfo = this.parseRoute(req.url);
      
      if (!routeInfo) {
        console.log(`[REQ-${requestId}] Invalid path: ${req.url}`);
        console.log(`[REQ-${requestId}] Response: 400 Bad Request - Invalid API path`);
        
        if (isApiCall) {
          const responseTime = Date.now() - startTime;
          this.logApiRequest(requestId, req.method, req.url, 'unknown', 400, responseTime, 'Invalid API path', clientIp, null, null, model);
        }
        
        this.sendError(res, 400, 'Invalid API path. Use /{provider}/* format');
        return;
      }

      const { providerName, apiType, path, provider, legacy } = routeInfo;

      // Check if provider is disabled
      if (provider && provider.disabled) {
        console.log(`[REQ-${requestId}] Provider '${providerName}' is disabled`);
        if (isApiCall) {
          const responseTime = Date.now() - startTime;
          this.logApiRequest(requestId, req.method, path, providerName, 503, responseTime, `Provider '${providerName}' is disabled`, clientIp, null, null, model);
        }
        this.sendError(res, 503, `Provider '${providerName}' is currently disabled`);
        return;
      }

      console.log(`[REQ-${requestId}] Proxying to provider '${providerName}' (${apiType.toUpperCase()}): ${path}`);

      // Get the appropriate header based on API type
      const authHeader = apiType === 'gemini'
        ? req.headers['x-goog-api-key']
        : req.headers['authorization'];

      // Parse custom status codes and access key from header
      const customStatusCodes = this.parseStatusCodesFromAuth(authHeader);

      // Validate ACCESS_KEY for this provider
      if (!this.validateAccessKey(providerName, authHeader)) {
        console.log(`[REQ-${requestId}] Response: 401 Unauthorized - Invalid or missing ACCESS_KEY for provider '${providerName}'`);

        if (isApiCall) {
          const responseTime = Date.now() - startTime;
          this.logApiRequest(requestId, req.method, path, providerName, 401, responseTime, 'Invalid or missing ACCESS_KEY', clientIp, null, null, model);
        }

        this.sendError(res, 401, `Invalid or missing ACCESS_KEY for provider '${providerName}'`);
        return;
      }
      
      // Clean the auth header before passing to API
      const headers = this.extractRelevantHeaders(req.headers, apiType);
      if (authHeader) {
        const cleanedAuth = this.cleanAuthHeader(authHeader);
        if (cleanedAuth) {
          if (apiType === 'gemini') {
            headers['x-goog-api-key'] = cleanedAuth;
          } else {
            headers['authorization'] = cleanedAuth;
          }
        }
        // Important: don't set undefined/null as it would override the client's API key
      }

      let response;

      // Get or create client for this provider
      const client = await this.getProviderClient(providerName, provider, legacy);
      if (!client) {
        console.log(`[REQ-${requestId}] Response: 503 Service Unavailable - Provider '${providerName}' not configured`);

        if (isApiCall) {
          const responseTime = Date.now() - startTime;
          this.logApiRequest(requestId, req.method, path, providerName, 503, responseTime, `Provider '${providerName}' not configured`, clientIp, null, null, model);
        }

        this.sendError(res, 503, `Provider '${providerName}' not configured`);
        return;
      }

      // Pass custom status codes to client if provided
      if (customStatusCodes) {
        console.log(`[REQ-${requestId}] Using custom status codes for rotation: ${Array.from(customStatusCodes).join(', ')}`);
      }

      // Some OpenAI-compatible clients send max_tokens AND max_completion_tokens in the
      // same request; Gemini rejects that pair with a 400 instead of ignoring one.
      const upstreamBody = this.sanitizeRequestBody(body);

      // Detect streaming request
      const isStreaming = this.isStreamingRequest(body, path);
      if (isStreaming) {
        console.log(`[REQ-${requestId}] Streaming request detected`);
      }

      response = await client.makeRequest(req.method, this.upstreamPath(req.method, path, provider), upstreamBody, headers, customStatusCodes, isStreaming);

      // Extract key info from response
      const keyInfo = response._keyInfo || null;
      const proxyUsed = response.proxyUsed || null;

      if (isStreaming && response.stream) {
        // Streaming response - pipe directly to client
        const streamHeaders = { ...response.headers };
        streamHeaders['access-control-allow-origin'] = '*';

        res.writeHead(response.statusCode, streamHeaders);

        // Collect streamed chunks while piping to client (cap at 512KB to avoid memory issues)
        const MAX_CAPTURE = 512 * 1024;
        const streamChunks = [];
        let capturedSize = 0;
        let truncated = false;

        response.stream.on('data', (chunk) => {
          if (!truncated) {
            capturedSize += chunk.length;
            if (capturedSize <= MAX_CAPTURE) {
              streamChunks.push(chunk);
            } else {
              truncated = true;
            }
          }
        });

        response.stream.pipe(res);

        let clientGone = false;
        let logged = false;
        const logStream = (status, error) => {
          if (logged || !isApiCall) return;
          logged = true;
          this.logApiRequest(requestId, req.method, path, providerName, status, Date.now() - startTime, error, clientIp, keyInfo, proxyUsed, model);
        };

        // Client went away: stop the upstream too, or it keeps generating (and billing)
        res.on('close', () => {
          if (res.writableFinished || clientGone) return;
          clientGone = true;
          response.stream.destroy();
          console.log(`[REQ-${requestId}] Client disconnected mid-stream`);
          logStream(499, 'Client disconnected mid-stream');
        });

        response.stream.on('end', () => {
          let streamedData = Buffer.concat(streamChunks).toString('utf8');
          if (truncated) {
            streamedData += `\n\n[... truncated at 512KB — total streamed: ${(capturedSize / 1024).toFixed(1)}KB]`;
          }
          this.storeResponseData(requestId, {
            method: req.method,
            endpoint: path,
            apiType: apiType.toUpperCase(),
            status: response.statusCode,
            statusText: this.getStatusText(response.statusCode),
            contentType: response.headers['content-type'] || 'text/event-stream',
            responseData: streamedData,
            requestBody: body,
            requestHeaders: req.headers,
            streaming: true,
            provider: providerName,
            proxyUsed: proxyUsed,
            keyInfo: keyInfo
          });

          logStream(response.statusCode, response.statusCode >= 400 ? `HTTP ${response.statusCode}` : null);
          console.log(`[REQ-${requestId}] Streaming response completed`);
        });

        response.stream.on('error', (err) => {
          if (clientGone) return; // already logged as a disconnect
          console.log(`[REQ-${requestId}] Streaming error: ${err.message}`);
          logStream(502, `Upstream stream failed: ${err.message}`);
          // pipe() doesn't end the client response on a source error - cut it
          // so the caller sees the failure instead of hanging
          if (!res.headersSent) this.sendError(res, 502, 'Streaming error');
          else res.destroy(err);
        });
      } else {
        // Non-streaming response. logApiResponse() stages the full payload and
        // logApiRequest() writes it, so the response must be stored first.
        this.logApiResponse(requestId, response, body, {
          method: req.method, endpoint: path, apiType: apiType.toUpperCase(),
          provider: providerName, proxyUsed, keyInfo, requestHeaders: req.headers
        });

        if (isApiCall) {
          const responseTime = Date.now() - startTime;
          const error = response.statusCode >= 400 ? `HTTP ${response.statusCode}` : null;
          this.logApiRequest(requestId, req.method, path, providerName, response.statusCode, responseTime, error, clientIp, keyInfo, proxyUsed, model);
        }

        this.sendResponse(res, response);
      }
    } catch (error) {
      // Upstream unreachable or silent is the provider's side (502/504), not ours
      const status = /did not (respond|start streaming)/.test(error.message) ? 504
        : (error.code || error._proxyFailure) ? 502 : 500;
      console.log(`[REQ-${requestId}] Request handling error: ${error.message}`);
      console.log(`[REQ-${requestId}] Response: ${status}`);

      if (isApiCall) {
        const responseTime = Date.now() - startTime;
        this.logApiRequest(requestId, req.method, req.url, 'unknown', status, responseTime, error.message, clientIp, null, null, model);
      }

      this.sendError(res, status, status === 500 ? 'Internal server error' : `Upstream request failed: ${error.message}`);
    }
  }

  readRequestBody(req) {
    return new Promise((resolve) => {
      // Decode once at the end: decoding chunk by chunk splits multi-byte
      // characters that straddle two chunks into garbage
      const chunks = [];
      const done = () => resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') || null : null);
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', done);
      req.on('error', done);   // client dropped mid-upload: don't leave this pending
      req.on('aborted', done);
    });
  }

  parseRoute(url) {
    if (!url) return null;

    let urlObj;
    try {
      urlObj = new URL(url, 'http://localhost');
    } catch (e) {
      return null; // e.g. "//[" - not a route, and must not throw
    }
    const path = urlObj.pathname;
    
    // Parse new provider format: /{provider}/* (no version required)
    const pathParts = path.split('/').filter(part => part.length > 0);
    if (pathParts.length >= 1) {
      const providerName = pathParts[0].toLowerCase();
      const provider = this.config.getProvider(providerName);

      if (provider) {
        // Extract the API path after /{provider}
        const apiPath = '/' + pathParts.slice(1).join('/') + urlObj.search;

        return {
          providerName: providerName,
          apiType: provider.apiType,
          path: apiPath, // Use path as-is, no adjustment needed
          provider: provider
        };
      }
    }
    
    // Backward compatibility - Legacy Gemini routes: /gemini/*
    if (path.startsWith('/gemini/')) {
      const geminiPath = path.substring(7); // Remove '/gemini'

      return {
        providerName: 'gemini',
        apiType: 'gemini',
        path: geminiPath + urlObj.search,
        legacy: true
      };
    }
    
    // Backward compatibility - Legacy OpenAI routes: /openai/*
    if (path.startsWith('/openai/')) {
      const openaiPath = path.substring(7); // Remove '/openai'

      return {
        providerName: 'openai',
        apiType: 'openai',
        path: openaiPath + urlObj.search,
        legacy: true
      };
    }
    
    return null;
  }


  /**
   * A provider can list its models somewhere other than {base}/models. Its
   * MODELS_URL is then used for GET /models: a path (joined to the base URL like
   * any other path) or a full https:// URL. The request's own query string is
   * kept unless the models URL brings one.
   */
  upstreamPath(method, path, provider) {
    const modelsUrl = provider && provider.modelsUrl;
    if (method !== 'GET' || !modelsUrl) return path;
    const [pathname, query] = path.split('?');
    if (!/^\/models\/?$/.test(pathname)) return path;
    return query && !modelsUrl.includes('?') ? `${modelsUrl}?${query}` : modelsUrl;
  }

  async getProviderClient(providerName, provider, legacy = false) {
    // Handle legacy clients
    if (legacy) {
      if (providerName === 'gemini' && this.geminiClient) {
        return this.geminiClient;
      }
      if (providerName === 'openai' && this.openaiClient) {
        return this.openaiClient;
      }
      return null;
    }

    // Check if we already have a client for this provider
    if (this.providerClients.has(providerName)) {
      return this.providerClients.get(providerName);
    }

    // Create new client for this provider
    if (!provider) {
      return null;
    }

    try {
      // Use only enabled keys for rotation
      const enabledKeys = provider.keys; // Already filtered by config parser
      if (enabledKeys.length === 0) {
        console.log(`[SERVER] Provider '${providerName}' has no enabled keys`);
        return null;
      }
      const keyRotator = new this.KeyRotator(enabledKeys, provider.apiType);
      let client;

      // Proxying is per provider: hand the manager over only to the ones that
      // asked for it, so everyone else connects directly.
      const proxyManager = provider.proxy ? this.config.getProxyManager() : null;
      if (provider.proxy) {
        console.log(`[SERVER] Provider '${providerName}' will route through the proxy pool`);
      }
      if (provider.apiType === 'openai') {
        client = new this.OpenAIClient(keyRotator, provider.baseUrl, proxyManager);
      } else if (provider.apiType === 'gemini') {
        client = new this.GeminiClient(keyRotator, provider.baseUrl, proxyManager);
      } else {
        return null;
      }

      this.providerClients.set(providerName, client);
      console.log(`[SERVER] Created client for provider '${providerName}' (${provider.apiType})`);
      return client;
    } catch (error) {
      console.error(`[SERVER] Failed to create client for provider '${providerName}': ${error.message}`);
      return null;
    }
  }

  parseStatusCodesFromAuth(authHeader) {
    // [STATUS_CODES:403, 420-429, >=500] in the Authorization header (syntax in statusCodes.js)
    const match = authHeader?.match(/\[STATUS_CODES:([^\]]+)\]/i);
    if (!match) return null;
    const { codes } = parseStatusCodes(match[1]);
    return codes.size > 0 ? codes : null;
  }

  parseAccessKeyFromAuth(authHeader) {
    // Extract [ACCESS_KEY:...] from the Authorization header
    const match = authHeader?.match(/\[ACCESS_KEY:([^\]]+)\]/i);
    if (!match) return null;
    return match[1].trim();
  }

  validateAccessKey(provider, authHeader) {
    const providerConfig = this.config.getProvider(provider);
    if (!providerConfig || !providerConfig.accessKey) {
      // No access key required for this provider
      return true;
    }

    const providedAccessKey = this.parseAccessKeyFromAuth(authHeader);
    if (!providedAccessKey) {
      return false;
    }

    return providedAccessKey === providerConfig.accessKey;
  }

  cleanAuthHeader(authHeader) {
    // Remove [STATUS_CODES:...] and [ACCESS_KEY:...] from the auth header before passing to the actual API
    if (!authHeader) return authHeader;

    const cleaned = authHeader
      .replace(/\[STATUS_CODES:[^\]]+\]/gi, '')
      .replace(/\[ACCESS_KEY:[^\]]+\]/gi, '')
      .trim();

    // If after cleaning we're left with just "Bearer" or "Bearer ", return null
    // This allows the client to add its own API key
    if (cleaned === 'Bearer' || cleaned === 'Bearer ') {
      return null;
    }

    return cleaned;
  }

  extractRelevantHeaders(headers, apiType) {
    const relevantHeaders = {};
    let headersToInclude;

    if (apiType === 'gemini') {
      headersToInclude = [
        'content-type',
        'accept',
        'user-agent',
        'x-goog-user-project'
        // Don't include x-goog-api-key here - we handle it separately
      ];
    } else if (apiType === 'openai') {
      headersToInclude = [
        'content-type',
        'accept',
        'user-agent',
        'openai-organization',
        'openai-project'
      ];
    }

    for (const [key, value] of Object.entries(headers)) {
      if (headersToInclude.includes(key.toLowerCase())) {
        relevantHeaders[key] = value;
      }
    }

    return relevantHeaders;
  }

  sendResponse(res, response) {
    res.writeHead(response.statusCode, response.headers);
    res.end(response.data);
  }

  sendError(res, statusCode, message) {
    console.log(`[SERVER] Sending error response: ${statusCode} - ${message}`);
    if (res.headersSent) { res.destroy(); return; } // mid-response: all we can do is cut it

    const errorResponse = {
      error: {
        code: statusCode,
        message: message,
        status: statusCode === 400 ? 'INVALID_ARGUMENT' : 'INTERNAL'
      }
    };

    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse));
  }

  /**
   * Strip parameter combinations that upstream providers reject outright.
   * Today that is only max_tokens + max_completion_tokens together: either one alone is
   * fine, but Gemini answers 400 INVALID_ARGUMENT when it receives both, which is what
   * LiteLLM-based clients (OpenHands, Cline, Aider) send by default. We keep
   * max_completion_tokens because reasoning models reject the legacy max_tokens.
   * Returns the body untouched, in the same shape, when there is nothing to fix.
   */
  sanitizeRequestBody(body) {
    if (!body) return body;
    const wasString = typeof body === 'string';
    let parsed;
    try {
      parsed = wasString ? JSON.parse(body) : body;
    } catch {
      return body;
    }
    if (!parsed || typeof parsed !== 'object') return body;
    if (parsed.max_tokens === undefined || parsed.max_completion_tokens === undefined) return body;
    const { max_tokens, ...rest } = parsed;
    return wasString ? JSON.stringify(rest) : rest;
  }

  /**
   * Detect if a request body contains stream: true
   */
  isStreamingRequest(body, path = '') {
    // Gemini's native streaming is chosen by the endpoint, not the body
    if (/:streamGenerateContent\b/.test(path)) return true;
    if (!body) return false;
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      return parsed.stream === true;
    } catch {
      return false;
    }
  }

  logApiResponse(requestId, response, requestBody = null, meta = {}) {
    const contentLength = response.headers['content-length'] || (response.data ? response.data.length : 0);
    const contentType = response.headers['content-type'] || 'unknown';

    // Store response data for viewing
    this.storeResponseData(requestId, {
      method: meta.method || 'API_CALL',
      endpoint: meta.endpoint || 'proxied_request',
      apiType: meta.apiType || 'LLM_API',
      status: response.statusCode,
      statusText: this.getStatusText(response.statusCode),
      contentType: contentType,
      responseData: response.data,
      requestBody: requestBody,
      requestHeaders: meta.requestHeaders || null,
      provider: meta.provider || null,
      proxyUsed: meta.proxyUsed || null,
      keyInfo: meta.keyInfo || null
    });
    
    // Log basic response info to console only (structured logging handled in handleRequest)
    const responseMsg = `[REQ-${requestId}] Response: ${response.statusCode} ${this.getStatusText(response.statusCode)}`;
    const contentMsg = `[REQ-${requestId}] Content-Type: ${contentType}, Size: ${contentLength} bytes`;
    
    console.log(responseMsg);
    console.log(contentMsg);
    
    // For error responses, log the error details to console
    if (response.statusCode >= 400) {
      try {
        const errorData = JSON.parse(response.data);
        if (errorData.error) {
          const errorMsg = `[REQ-${requestId}] Error: ${errorData.error.message || errorData.error.code || 'Unknown error'}`;
          console.log(errorMsg);
        }
      } catch (e) {
        // If response is not JSON, log first 200 chars of response
        const errorText = response.data ? response.data.toString().substring(0, 200) : 'No error details';
        const errorMsg = `[REQ-${requestId}] Error details: ${errorText}`;
        console.log(errorMsg);
      }
    }
    
    // For successful responses, log basic success info to console
    if (response.statusCode >= 200 && response.statusCode < 300) {
      const successMsg = `[REQ-${requestId}] Request completed successfully`;
      console.log(successMsg);
    }
  }

  getStatusText(statusCode) {
    const statusTexts = {
      200: 'OK',
      201: 'Created',
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable'
    };
    return statusTexts[statusCode] || 'Unknown Status';
  }

  async handleAdminRequest(req, res, body) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // Another site can't drive the panel through the admin's browser: a
    // cross-origin POST (which a browser sends with its Origin) is refused
    if (req.method !== 'GET' && req.headers.origin) {
      let sameOrigin = false;
      try {
        const host = new URL(req.headers.origin).host;
        sameOrigin = host === req.headers.host || host === req.headers['x-forwarded-host']; // behind a reverse proxy
      } catch (e) { /* "null" etc. */ }
      if (!sameOrigin) {
        this.sendError(res, 403, 'Cross-origin request refused');
        return;
      }
    }
    
    // Check if admin password is configured
    const adminPassword = this.getAdminPassword();
    if (!adminPassword) {
      this.sendError(res, 503, 'Admin panel not configured');
      return;
    }
    
    // Serve main admin page
    if (path === '/admin' || path === '/admin/') {
      this.serveAdminPanel(res);
      return;
    }
    
    // Check authentication status
    if (path === '/admin/api/auth' && req.method === 'GET') {
      const isAuthenticated = this.isAdminAuthenticated(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: isAuthenticated }));
      return;
    }
    
    // Check login rate limit status
    if (path === '/admin/api/login-status' && req.method === 'GET') {
      const now = Date.now();
      const st = this.loginState(req);
      const isBlocked = !!(st.blockedUntil && now < st.blockedUntil);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        blocked: isBlocked,
        blockedUntil: st.blockedUntil,
        remainingSeconds: isBlocked ? Math.ceil((st.blockedUntil - now) / 1000) : 0,
        failedAttempts: st.fails
      }));
      return;
    }

    // Handle login
    if (path === '/admin/login' && req.method === 'POST') {
      await this.handleAdminLogin(req, res, body);
      return;
    }
    
    // Handle logout
    if (path === '/admin/logout' && req.method === 'POST') {
      this.adminSessionToken = null;
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Set-Cookie': 'adminSession=; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/admin'
      });
      res.end(JSON.stringify({ success: true }));
      return;
    }
    
    // All other admin routes require authentication
    if (!this.isAdminAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    
    // Admin API routes
    if (path === '/admin/api/env' && req.method === 'GET') {
      await this.handleGetEnvVars(res);
    } else if (path === '/admin/api/env-file' && req.method === 'GET') {
      await this.handleGetEnvFile(res);
    } else if (path === '/admin/api/env' && req.method === 'POST') {
      await this.handleUpdateEnvVars(res, body);
    } else if (path === '/admin/api/test' && req.method === 'POST') {
      await this.handleTestApiKey(res, body);
    } else if (path === '/admin/api/logs' && req.method === 'GET') {
      await this.handleGetLogs(res, url);
    } else if (path === '/admin/api/logs/clear' && req.method === 'POST') {
      await this.handleClearLogs(res);
    } else if (path === '/admin/api/status' && req.method === 'GET') {
      await this.handleGetStatus(res);
    } else if (path.startsWith('/admin/api/response/') && req.method === 'GET') {
      await this.handleGetResponse(res, path);
    } else if (path === '/admin/api/reorder-keys' && req.method === 'POST') {
      await this.handleReorderKeys(res, body);
    } else if (path === '/admin/api/key-usage' && req.method === 'GET') {
      await this.handleGetKeyUsage(res);
    } else if (path === '/admin/api/toggle-key' && req.method === 'POST') {
      await this.handleToggleKey(res, body);
    } else if (path === '/admin/api/toggle-provider' && req.method === 'POST') {
      await this.handleToggleProvider(res, body);
    } else if (path === '/admin/api/telegram' && req.method === 'GET') {
      await this.handleGetTelegramSettings(res);
    } else if (path === '/admin/api/telegram' && req.method === 'POST') {
      await this.handleUpdateTelegramSettings(res, body);
    } else if (path === '/admin/api/proxy' && req.method === 'GET') {
      await this.handleGetProxySettings(res);
    } else if (path === '/admin/api/proxy' && req.method === 'POST') {
      await this.handleUpdateProxySettings(res, body);
    } else if (path === '/admin/api/proxy/test' && req.method === 'POST') {
      await this.handleTestProxy(res, body);
    } else if (path === '/admin/api/proxy/refresh' && req.method === 'POST') {
      await this.handleRefreshProxyPool(res);
    } else if (path === '/admin/api/proxy/status' && req.method === 'GET') {
      await this.handleGetProxyStatus(res);
    } else {
      this.sendError(res, 404, 'Not found');
    }
  }
  
  generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
  }
  
  parseCookies(cookieHeader) {
    const cookies = {};
    if (cookieHeader) {
      cookieHeader.split(';').forEach(cookie => {
        const parts = cookie.trim().split('=');
        if (parts.length === 2) {
          cookies[parts[0]] = parts[1];
        }
      });
    }
    return cookies;
  }
  
  isAdminAuthenticated(req) {
    if (!this.adminSessionToken || Date.now() - this.adminSessionIssuedAt > ProxyServer.SESSION_MS) return false;
    const cookies = this.parseCookies(req.headers.cookie);
    return ProxyServer.safeEqual(cookies.adminSession, this.adminSessionToken);
  }

  static safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  loginState(req) {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    if (!this.loginAttempts.has(ip)) {
      if (this.loginAttempts.size > 1000) this.loginAttempts.clear(); // ponytail: crude cap, fine for a single-admin panel
      this.loginAttempts.set(ip, { fails: 0, blockedUntil: null });
    }
    return this.loginAttempts.get(ip);
  }

  async handleAdminLogin(req, res, body) {
    try {
      const st = this.loginState(req);
      // Check if login is currently blocked
      if (st.blockedUntil && Date.now() < st.blockedUntil) {
        const remainingSeconds = Math.ceil((st.blockedUntil - Date.now()) / 1000);
        const remainingMinutes = Math.ceil(remainingSeconds / 60);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: `Too many failed login attempts. Please wait ${remainingMinutes} minute(s).`,
          blockedUntil: st.blockedUntil,
          remainingSeconds: remainingSeconds
        }));
        return;
      }

      const data = JSON.parse(body);
      const adminPassword = this.getAdminPassword();

      if (ProxyServer.safeEqual(data && data.password, adminPassword)) {
        // Successful login - reset counters
        st.fails = 0;
        st.blockedUntil = null;
        this.adminSessionToken = this.generateSessionToken();
        this.adminSessionIssuedAt = Date.now();

        // Set session cookie (expires in 24 hours)
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toUTCString();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `adminSession=${this.adminSessionToken}; HttpOnly; SameSite=Strict; Expires=${expires}; Path=/admin`
        });
        res.end(JSON.stringify({ success: true }));
      } else {
        // Failed login - increment counter
        st.fails++;
        const attemptsRemaining = 5 - st.fails;

        // Block if reached 5 attempts
        if (st.fails >= 5) {
          st.fails = 0;
          st.blockedUntil = Date.now() + (5 * 60 * 1000); // 5 minutes
          console.log('[SECURITY] Login blocked due to 5 failed attempts. Blocked until:', new Date(st.blockedUntil).toISOString());
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Too many failed login attempts. Please wait 5 minutes.',
            blockedUntil: this.loginBlockedUntil,
            remainingSeconds: 300
          }));
        } else {
          console.log(`[SECURITY] Failed login attempt ${st.fails}/5`);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: `Invalid password. ${attemptsRemaining} attempt(s) remaining.`,
            attemptsRemaining: attemptsRemaining
          }));
        }
      }
    } catch (error) {
      this.sendError(res, 400, 'Invalid request');
    }
  }
  
  async handleGetEnvVars(res) {
    try {
      const envPath = path.join(process.cwd(), '.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      const envVars = this.config.parseEnvFile(envContent);

      // Don't send sensitive config
      delete envVars.ADMIN_PASSWORD;
      delete envVars.TELEGRAM_BOT_TOKEN;
      delete envVars.TELEGRAM_ALLOWED_USERS;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(envVars));
    } catch (error) {
      this.sendError(res, 500, 'Failed to read environment variables');
    }
  }

  async handleGetEnvFile(res) {
    try {
      const envPath = path.join(process.cwd(), '.env');
      const envContent = fs.readFileSync(envPath, 'utf8');

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(envContent);
    } catch (error) {
      this.sendError(res, 500, 'Failed to read .env file');
    }
  }

  getAdminPassword() {
    try {
      const envPath = path.join(process.cwd(), '.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      const envVars = this.config.parseEnvFile(envContent);
      return envVars.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || null;
    } catch (error) {
      return process.env.ADMIN_PASSWORD || null;
    }
  }
  
  
  async handleUpdateEnvVars(res, body) {
    try {
      const envVars = JSON.parse(body);
      if (!envVars || typeof envVars !== 'object' || Array.isArray(envVars)) {
        this.sendError(res, 400, 'Expected a JSON object of settings');
        return;
      }
      const envPath = path.join(process.cwd(), '.env');

      // Read current env to preserve admin password and disabled states
      const currentEnvContent = fs.readFileSync(envPath, 'utf8');
      const currentEnvVars = this.config.parseEnvFile(currentEnvContent);

      // This endpoint only edits providers. Everything else (password, port,
      // Settings, Telegram, proxy) has its own save and is kept from the file,
      // so a panel holding an older copy can't quietly undo those saves.
      const isProviderVar = (key) => PROVIDER_VAR_RE.test(key);
      const finalEnvVars = {};
      for (const [key, value] of Object.entries(currentEnvVars)) {
        if (!isProviderVar(key)) finalEnvVars[key] = value;
      }
      for (const [key, value] of Object.entries(envVars)) {
        if (isProviderVar(key)) finalEnvVars[key] = value;
      }

      // Keep a provider's _DISABLED/_PROXY flags when the payload leaves them out,
      // but only while that provider still exists - otherwise a deleted
      // provider's flag would resurrect it as a keyless ghost on reload.
      for (const [key, value] of Object.entries(currentEnvVars)) {
        if (key in envVars || !/_(DISABLED|PROXY)$/.test(key)) continue;
        // A keyless provider exists by its base URL alone
        if (['_API_KEYS', '_BASE_URL'].some((s) => key.replace(/_(DISABLED|PROXY)$/, s) in finalEnvVars)) {
          finalEnvVars[key] = value;
        }
      }

      this.writeEnvFile(finalEnvVars);
      this.config.loadConfig();
      this.reinitializeClients();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      this.sendError(res, 500, 'Failed to update environment variables');
    }
  }
  
  async handleTestApiKey(res, body) {
    try {
      const parsed = JSON.parse(body);
      let testResult = { success: false, error: 'Unknown API type' };

      // A provider added without keys: it only goes in if its models list answers without one
      if (parsed.keyless) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(await this.testKeyless(parsed.apiType, parsed.baseUrl, parsed.modelsUrl)));
        return;
      }

      // Test with the key's own values filled into the base URL
      let apiKey, baseUrl;
      try {
        ({ token: apiKey, baseUrl } = resolveKey(parsed.apiKey, parsed.baseUrl));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
        return;
      }
      const { apiType } = parsed;

      // viaProxy: send the check the way real traffic goes - through a proxy
      // picked exactly as a request would pick one
      let via = null;
      if (parsed.viaProxy) {
        via = this.config.getProxyManager().pick();
        if (!via) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'No working proxy right now - add proxy URLs or turn on auto-fetch and wait for the list' }));
          return;
        }
      }

      if (apiType === 'gemini') {
        // Test Gemini API key with custom base URL if provided
        testResult = await this.testGeminiKey(apiKey, baseUrl, parsed.quiet, via);
      } else if (apiType === 'openai') {
        // Test OpenAI API key with custom base URL if provided
        testResult = await this.testOpenaiKey(apiKey, baseUrl, parsed.quiet, via);
      }
      if (via) testResult.proxy = via.maskedUrl;
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(testResult));
    } catch (error) {
      this.sendError(res, 500, 'Failed to test API key');
    }
  }
  
  /**
   * Does this provider work without an API key? GET its models list (its own
   * models URL, if it has one) with no auth at all. Only a 2xx JSON answer
   * counts - a website's 200 HTML page is not an API.
   */
  testKeyless(apiType, baseUrl, modelsUrl = '') {
    if (apiType !== 'openai' && apiType !== 'gemini') return Promise.resolve({ success: false, error: 'Unknown API type' });
    let options;
    try {
      new URL(baseUrl);
      const client = apiType === 'gemini' ? new this.GeminiClient(null, baseUrl, null) : new this.OpenAIClient(null, baseUrl, null);
      const upstream = this.upstreamPath('GET', '/models', { modelsUrl });
      options = apiType === 'gemini'
        ? client._buildRequestOptions('GET', upstream, null, {}, '', true)
        : client._buildRequestOptions('GET', upstream, null, {}, '');
    } catch (e) {
      return Promise.resolve({ success: false, error: `Bad URL: ${e.message}` });
    }
    const where = `https://${options.hostname}${options.path}`;
    return new Promise((resolve) => {
      const req = https.request({ ...options, timeout: 15000 }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          console.log(`[TEST-KEYLESS] GET ${where} → ${r.statusCode} ${text.length}b`);
          if (r.statusCode < 200 || r.statusCode >= 300) {
            return resolve({ success: false, error: `${where} answered ${r.statusCode} without a key${upstreamErrorText(text) ? `: ${upstreamErrorText(text)}` : ''}` });
          }
          try { JSON.parse(text); } catch (e) {
            return resolve({ success: false, error: `${where} answered 200 but not with JSON - is this the API's base URL?` });
          }
          resolve({ success: true, error: null });
        });
      });
      req.on('timeout', () => req.destroy(new Error('no answer within 15s')));
      req.on('error', (err) => resolve({ success: false, error: `${where}: ${err.message}` }));
      req.end();
    });
  }

  /**
   * fetch() for key checks. Direct uses the built-in fetch; through a proxy it
   * goes over https.request with the proxy's agent (fetch can't take one) and
   * returns the same small Response-like shape. The proxy's health is fed back
   * like a real request's, so a dead one gets benched.
   */
  testFetch(url, opts = {}, via = null) {
    if (!via) return fetch(url, opts);
    const manager = this.config.getProxyManager();
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: opts.method || 'GET', headers: opts.headers || {}, agent: via.agent, timeout: 20000 }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          // Same rule as real requests: 403/407 usually means the provider blocks this proxy's IP
          if (r.statusCode === 403 || r.statusCode === 407) manager.reportFailure(via.url);
          else manager.reportSuccess(via.url);
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: r.statusCode,
            statusText: http.STATUS_CODES[r.statusCode] || '',
            ok: r.statusCode >= 200 && r.statusCode < 300,
            headers: { get: (h) => r.headers[h.toLowerCase()] || null },
            text: async () => text,
          });
        });
      });
      const fail = (err) => {
        manager.reportFailure(via.url);
        reject(new Error(`via proxy ${via.maskedUrl}: ${err.message}`));
      };
      req.on('timeout', () => req.destroy(new Error('timed out after 20s')));
      req.on('error', fail);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  // quiet: a bulk "Test all" run - don't fill the request log with key checks
  async testGeminiKey(apiKey, baseUrl = null, quiet = false, via = null) {
    const fetch = (url, opts) => this.testFetch(url, opts, via);
    const testId = Math.random().toString(36).substring(2, 11);
    const testBaseUrl = baseUrl || 'https://generativelanguage.googleapis.com/v1';
    const startTime = Date.now();
    
    // Determine the correct path based on base URL
    let testPath = '/models';
    let fullUrl;
    
    if (testBaseUrl.includes('/v1') || testBaseUrl.includes('/v1beta')) {
      // Base URL already includes version, just append models
      fullUrl = `${testBaseUrl.endsWith('/') ? testBaseUrl.slice(0, -1) : testBaseUrl}/models?key=${apiKey}`;
    } else {
      // Base URL doesn't include version, add /v1/models
      fullUrl = `${testBaseUrl.endsWith('/') ? testBaseUrl.slice(0, -1) : testBaseUrl}/v1/models?key=${apiKey}`;
      testPath = '/v1/models';
    }
    
    try {
      const testResponse = await fetch(fullUrl);
      const responseText = await testResponse.text();
      const contentType = testResponse.headers.get('content-type') || 'unknown';
      const responseTime = Date.now() - startTime;
      
      // Store response data for viewing
      if (!quiet) this.storeResponseData(testId, {
        method: 'GET',
        endpoint: testPath,
        apiType: 'Gemini',
        status: testResponse.status,
        statusText: testResponse.statusText,
        contentType: contentType,
        responseData: responseText,
        requestBody: null
      });
      
      // Log with structured format
      const error = !testResponse.ok ? `API test failed: ${testResponse.status} ${upstreamErrorText(responseText) || testResponse.statusText}` : null;
      if (!quiet) this.logApiRequest(testId, 'GET', testPath, 'gemini', testResponse.status, responseTime, error, 'admin-test');
      
      console.log(`[TEST-${testId}] GET ${testPath} (Gemini) → ${testResponse.status} ${testResponse.statusText} | ${contentType} ${responseText.length}b`);
      
      return { 
        success: testResponse.ok, 
        error: error
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      console.log(`[TEST-${testId}] GET ${testPath} (Gemini) → ERROR: ${error.message}`);
      if (!quiet) this.logApiRequest(testId, 'GET', testPath, 'gemini', null, responseTime, error.message, 'admin-test');
      
      return { success: false, error: error.message };
    }
  }
  
  async testOpenaiKey(apiKey, baseUrl = null, quiet = false, via = null) {
    const fetch = (url, opts) => this.testFetch(url, opts, via);
    const testId = Math.random().toString(36).substring(2, 11);
    const testBaseUrl = baseUrl || 'https://api.openai.com/v1';
    const startTime = Date.now();
    
    // Construct the full URL - just append /models to the base URL
    const fullUrl = `${testBaseUrl.endsWith('/') ? testBaseUrl.slice(0, -1) : testBaseUrl}/models`;
    
    // Determine display path for logging
    let testPath = '/models';
    if (testBaseUrl.includes('/openai/v1')) {
      testPath = '/openai/v1/models';
    } else if (testBaseUrl.includes('/v1')) {
      testPath = '/v1/models';
    }
    
    try {
      let testResponse = await fetch(fullUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });

      // Some providers (Cloudflare Workers AI) have no /models. Send an empty chat
      // request instead: a bad key gets 401/403, a good one 400 for the missing
      // fields - no tokens spent either way.
      let validStatuses = [];
      if (testResponse.status === 404 || testResponse.status === 405) {
        testPath = testPath.replace(/models$/, 'chat/completions');
        testResponse = await fetch(fullUrl.replace(/models$/, 'chat/completions'), {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: '{}'
        });
        validStatuses = [400, 422];
      }
      const keyAccepted = testResponse.ok || validStatuses.includes(testResponse.status);

      const responseText = await testResponse.text();
      const contentType = testResponse.headers.get('content-type') || 'unknown';
      const responseTime = Date.now() - startTime;
      
      // Store response data for viewing
      if (!quiet) this.storeResponseData(testId, {
        method: 'GET',
        endpoint: testPath,
        apiType: 'OpenAI',
        status: testResponse.status,
        statusText: testResponse.statusText,
        contentType: contentType,
        responseData: responseText,
        requestBody: null
      });
      
      // Log with structured format
      const error = !keyAccepted ? `API test failed: ${testResponse.status} ${upstreamErrorText(responseText) || testResponse.statusText}` : null;
      if (!quiet) this.logApiRequest(testId, 'GET', testPath, 'openai', testResponse.status, responseTime, error, 'admin-test');
      
      console.log(`[TEST-${testId}] GET ${testPath} (OpenAI) → ${testResponse.status} ${testResponse.statusText} | ${contentType} ${responseText.length}b`);
      
      return { 
        success: keyAccepted, 
        error: error
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      console.log(`[TEST-${testId}] GET ${testPath} (OpenAI) → ERROR: ${error.message}`);
      if (!quiet) this.logApiRequest(testId, 'GET', testPath, 'openai', null, responseTime, error.message, 'admin-test');
      
      return { success: false, error: error.message };
    }
  }
  
  /** Normalize a stored entry (new object format or legacy string) for the panel. */
  normalizeStoredLog(log) {
    if (typeof log !== 'string') return log;

    // Legacy string format: "2024-01-15T10:30:45.123Z [REQ-abc123] POST /endpoint"
    const match = log.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+(.*)$/);
    return {
      timestamp: match ? match[1] : new Date().toISOString(),
      requestId: match ? 'legacy' : 'unknown',
      method: 'UNKNOWN',
      endpoint: 'unknown',
      provider: 'unknown',
      status: null,
      responseTime: null,
      error: null,
      clientIp: null,
      message: match ? match[2] : log // Keep original message for backward compatibility
    };
  }

  async handleGetLogs(res, url = null) {
    try {
      const params = url ? url.searchParams : new URLSearchParams();
      const before = params.get('before');
      const parsedLimit = parseInt(params.get('limit'), 10);
      const limit = Number.isNaN(parsedLimit)
        ? this.apiLogs.memoryLimit
        : Math.min(Math.max(parsedLimit, 1), 1000);

      let source;
      let hasMore;

      if (before) {
        // "Load older" - only possible when entries are persisted to disk
        const cutoffTs = Date.parse(before);
        const older = isNaN(cutoffTs)
          ? { entries: [], hasMore: false }
          : this.apiLogs.listBefore(cutoffTs, limit);
        source = older.entries;
        hasMore = older.hasMore;
      } else {
        source = this.apiLogs.listRecent(limit);
        hasMore = this.apiLogs.isFileMode() && this.apiLogs.storedCount > source.length;
      }

      const recentLogs = source.map(log => this.normalizeStoredLog(log));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        logs: recentLogs,
        totalEntries: recentLogs.length,
        hasMore: hasMore,
        storage: {
          mode: this.apiLogs.settings.mode,
          retentionDays: this.apiLogs.settings.retentionDays,
          memoryLimit: this.apiLogs.memoryLimit,
          storedEntries: this.apiLogs.isFileMode() ? this.apiLogs.storedCount : recentLogs.length
        },
        format: 'json' // Indicate the new format
      }));
    } catch (error) {
      console.error('Failed to get logs:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Failed to retrieve logs',
        logs: []
      }));
    }
  }
  
  
  async handleGetStatus(res) {
    try {
      const providers = this.config.getProviders();
      let total = 0, enabled = 0;
      for (const [, cfg] of providers.entries()) { total++; if (!cfg.disabled) enabled++; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        uptimeMs: Date.now() - this.startTime,
        totalRequests: this.totalApiRequests,
        providers: total,
        providersEnabled: enabled,
        proxyEnabled: this.config.isProxyEnabled ? this.config.isProxyEnabled() : false,
        proxyCount: this.config.getProxyManager().getGreen().length, // usable right now, own + fetched
        telegramRunning: !!(this.telegramBot && this.telegramBot.isRunning && this.telegramBot.isRunning())
      }));
    } catch (error) {
      this.sendError(res, 500, 'Failed to get status');
    }
  }

  async handleClearLogs(res) {
    try {
      this.apiLogs.clear();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      this.sendError(res, 500, 'Failed to clear logs: ' + error.message);
    }
  }

  logApiRequest(requestId, method, endpoint, provider, status = null, responseTime = null, error = null, clientIp = null, keyInfo = null, proxyUsed = null, model = null) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      requestId: requestId || 'unknown',
      method: method || 'UNKNOWN',
      endpoint: endpoint || 'unknown',
      provider: provider || 'unknown',
      status: status,
      responseTime: responseTime,
      error: error,
      clientIp: clientIp,
      keyUsed: keyInfo ? keyInfo.keyUsed : null,
      failedKeys: keyInfo ? keyInfo.failedKeys : [],
      proxyUsed: proxyUsed || null,
      model: model || null
    };

    this.totalApiRequests++;

    // Keeps the entry hot in RAM and, in file mode, writes this request's file
    this.apiLogs.record(logEntry);
  }

  flushLogs(sync = false) {
    this.apiLogs.flush(sync);
  }

  
  // Helper method for backward compatibility - converts old string calls to new structured calls
  logApiRequestLegacy(message) {
    // Parse message to extract structured data
    const timestamp = new Date().toISOString();
    
    // Extract request ID if present
    const reqIdMatch = message.match(/\[REQ-([^\]]+)\]/);
    const requestId = reqIdMatch ? reqIdMatch[1] : 'unknown';
    
    // Extract method and endpoint
    const methodMatch = message.match(/(GET|POST|PUT|DELETE|PATCH)\s+([^\s]+)/);
    const method = methodMatch ? methodMatch[1] : 'UNKNOWN';
    const endpoint = methodMatch ? methodMatch[2] : 'unknown';
    
    // Extract provider
    let provider = 'unknown';
    if (message.includes('OpenAI')) provider = 'openai';
    else if (message.includes('Gemini')) provider = 'gemini';
    else if (message.includes('groq')) provider = 'groq';
    else if (message.includes('openrouter')) provider = 'openrouter';
    
    // Extract status code
    const statusMatch = message.match(/(\d{3})\s+/);
    const status = statusMatch ? parseInt(statusMatch[1]) : null;
    
    // Extract error information
    const error = message.includes('error') || message.includes('Error') || status >= 400 ? message : null;
    
    this.logApiRequest(requestId, method, endpoint, provider, status, null, error, null);
  }


  storeResponseData(testId, responseData) {
    // Stage the full payload for this request. In file mode it is written to
    // disk once logApiRequest() supplies the summary; admin key tests never get
    // a summary, so those stay in RAM only.
    const staged = (responseData && responseData.requestHeaders)
      ? { ...responseData, requestHeaders: ApiLogStore.maskHeaders(responseData.requestHeaders) }
      : responseData;
    this.apiLogs.stageDetail(testId, staged);
  }

  async handleGetResponse(res, path) {
    try {
      const testId = path.split('/').pop(); // Extract testId from path
      const responseData = this.apiLogs.getDetail(testId);
      
      if (!responseData) {
        this.sendError(res, 404, 'Response not found');
        return;
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseData));
    } catch (error) {
      this.sendError(res, 500, 'Failed to get response data');
    }
  }

  /**
   * Reorder keys for a provider
   * Body: { apiType: string, providerName: string, keys: string[] }
   */
  async handleReorderKeys(res, body) {
    try {
      const { apiType, providerName, keys } = JSON.parse(body);
      if (!apiType || !providerName || !Array.isArray(keys)) {
        this.sendError(res, 400, 'Missing apiType, providerName, or keys array');
        return;
      }

      const envPath = path.join(process.cwd(), '.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      const envVars = this.config.parseEnvFile(envContent);

      const envKey = `${apiType.toUpperCase()}_${providerName.toUpperCase()}_API_KEYS`;

      // Preserve disabled state: build new key string with ~ prefix for disabled keys
      const currentValue = envVars[envKey] || '';
      const currentParsed = this.config.parseApiKeysWithState(currentValue);
      const disabledSet = new Set(currentParsed.allKeys.filter(k => k.disabled).map(k => k.key));

      const newKeysStr = keys.map(k => disabledSet.has(k) ? `~${k}` : k).join(',');
      envVars[envKey] = newKeysStr;

      // Write updated env
      this.writeEnvFile(envVars);
      this.config.loadConfig();
      this.reinitializeClients();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      this.sendError(res, 500, 'Failed to reorder keys: ' + error.message);
    }
  }

  /**
   * Get key usage statistics for all providers
   */
  async handleGetKeyUsage(res) {
    try {
      const usage = {};

      const mapStats = (stats) => stats.map(s => ({
        key: s.key,
        fullKey: s.fullKey,
        usageCount: s.usageCount
      }));

      // Get usage from provider clients
      for (const [providerName, client] of this.providerClients.entries()) {
        if (client.keyRotator) {
          usage[providerName] = mapStats(client.keyRotator.getKeyUsageStats());
        }
      }

      // Legacy clients
      if (this.geminiClient && this.geminiClient.keyRotator && !usage['gemini']) {
        usage['gemini'] = mapStats(this.geminiClient.keyRotator.getKeyUsageStats());
      }
      if (this.openaiClient && this.openaiClient.keyRotator && !usage['openai']) {
        usage['openai'] = mapStats(this.openaiClient.keyRotator.getKeyUsageStats());
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(usage));
    } catch (error) {
      this.sendError(res, 500, 'Failed to get key usage');
    }
  }

  /**
   * Toggle a key's disabled state
   * Body: { apiType: string, providerName: string, keyIndex: number, disabled: boolean }
   */
  async handleToggleKey(res, body) {
    try {
      const { apiType, providerName, keyIndex, disabled } = JSON.parse(body);
      if (!apiType || !providerName || keyIndex === undefined) {
        this.sendError(res, 400, 'Missing apiType, providerName, or keyIndex');
        return;
      }

      const envPath = path.join(process.cwd(), '.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      const envVars = this.config.parseEnvFile(envContent);

      const envKey = `${apiType.toUpperCase()}_${providerName.toUpperCase()}_API_KEYS`;
      const currentValue = envVars[envKey] || '';
      const parsed = this.config.parseApiKeysWithState(currentValue);

      if (keyIndex < 0 || keyIndex >= parsed.allKeys.length) {
        this.sendError(res, 400, 'Invalid key index');
        return;
      }

      parsed.allKeys[keyIndex].disabled = disabled;

      // Rebuild key string
      const newKeysStr = parsed.allKeys.map(k => k.disabled ? `~${k.key}` : k.key).join(',');
      envVars[envKey] = newKeysStr;

      this.writeEnvFile(envVars);
      this.config.loadConfig();
      this.reinitializeClients();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      this.sendError(res, 500, 'Failed to toggle key: ' + error.message);
    }
  }

  /**
   * Toggle a provider's disabled state
   * Body: { apiType: string, providerName: string, disabled: boolean }
   */
  async handleToggleProvider(res, body) {
    try {
      const { apiType, providerName, disabled } = JSON.parse(body);
      if (!apiType || !providerName) {
        this.sendError(res, 400, 'Missing apiType or providerName');
        return;
      }

      const envPath = path.join(process.cwd(), '.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      const envVars = this.config.parseEnvFile(envContent);

      const envKey = `${apiType.toUpperCase()}_${providerName.toUpperCase()}_DISABLED`;

      if (disabled) {
        envVars[envKey] = 'true';
      } else {
        delete envVars[envKey];
      }

      this.writeEnvFile(envVars);
      this.config.loadConfig();
      this.reinitializeClients();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      this.sendError(res, 500, 'Failed to toggle provider: ' + error.message);
    }
  }

  /**
   * Return current outbound-proxy settings.
   * Full URLs (incl. credentials) are returned so the admin can edit them —
   * consistent with the existing /admin/api/env-file endpoint, and gated by
   * admin authentication.
   */
  async handleGetProxySettings(res) {
    try {
      const envPath = path.join(process.cwd(), '.env');
      const envVars = this.config.parseEnvFile(fs.readFileSync(envPath, 'utf8'));

      const proxies = (envVars.PROXY_URLS || '')
        .split(',')
        .map(u => u.trim())
        .filter(u => u.length > 0)
        .map(url => ({ url, masked: ProxyManager.maskProxyUrl(url) }));

      const enabled = (envVars.PROXY_ENABLED || '').trim().toLowerCase() === 'true';
      const autoFetch = (envVars.PROXY_AUTO_FETCH || '').trim().toLowerCase() === 'true';

      const providers = [];
      for (const [name, provider] of this.config.getProviders().entries()) {
        providers.push({ name, apiType: provider.apiType, proxy: !!provider.proxy, disabled: !!provider.disabled });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        enabled,
        autoFetch,
        goodMs: this.config.getProxyManager().goodMs,
        maxTries: this.config.getProxyManager().maxTries,
        proxies,
        providers,
        auto: this.proxyPool.getStatus(),
        pool: this.config.getProxyManager().getStats(),
        details: this.config.getProxyManager().getProxyDetails()
      }));
    } catch (error) {
      this.sendError(res, 500, 'Failed to read proxy settings');
    }
  }

  /**
   * Update outbound-proxy settings.
   * Body: { enabled: boolean, proxies: string[] }
   */
  async handleUpdateProxySettings(res, body) {
    try {
      const { proxies, autoFetch, providerProxies, goodMs, maxTries } = JSON.parse(body);

      // Green/red line and tries per request
      const numberIn = (v, min, max) => v === undefined || (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max);
      if (!numberIn(goodMs, 100, 30000) || !numberIn(maxTries, 1, 50)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Green below must be 100–30000 ms and tries per request 1–50' }));
        return;
      }

      const list = Array.isArray(proxies)
        ? proxies.map(p => String(p).trim()).filter(p => p.length > 0)
        : [];

      // Validate every proxy URL before persisting anything
      const invalid = [];
      for (const url of list) {
        try {
          ProxyManager.parse(url);
        } catch (e) {
          invalid.push(`${ProxyManager.maskProxyUrl(url)} (${e.message})`);
        }
      }
      if (invalid.length > 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Invalid proxy URL(s): ${invalid.join('; ')}` }));
        return;
      }

      const envPath = path.join(process.cwd(), '.env');
      const envVars = this.config.parseEnvFile(fs.readFileSync(envPath, 'utf8'));

      if (list.length > 0) {
        envVars.PROXY_URLS = list.join(',');
      } else {
        delete envVars.PROXY_URLS;
      }

      if (goodMs !== undefined) envVars.PROXY_GOOD_MS = String(Number(goodMs));
      if (maxTries !== undefined) envVars.PROXY_MAX_TRIES = String(Number(maxTries));

      const useAuto = !!autoFetch;
      if (useAuto) {
        envVars.PROXY_AUTO_FETCH = 'true';
      } else {
        delete envVars.PROXY_AUTO_FETCH;
      }

      // Per-provider opt-in replaces the old global switch. Drop the legacy key
      // so it stops acting as a default once explicit choices exist.
      delete envVars.PROXY_ENABLED;

      let proxiedCount = 0;
      if (providerProxies && typeof providerProxies === 'object') {
        for (const [name, provider] of this.config.getProviders().entries()) {
          const key = `${String(provider.apiType).toUpperCase()}_${String(name).toUpperCase()}_PROXY`;
          if (providerProxies[name]) {
            envVars[key] = 'true';
            proxiedCount += 1;
          } else {
            delete envVars[key];
          }
        }
      } else {
        // No provider map sent - keep whatever is already set
        for (const [name, provider] of this.config.getProviders().entries()) {
          if (provider.proxy) {
            envVars[`${String(provider.apiType).toUpperCase()}_${String(name).toUpperCase()}_PROXY`] = 'true';
            proxiedCount += 1;
          }
        }
      }

      const enable = proxiedCount > 0 && (list.length > 0 || useAuto);

      this.writeEnvFile(envVars);
      this.config.loadConfig();
      this.reinitializeClients();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        count: list.length,
        enabled: enable,
        proxiedProviders: proxiedCount,
        autoFetch: useAuto,
        auto: this.proxyPool.getStatus()
      }));
    } catch (error) {
      this.sendError(res, 500, 'Failed to update proxy settings: ' + error.message);
    }
  }

  /**
   * Test a single proxy by fetching the current outbound IP through it.
   * Body: { proxy: string }
   */
  async handleTestProxy(res, body) {
    try {
      const { proxy } = JSON.parse(body);
      if (!proxy || !String(proxy).trim()) {
        this.sendError(res, 400, 'Missing proxy URL');
        return;
      }
      const result = await this.testProxyConnection(String(proxy).trim());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      this.sendError(res, 500, 'Failed to test proxy: ' + error.message);
    }
  }

  /**
   * Route a request to an IP-echo service through the given proxy and return
   * the observed outbound IP. Uses only Node built-ins via ProxyManager.
   */
  /**
   * Light-weight poll target for the panel's progress bar. Deliberately avoids
   * re-reading .env the way the full settings endpoint does, since this is hit
   * once a second while a sweep runs.
   */
  async handleGetProxyStatus(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      auto: this.proxyPool.getStatus(),
      pool: this.config.getProxyManager().getStats(),
      details: this.config.getProxyManager().getProxyDetails()
    }));
  }

  async handleRefreshProxyPool(res) {
    try {
      if (!this.proxyPool.enabled) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Auto-fetch is off — turn it on and save first' }));
        return;
      }

      // A sweep takes minutes - longer than an HTTP request should stay open -
      // so start it and answer now; the panel follows it via /proxy/status.
      this.proxyPool.refresh('manual', true).catch((e) => console.log(`[PROXY-POOL] Refresh failed: ${e.message}`));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, auto: this.proxyPool.getStatus(), pool: this.config.getProxyManager().getStats() }));
    } catch (error) {
      this.sendError(res, 500, 'Failed to refresh proxy pool: ' + error.message);
    }
  }

  testProxyConnection(proxyUrl) {
    return new Promise((resolve) => {
      let agent;
      try {
        agent = ProxyManager.createAgent(proxyUrl);
      } catch (e) {
        return resolve({ success: false, error: 'Invalid proxy URL: ' + e.message });
      }

      const startTime = Date.now();
      const options = {
        hostname: 'api.ipify.org',
        port: 443,
        path: '/?format=json',
        method: 'GET',
        agent,
        headers: { 'Accept': 'application/json', 'User-Agent': 'rotato-proxy-test' },
        timeout: 15000,
      };

      const req = https.request(options, (r) => {
        let data = '';
        r.on('data', (c) => { data += c; });
        r.on('end', () => {
          const ms = Date.now() - startTime;
          let ip = null;
          try { ip = JSON.parse(data).ip; } catch (e) { ip = data.trim(); }
          if (r.statusCode === 200 && ip) {
            resolve({ success: true, ip, ms, masked: ProxyManager.maskProxyUrl(proxyUrl) });
          } else {
            resolve({ success: false, error: `Unexpected response (HTTP ${r.statusCode})`, ms });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Timed out after 15s (proxy unreachable or too slow)' });
      });
      req.on('error', (e) => {
        resolve({ success: false, error: e.message });
      });
      req.end();
    });
  }

  /**
   * Write env vars back to .env file (shared helper)
   */
  writeEnvFile(rawVars) {
    const envPath = path.join(process.cwd(), '.env');

    // One line per setting: a newline in a value would inject extra settings
    // (e.g. a second ADMIN_PASSWORD), and a bad name would corrupt the file
    const envVars = {};
    for (const [key, value] of Object.entries(rawVars || {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      envVars[key] = String(value == null ? '' : value).replace(/[\r\n]+/g, '');
    }

    let envContent = '# API Key Rotator Configuration\n';
    envContent += `# Last updated: ${new Date().toISOString()}\n\n`;

    const basicConfig = {};
    const providers = {};
    const otherConfig = {};

    Object.entries(envVars).forEach(([key, value]) => {
      if (key === 'BASE_URL' && (!value || value.trim() === '')) return;

      if (key === 'PORT' || key === 'ADMIN_PASSWORD') {
        basicConfig[key] = value;
      } else if (key.endsWith('_API_KEYS') || key.endsWith('_BASE_URL') || key.endsWith('_MODELS_URL') || key.endsWith('_ACCESS_KEY') || key.endsWith('_DEFAULT_MODEL') || key.endsWith('_MODEL_HISTORY') || key.endsWith('_DISABLED') || key.endsWith('_PROXY')) {
        const match = key.match(/^(.+?)_(.+?)_(API_KEYS|BASE_URL|MODELS_URL|ACCESS_KEY|DEFAULT_MODEL|MODEL_HISTORY|DISABLED|PROXY)$/);
        if (match) {
          const apiType = match[1];
          const provName = match[2];
          const keyType = match[3];
          const providerKey = `${apiType}_${provName}`;

          if (!providers[providerKey]) {
            providers[providerKey] = { apiType, providerName: provName, keys: '', baseUrl: '', modelsUrl: '', accessKey: '', defaultModel: '', modelHistory: '', disabled: '', proxy: '' };
          }

          if (keyType === 'API_KEYS') providers[providerKey].keys = value;
          else if (keyType === 'BASE_URL') providers[providerKey].baseUrl = value;
          else if (keyType === 'MODELS_URL') providers[providerKey].modelsUrl = value;
          else if (keyType === 'ACCESS_KEY') providers[providerKey].accessKey = value;
          else if (keyType === 'DEFAULT_MODEL') providers[providerKey].defaultModel = value;
          else if (keyType === 'MODEL_HISTORY') providers[providerKey].modelHistory = value;
          else if (keyType === 'DISABLED') providers[providerKey].disabled = value;
          else if (keyType === 'PROXY') providers[providerKey].proxy = value;
        } else {
          otherConfig[key] = value;
        }
      } else {
        otherConfig[key] = value;
      }
    });

    if (Object.keys(basicConfig).length > 0) {
      envContent += '# Basic Configuration\n';
      for (const [key, value] of Object.entries(basicConfig)) {
        envContent += `${key}=${value}\n`;
      }
      envContent += '\n';
    }

    const writeProviders = (list, comment) => {
      if (list.length > 0) {
        envContent += `# ${comment}\n`;
        for (const p of list) {
          if (p.keys) envContent += `${p.apiType}_${p.providerName}_API_KEYS=${p.keys}\n`;
          if (p.baseUrl) envContent += `${p.apiType}_${p.providerName}_BASE_URL=${p.baseUrl}\n`;
          if (p.modelsUrl) envContent += `${p.apiType}_${p.providerName}_MODELS_URL=${p.modelsUrl}\n`;
          if (p.accessKey) envContent += `${p.apiType}_${p.providerName}_ACCESS_KEY=${p.accessKey}\n`;
          if (p.defaultModel) envContent += `${p.apiType}_${p.providerName}_DEFAULT_MODEL=${p.defaultModel}\n`;
          if (p.modelHistory) envContent += `${p.apiType}_${p.providerName}_MODEL_HISTORY=${p.modelHistory}\n`;
          // Only persist these flags for a provider that exists (keys, or a keyless
          // provider's base URL) - an orphaned flag would render as a ghost provider.
          if (p.disabled === 'true' && (p.keys || p.baseUrl)) envContent += `${p.apiType}_${p.providerName}_DISABLED=true\n`;
          if (p.proxy === 'true' && (p.keys || p.baseUrl)) envContent += `${p.apiType}_${p.providerName}_PROXY=true\n`;
          envContent += '\n';
        }
      }
    };

    const allProviders = Object.values(providers).sort((a, b) => a.providerName.toLowerCase().localeCompare(b.providerName.toLowerCase()));
    writeProviders(allProviders.filter(p => p.apiType === 'OPENAI'), 'OpenAI Compatible Providers');
    writeProviders(allProviders.filter(p => p.apiType === 'GEMINI'), 'Gemini Providers');
    writeProviders(allProviders.filter(p => p.apiType !== 'OPENAI' && p.apiType !== 'GEMINI'), 'Other Providers');

    if (Object.keys(otherConfig).length > 0) {
      envContent += '# Additional Configuration\n';
      for (const [key, value] of Object.entries(otherConfig)) {
        envContent += `${key}=${value}\n`;
      }
    }

    fs.writeFileSync(envPath, envContent);
  }

  serveAdminPanel(res) {
    try {
      const htmlPath = path.join(process.cwd(), 'public', 'admin.html');
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (error) {
      this.sendError(res, 500, 'Admin panel not found');
    }
  }

  /**
   * Reinitialize API clients with updated configuration
   * Called after environment variables are updated via admin panel
   */
  reinitializeClients() {
    console.log('[SERVER] Reinitializing API clients with updated configuration...');
    
    // Clear all provider clients
    this.providerClients.clear();
    
    const proxyManager = this.config.getProxyManager();

    // Reinitialize legacy clients for backward compatibility
    if (this.config.hasGeminiKeys()) {
      const geminiKeyRotator = new this.KeyRotator(this.config.getGeminiApiKeys(), 'gemini');
      this.geminiClient = new this.GeminiClient(geminiKeyRotator, this.config.getGeminiBaseUrl(), proxyManager);
      console.log('[SERVER] Legacy Gemini client reinitialized');
    } else {
      this.geminiClient = null;
      console.log('[SERVER] Legacy Gemini client disabled (no keys available)');
    }

    if (this.config.hasOpenaiKeys()) {
      const openaiKeyRotator = new this.KeyRotator(this.config.getOpenaiApiKeys(), 'openai');
      this.openaiClient = new this.OpenAIClient(openaiKeyRotator, this.config.getOpenaiBaseUrl(), proxyManager);
      console.log('[SERVER] Legacy OpenAI client reinitialized');
    } else {
      this.openaiClient = null;
      console.log('[SERVER] Legacy OpenAI client disabled (no keys available)');
    }
    
    // API_LOGS may have changed in the same save
    this.applyLogSettings();

    // loadConfig() builds a fresh ProxyManager, so the auto pool has to be
    // re-attached or saving anything would silently wipe it
    this.applyProxySettings();

    console.log(`[SERVER] ${this.config.getProviders().size} providers available for dynamic initialization`);
  }

  /**
   * Point the pool's validation probes at a host we actually talk to, so a
   * proxy is only kept if it can reach a real provider.
   */
  getProxyProbeTarget() {
    // Prefer a provider that is actually routed through the pool
    const providers = [...this.config.getProviders().values()]
      .filter(p => !p.disabled && p.baseUrl)
      .sort((a, b) => !!b.proxy - !!a.proxy);
    for (const provider of providers) {
      try {
        return new URL(provider.baseUrl).hostname;
      } catch (e) { /* try the next provider */ }
    }
    return 'api.openai.com';
  }

  /**
   * Pick up the proxy list and health saved before the last restart, then keep
   * the file current: written at most once a minute (only when something
   * changed) and on shutdown.
   */
  restoreProxyCache() {
    const cache = proxyCache.load();
    if (cache && cache.live.length) this.proxyPool.restore(cache);
    this.applyProxySettings();

    if (cache) {
      // After applyProxySettings: seeding the list from the pool resets health,
      // and the saved strikes, bench and speeds should win
      const manager = this.config.getProxyManager();
      const known = new Set(manager.proxyUrls);
      for (const [url, entry] of Object.entries(cache.health)) {
        if (known.has(url) && entry && typeof entry === 'object') manager.health.set(url, entry);
      }
      const ageMin = cache.lastRefreshAt ? Math.round((Date.now() - cache.lastRefreshAt) / 60000) : null;
      console.log(`[PROXY-CACHE] Restored ${this.proxyPool.live.length} proxies from ${proxyCache.FILE}${ageMin != null ? ` (fetched ${ageMin}m ago)` : ''}`);
    }

    this._proxyCacheJson = null;
    this.proxyCacheTimer = setInterval(() => this.saveProxyCache(), 60 * 1000);
    if (this.proxyCacheTimer.unref) this.proxyCacheTimer.unref();
  }

  saveProxyCache() {
    if (this._stopping) return; // stopping empties the pool; keep the last real list
    this._proxyCacheJson = proxyCache.save(this.proxyPool, this.config.getProxyManager(), this._proxyCacheJson);
  }

  /** [name, provider] for enabled providers routed through the proxy, with a usable base URL. */
  proxyedProviders() {
    return [...this.config.getProviders().entries()].filter(([, p]) => {
      if (!p.proxy || p.disabled || !p.keys.length) return false;
      try { new URL(p.baseUrl); return true; } catch (e) { return false; }
    });
  }

  /**
   * Background check: list one provider's models through this proxy. Takes
   * turns across proxied providers and their keys. Reaching the provider at all
   * counts as working; 403/407 or no connection counts against the proxy.
   */
  proxyModelCheck(proxyUrl) {
    const providers = this.proxyedProviders();
    if (!providers.length) return Promise.resolve();
    const turn = this._modelCheckTurn++;
    const [, provider] = providers[turn % providers.length];
    const key = provider.keys[Math.floor(turn / providers.length) % provider.keys.length];
    const manager = this.config.getProxyManager();

    let options;
    try {
      // A client without a proxy manager just builds the URL and auth headers;
      // the agent is set here, so the shuffle bag isn't touched
      const client = provider.apiType === 'gemini'
        ? new this.GeminiClient(null, provider.baseUrl, null)
        : new this.OpenAIClient(null, provider.baseUrl, null);
      const upstream = this.upstreamPath('GET', '/models', provider);
      options = provider.apiType === 'gemini'
        ? client._buildRequestOptions('GET', upstream, null, {}, key, true)
        : client._buildRequestOptions('GET', upstream, null, {}, key);
    } catch (e) {
      return Promise.resolve(); // e.g. a key missing a {placeholder} value - not the proxy's fault
    }

    return new Promise((resolve) => {
      const req = https.request({ ...options, agent: manager.getAgentFor(proxyUrl), timeout: 15000 }, (r) => {
        r.resume();
        r.on('end', () => {
          if (r.statusCode === 403 || r.statusCode === 407) manager.reportFailure(proxyUrl);
          else manager.reportSuccess(proxyUrl);
          resolve();
        });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', () => { manager.reportFailure(proxyUrl); resolve(); });
      req.end();
    });
  }

  /**
   * Sync the proxy pool with the current settings and attach it to the live
   * ProxyManager. Called at boot and after every config reload.
   */
  applyProxySettings() {
    const manager = this.config.getProxyManager();

    // A settings save builds a new manager; keep what the checks have learned
    // (speeds, strikes, bench) instead of starting from scratch
    if (this._proxyManager && this._proxyManager !== manager) {
      for (const [url, entry] of this._proxyManager.health) manager.health.set(url, entry);
    }
    this._proxyManager = manager;

    // When every proxy is benched, go and fetch a fresh batch. The pool applies
    // its own minimum gap so a burst of failures can't hammer the source.
    // Green running low: re-check the red/benched ones now, and fetch a fresh list
    manager.onPoolExhausted = () => {
      this.proxyChecker.rescue();
      if (this.proxyPool.enabled) this.proxyPool.refresh('pool exhausted');
    };
    manager.isLoading = () => this.proxyPool.enabled && this.proxyPool.refreshing;

    // Fetch whenever auto-fetch is on, even before any provider is routed
    // through it - routing is per provider, so this only fills the list.
    if (this.config.isProxyAutoFetchEnabled()) {
      this.proxyPool.start();
    } else {
      this.proxyPool.stop();
    }

    if (this.config.isProxyEnabled()) this.proxyChecker.start();
    else this.proxyChecker.stop();

    manager.setAutoProxies(this.proxyPool.live);
  }

  async initTelegramBot() {
    try {
      const envPath = path.join(process.cwd(), '.env');
      if (!fs.existsSync(envPath)) return;
      const envContent = fs.readFileSync(envPath, 'utf8');
      const envVars = this.config.parseEnvFile(envContent);

      const token = envVars.TELEGRAM_BOT_TOKEN;
      const allowedUsers = envVars.TELEGRAM_ALLOWED_USERS
        ? envVars.TELEGRAM_ALLOWED_USERS.split(',').map(s => s.trim()).filter(Boolean)
        : [];

      if (token) {
        await this.telegramBot.start(token, allowedUsers);
      }
    } catch (err) {
      console.log(`[TELEGRAM] Init error: ${err.message}`);
    }
  }

  async handleGetTelegramSettings(res) {
    try {
      const envPath = path.join(process.cwd(), '.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      const envVars = this.config.parseEnvFile(envContent);

      const apiLogs = this.apiLogs.settings;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        botToken: envVars.TELEGRAM_BOT_TOKEN || '',
        allowedUsers: envVars.TELEGRAM_ALLOWED_USERS || '',
        defaultStatusCodes: envVars.DEFAULT_STATUS_CODES || '429',
        apiLogsMode: apiLogs.mode,
        apiLogsRetentionDays: apiLogs.retentionDays || 7,
        apiLogsStoredEntries: this.apiLogs.isFileMode() ? this.apiLogs.storedCount : this.apiLogs.buffer.length,
        botRunning: this.telegramBot.polling
      }));
    } catch (error) {
      this.sendError(res, 500, 'Failed to read telegram settings');
    }
  }

  async handleUpdateTelegramSettings(res, body) {
    try {
      const { botToken, allowedUsers, defaultStatusCodes, apiLogsMode, apiLogsRetentionDays } = JSON.parse(body);
      const envPath = path.join(process.cwd(), '.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      const envVars = this.config.parseEnvFile(envContent);

      if (botToken !== undefined) {
        if (botToken) {
          envVars.TELEGRAM_BOT_TOKEN = botToken;
        } else {
          delete envVars.TELEGRAM_BOT_TOKEN;
        }
      }
      if (allowedUsers !== undefined) {
        if (allowedUsers) {
          envVars.TELEGRAM_ALLOWED_USERS = allowedUsers;
        } else {
          delete envVars.TELEGRAM_ALLOWED_USERS;
        }
      }
      let rotatesOn = null;
      if (defaultStatusCodes !== undefined) {
        // Codes, ranges and comparisons; refuse the save rather than silently drop a typo
        const parsed = parseStatusCodes(defaultStatusCodes);
        if (parsed.invalid.length > 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `Not a status code, range or comparison: ${parsed.invalid.join(', ')}. Use codes like 429, ranges like 420-429, or >=500.`
          }));
          return;
        }
        if (parsed.parts.length > 0) {
          envVars.DEFAULT_STATUS_CODES = parsed.parts.join(',');
          rotatesOn = { codes: describeStatusCodes(parsed.codes), count: parsed.codes.size };
        } else {
          delete envVars.DEFAULT_STATUS_CODES;
        }
      }
      // Keep-alive pings were removed; drop the old setting if it's still there
      delete envVars.KEEP_ALIVE_MINUTES;

      if (apiLogsMode !== undefined) {
        // API_LOGS only chooses where request logs live - it can't switch logging off
        if (apiLogsMode === 'file') {
          const days = parseInt(apiLogsRetentionDays);
          envVars.API_LOGS = `${days > 0 ? days : 7}D`;
        } else {
          envVars.API_LOGS = 'memory';
        }
      }

      this.writeEnvFile(envVars);

      // Adopt the new log setting immediately. Parsing just this section avoids
      // a full config reload, which would rebuild every provider needlessly.
      this.config.parseApiLogsConfig(envVars);
      this.applyLogSettings();

      // Restart bot with new settings
      const token = envVars.TELEGRAM_BOT_TOKEN;
      const users = envVars.TELEGRAM_ALLOWED_USERS
        ? envVars.TELEGRAM_ALLOWED_USERS.split(',').map(s => s.trim()).filter(Boolean)
        : [];

      if (token) {
        await this.telegramBot.start(token, users);
      } else {
        await this.telegramBot.stop();
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        botRunning: this.telegramBot.polling,
        defaultStatusCodes: envVars.DEFAULT_STATUS_CODES || '429',
        rotatesOn,
        apiLogsMode: this.apiLogs.settings.mode,
        apiLogsRetentionDays: this.apiLogs.settings.retentionDays || 7
      }));
    } catch (error) {
      this.sendError(res, 500, 'Failed to update telegram settings: ' + error.message);
    }
  }

  stop() {
    this.apiLogs.stop(); // Sync-flush the pending index lines before shutdown
    if (this.proxyCacheTimer) clearInterval(this.proxyCacheTimer);
    this.saveProxyCache();
    this._stopping = true;    this.proxyPool.stop();
    this.proxyChecker.stop();
    if (this.telegramBot) this.telegramBot.stop();
    if (this.server) {
      this.server.close();
    }
  }
}

ProxyServer.SESSION_MS = 24 * 60 * 60 * 1000; // matches the cookie's lifetime

module.exports = ProxyServer;
module.exports.requestModel = requestModel;