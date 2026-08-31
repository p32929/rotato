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

    // Rate limiting for login
    this.failedLoginAttempts = 0;
    this.loginBlockedUntil = null;

    // Store required classes for reinitialization
    this.KeyRotator = require('./keyRotator');
    this.GeminiClient = require('./geminiClient');
    this.OpenAIClient = require('./openaiClient');

    // Auto-fetched proxy pool. Lives in memory; feeds the ProxyManager.
    this.proxyPool = new ProxyPool({
      getProbeTarget: () => this.getProxyProbeTarget(),
      onUpdate: () => this.config.getProxyManager().setAutoProxies(this.proxyPool.live),
    });

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
    this.applyProxySettings();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
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

    try {
      const body = await this.readRequestBody(req);

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
      if (req.url.startsWith('/admin')) {
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
          this.logApiRequest(requestId, req.method, req.url, 'unknown', 400, responseTime, 'Invalid API path', clientIp);
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
          this.logApiRequest(requestId, req.method, path, providerName, 503, responseTime, `Provider '${providerName}' is disabled`, clientIp);
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
          this.logApiRequest(requestId, req.method, path, providerName, 401, responseTime, 'Invalid or missing ACCESS_KEY', clientIp);
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
          this.logApiRequest(requestId, req.method, path, providerName, 503, responseTime, `Provider '${providerName}' not configured`, clientIp);
        }

        this.sendError(res, 503, `Provider '${providerName}' not configured`);
        return;
      }

      // Pass custom status codes to client if provided
      if (customStatusCodes) {
        console.log(`[REQ-${requestId}] Using custom status codes for rotation: ${Array.from(customStatusCodes).join(', ')}`);
      }

      // Detect streaming request
      const isStreaming = this.isStreamingRequest(body);
      if (isStreaming) {
        console.log(`[REQ-${requestId}] Streaming request detected`);
      }

      response = await client.makeRequest(req.method, path, body, headers, customStatusCodes, isStreaming);

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

          if (isApiCall) {
            const responseTime = Date.now() - startTime;
            const error = response.statusCode >= 400 ? `HTTP ${response.statusCode}` : null;
            this.logApiRequest(requestId, req.method, path, providerName, response.statusCode, responseTime, error, clientIp, keyInfo, proxyUsed);
          }
          console.log(`[REQ-${requestId}] Streaming response completed`);
        });

        response.stream.on('error', (err) => {
          console.log(`[REQ-${requestId}] Streaming error: ${err.message}`);
          if (!res.headersSent) {
            this.sendError(res, 502, 'Streaming error');
          }
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
          this.logApiRequest(requestId, req.method, path, providerName, response.statusCode, responseTime, error, clientIp, keyInfo, proxyUsed);
        }

        this.sendResponse(res, response);
      }
    } catch (error) {
      console.log(`[REQ-${requestId}] Request handling error: ${error.message}`);
      console.log(`[REQ-${requestId}] Response: 500 Internal Server Error`);
      
      if (isApiCall) {
        const responseTime = Date.now() - startTime;
        this.logApiRequest(requestId, req.method, req.url, 'unknown', 500, responseTime, error.message, clientIp);
      }
      
      this.sendError(res, 500, 'Internal server error');
    }
  }

  readRequestBody(req) {
    return new Promise((resolve) => {
      let body = '';
      
      req.on('data', (chunk) => {
        body += chunk;
      });
      
      req.on('end', () => {
        resolve(body || null);
      });
    });
  }

  parseRoute(url) {
    if (!url) return null;
    
    const urlObj = new URL(url, 'http://localhost');
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
    // Extract [STATUS_CODES:...] from the Authorization header
    const match = authHeader?.match(/\[STATUS_CODES:([^\]]+)\]/i);
    if (!match) return null;

    const statusCodeStr = match[1];
    const codes = new Set();

    // Parse each part (e.g., "429", "400-420", "500+", "400=+")
    const parts = statusCodeStr.split(',').map(s => s.trim());

    for (const part of parts) {
      if (part.includes('-')) {
        // Range: 400-420
        const [start, end] = part.split('-').map(n => parseInt(n.trim()));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) {
            codes.add(i);
          }
        }
      } else if (part.endsWith('=+')) {
        // Equal or greater: 400=+
        const base = parseInt(part.slice(0, -2).trim());
        if (!isNaN(base)) {
          // Add codes from base to 599 (reasonable upper limit for HTTP status codes)
          for (let i = base; i <= 599; i++) {
            codes.add(i);
          }
        }
      } else if (part.endsWith('+')) {
        // Greater than: 400+
        const base = parseInt(part.slice(0, -1).trim());
        if (!isNaN(base)) {
          // Add codes from base+1 to 599
          for (let i = base + 1; i <= 599; i++) {
            codes.add(i);
          }
        }
      } else {
        // Single code: 429
        const code = parseInt(part.trim());
        if (!isNaN(code)) {
          codes.add(code);
        }
      }
    }

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
   * Detect if a request body contains stream: true
   */
  isStreamingRequest(body) {
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
      const isBlocked = this.loginBlockedUntil && now < this.loginBlockedUntil;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        blocked: isBlocked,
        blockedUntil: this.loginBlockedUntil,
        remainingSeconds: isBlocked ? Math.ceil((this.loginBlockedUntil - now) / 1000) : 0,
        failedAttempts: this.failedLoginAttempts
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
    const cookies = this.parseCookies(req.headers.cookie);
    return cookies.adminSession === this.adminSessionToken && this.adminSessionToken !== null;
  }

  async handleAdminLogin(req, res, body) {
    try {
      // Check if login is currently blocked
      if (this.loginBlockedUntil && Date.now() < this.loginBlockedUntil) {
        const remainingSeconds = Math.ceil((this.loginBlockedUntil - Date.now()) / 1000);
        const remainingMinutes = Math.ceil(remainingSeconds / 60);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: `Too many failed login attempts. Please wait ${remainingMinutes} minute(s).`,
          blockedUntil: this.loginBlockedUntil,
          remainingSeconds: remainingSeconds
        }));
        return;
      }

      const data = JSON.parse(body);
      const adminPassword = this.getAdminPassword();

      if (data.password === adminPassword) {
        // Successful login - reset counters
        this.failedLoginAttempts = 0;
        this.loginBlockedUntil = null;
        this.adminSessionToken = this.generateSessionToken();

        // Set session cookie (expires in 24 hours)
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toUTCString();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `adminSession=${this.adminSessionToken}; HttpOnly; Expires=${expires}; Path=/admin`
        });
        res.end(JSON.stringify({ success: true }));
      } else {
        // Failed login - increment counter
        this.failedLoginAttempts++;
        const attemptsRemaining = 5 - this.failedLoginAttempts;

        // Block if reached 5 attempts
        if (this.failedLoginAttempts >= 5) {
          this.loginBlockedUntil = Date.now() + (5 * 60 * 1000); // 5 minutes
          console.log('[SECURITY] Login blocked due to 5 failed attempts. Blocked until:', new Date(this.loginBlockedUntil).toISOString());
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Too many failed login attempts. Please wait 5 minutes.',
            blockedUntil: this.loginBlockedUntil,
            remainingSeconds: 300
          }));
        } else {
          console.log(`[SECURITY] Failed login attempt ${this.failedLoginAttempts}/5`);
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
      return envVars.ADMIN_PASSWORD;
    } catch (error) {
      return null;
    }
  }
  
  
  async handleUpdateEnvVars(res, body) {
    try {
      const envVars = JSON.parse(body);
      const envPath = path.join(process.cwd(), '.env');

      // Read current env to preserve admin password and disabled states
      const currentEnvContent = fs.readFileSync(envPath, 'utf8');
      const currentEnvVars = this.config.parseEnvFile(currentEnvContent);

      // Merge with new vars but preserve admin password
      const finalEnvVars = { ...envVars };
      if (currentEnvVars.ADMIN_PASSWORD) {
        finalEnvVars.ADMIN_PASSWORD = currentEnvVars.ADMIN_PASSWORD;
      }

      // Preserve _DISABLED, TELEGRAM_, and DEFAULT_STATUS_CODES entries from current env if not in new vars
      for (const [key, value] of Object.entries(currentEnvVars)) {
        if (key in finalEnvVars) continue;

        if (key.endsWith('_DISABLED') || key.endsWith('_PROXY')) {
          // Only preserve a provider's flags if that provider still exists (i.e.
          // its API keys are present in the new payload). Otherwise a deleted
          // provider's flag would resurrect it as a keyless ghost on reload.
          const apiKeysKey = key.replace(/_(DISABLED|PROXY)$/, '_API_KEYS');
          if (apiKeysKey in finalEnvVars) {
            finalEnvVars[key] = value;
          }
        } else if (key.startsWith('TELEGRAM_') || key.startsWith('PROXY_') || key === 'DEFAULT_STATUS_CODES' || key === 'KEEP_ALIVE_MINUTES' || key === 'API_LOGS') {
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
      const { apiType, apiKey, baseUrl } = JSON.parse(body);
      let testResult = { success: false, error: 'Unknown API type' };
      
      if (apiType === 'gemini') {
        // Test Gemini API key with custom base URL if provided
        testResult = await this.testGeminiKey(apiKey, baseUrl);
      } else if (apiType === 'openai') {
        // Test OpenAI API key with custom base URL if provided
        testResult = await this.testOpenaiKey(apiKey, baseUrl);
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(testResult));
    } catch (error) {
      this.sendError(res, 500, 'Failed to test API key');
    }
  }
  
  async testGeminiKey(apiKey, baseUrl = null) {
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
      this.storeResponseData(testId, {
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
      const error = !testResponse.ok ? `API test failed: ${testResponse.status} ${testResponse.statusText}` : null;
      this.logApiRequest(testId, 'GET', testPath, 'gemini', testResponse.status, responseTime, error, 'admin-test');
      
      console.log(`[TEST-${testId}] GET ${testPath} (Gemini) → ${testResponse.status} ${testResponse.statusText} | ${contentType} ${responseText.length}b`);
      
      return { 
        success: testResponse.ok, 
        error: error
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      console.log(`[TEST-${testId}] GET ${testPath} (Gemini) → ERROR: ${error.message}`);
      this.logApiRequest(testId, 'GET', testPath, 'gemini', null, responseTime, error.message, 'admin-test');
      
      return { success: false, error: error.message };
    }
  }
  
  async testOpenaiKey(apiKey, baseUrl = null) {
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
      const testResponse = await fetch(fullUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      
      const responseText = await testResponse.text();
      const contentType = testResponse.headers.get('content-type') || 'unknown';
      const responseTime = Date.now() - startTime;
      
      // Store response data for viewing
      this.storeResponseData(testId, {
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
      const error = !testResponse.ok ? `API test failed: ${testResponse.status} ${testResponse.statusText}` : null;
      this.logApiRequest(testId, 'GET', testPath, 'openai', testResponse.status, responseTime, error, 'admin-test');
      
      console.log(`[TEST-${testId}] GET ${testPath} (OpenAI) → ${testResponse.status} ${testResponse.statusText} | ${contentType} ${responseText.length}b`);
      
      return { 
        success: testResponse.ok, 
        error: error
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      console.log(`[TEST-${testId}] GET ${testPath} (OpenAI) → ERROR: ${error.message}`);
      this.logApiRequest(testId, 'GET', testPath, 'openai', null, responseTime, error.message, 'admin-test');
      
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
      const proxyUrls = this.config.getProxyUrls ? this.config.getProxyUrls() : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        uptimeMs: Date.now() - this.startTime,
        totalRequests: this.totalApiRequests,
        providers: total,
        providersEnabled: enabled,
        proxyEnabled: this.config.isProxyEnabled ? this.config.isProxyEnabled() : false,
        proxyCount: Array.isArray(proxyUrls) ? proxyUrls.length : 0,
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

  logApiRequest(requestId, method, endpoint, provider, status = null, responseTime = null, error = null, clientIp = null, keyInfo = null, proxyUsed = null) {
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
      proxyUsed: proxyUsed || null
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
      const { proxies, autoFetch, providerProxies } = JSON.parse(body);

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

      const status = await this.proxyPool.refresh('manual', true);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, auto: status, pool: this.config.getProxyManager().getStats() }));
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
  writeEnvFile(envVars) {
    const envPath = path.join(process.cwd(), '.env');

    let envContent = '# API Key Rotator Configuration\n';
    envContent += `# Last updated: ${new Date().toISOString()}\n\n`;

    const basicConfig = {};
    const providers = {};
    const otherConfig = {};

    Object.entries(envVars).forEach(([key, value]) => {
      if (key === 'BASE_URL' && (!value || value.trim() === '')) return;

      if (key === 'PORT' || key === 'ADMIN_PASSWORD') {
        basicConfig[key] = value;
      } else if (key.endsWith('_API_KEYS') || key.endsWith('_BASE_URL') || key.endsWith('_ACCESS_KEY') || key.endsWith('_DEFAULT_MODEL') || key.endsWith('_MODEL_HISTORY') || key.endsWith('_DISABLED') || key.endsWith('_PROXY')) {
        const match = key.match(/^(.+?)_(.+?)_(API_KEYS|BASE_URL|ACCESS_KEY|DEFAULT_MODEL|MODEL_HISTORY|DISABLED|PROXY)$/);
        if (match) {
          const apiType = match[1];
          const provName = match[2];
          const keyType = match[3];
          const providerKey = `${apiType}_${provName}`;

          if (!providers[providerKey]) {
            providers[providerKey] = { apiType, providerName: provName, keys: '', baseUrl: '', accessKey: '', defaultModel: '', modelHistory: '', disabled: '', proxy: '' };
          }

          if (keyType === 'API_KEYS') providers[providerKey].keys = value;
          else if (keyType === 'BASE_URL') providers[providerKey].baseUrl = value;
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
          if (p.accessKey) envContent += `${p.apiType}_${p.providerName}_ACCESS_KEY=${p.accessKey}\n`;
          if (p.defaultModel) envContent += `${p.apiType}_${p.providerName}_DEFAULT_MODEL=${p.defaultModel}\n`;
          if (p.modelHistory) envContent += `${p.apiType}_${p.providerName}_MODEL_HISTORY=${p.modelHistory}\n`;
          // Only persist a disabled flag for a provider that actually has keys —
          // an orphaned DISABLED flag would otherwise render as a keyless ghost provider.
          if (p.disabled === 'true' && p.keys) envContent += `${p.apiType}_${p.providerName}_DISABLED=true\n`;
          if (p.proxy === 'true' && p.keys) envContent += `${p.apiType}_${p.providerName}_PROXY=true\n`;
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
    for (const [, provider] of this.config.getProviders().entries()) {
      if (provider.disabled || !provider.baseUrl) continue;
      try {
        return new URL(provider.baseUrl).hostname;
      } catch (e) { /* try the next provider */ }
    }
    return 'api.openai.com';
  }

  /**
   * Sync the proxy pool with the current settings and attach it to the live
   * ProxyManager. Called at boot and after every config reload.
   */
  applyProxySettings() {
    const manager = this.config.getProxyManager();

    // When every proxy is benched, go and fetch a fresh batch. The pool applies
    // its own minimum gap so a burst of failures can't hammer the source.
    manager.onPoolExhausted = () => {
      if (this.proxyPool.enabled) this.proxyPool.refresh('pool exhausted');
    };

    if (this.config.isProxyEnabled() && this.config.isProxyAutoFetchEnabled()) {
      this.proxyPool.start();
    } else {
      this.proxyPool.stop();
    }

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

      // Apply keep-alive setting
      const kaMinutes = envVars.KEEP_ALIVE_MINUTES ? parseInt(envVars.KEEP_ALIVE_MINUTES) : 10;
      this.telegramBot.setKeepAliveInterval(kaMinutes);

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

      const keepAliveRaw = envVars.KEEP_ALIVE_MINUTES;
      const keepAliveMinutes = keepAliveRaw != null ? parseInt(keepAliveRaw) : 10;

      const apiLogs = this.apiLogs.settings;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        botToken: envVars.TELEGRAM_BOT_TOKEN || '',
        allowedUsers: envVars.TELEGRAM_ALLOWED_USERS || '',
        defaultStatusCodes: envVars.DEFAULT_STATUS_CODES || '429',
        keepAliveMinutes,
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
      const { botToken, allowedUsers, defaultStatusCodes, keepAliveMinutes, apiLogsMode, apiLogsRetentionDays } = JSON.parse(body);
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
      if (defaultStatusCodes !== undefined) {
        // Parse, deduplicate, sort numerically
        const codes = defaultStatusCodes
          .split(',')
          .map(s => s.trim())
          .filter(s => /^\d+$/.test(s))
          .map(Number)
          .filter((v, i, a) => a.indexOf(v) === i)
          .sort((a, b) => a - b);
        if (codes.length > 0) {
          envVars.DEFAULT_STATUS_CODES = codes.join(',');
        } else {
          delete envVars.DEFAULT_STATUS_CODES;
        }
      }
      if (keepAliveMinutes !== undefined) {
        const val = parseInt(keepAliveMinutes);
        if (val > 0) {
          envVars.KEEP_ALIVE_MINUTES = String(val);
        } else {
          delete envVars.KEEP_ALIVE_MINUTES;
        }
      }

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

      // Apply keep-alive setting
      const kaMinutes = envVars.KEEP_ALIVE_MINUTES ? parseInt(envVars.KEEP_ALIVE_MINUTES) : 0;
      this.telegramBot.setKeepAliveInterval(kaMinutes);

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
        keepAliveMinutes: kaMinutes,
        apiLogsMode: this.apiLogs.settings.mode,
        apiLogsRetentionDays: this.apiLogs.settings.retentionDays || 7
      }));
    } catch (error) {
      this.sendError(res, 500, 'Failed to update telegram settings: ' + error.message);
    }
  }

  stop() {
    this.apiLogs.stop(); // Sync-flush the pending index lines before shutdown
    this.proxyPool.stop();
    if (this.telegramBot) this.telegramBot.stop();
    if (this.server) {
      this.server.close();
    }
  }
}

module.exports = ProxyServer;