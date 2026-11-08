const fs = require('fs');
const path = require('path');
const ProxyManager = require('./proxyManager');
const { maskKey } = require('./keyValues');

class Config {
  constructor() {
    this.port = null;
    this.providers = new Map(); // Map of provider_name -> { apiType, keys, baseUrl }
    this.geminiApiKeys = [];
    this.openaiApiKeys = [];
    this.baseUrl = null;
    this.proxyUrls = [];
    this.proxyEnabled = false;
    this.proxyAutoFetch = false;
    this.proxyManager = new ProxyManager([], false);
    this.apiLogs = { mode: 'memory', retentionDays: null };
    this.loadConfig();
  }

  loadConfig() {
    const envPath = path.join(process.cwd(), '.env');

    console.log(`[CONFIG] Loading configuration from ${envPath}`);

    if (!fs.existsSync(envPath)) {
      console.error('\n❌ ERROR: .env file not found!');
      console.error('Please create a .env file with the required configuration.');
      console.error('You can copy .env.example to .env and update the values.\n');
      throw new Error('.env file not found');
    }

    const envContent = fs.readFileSync(envPath, 'utf8');
    const envVars = this.parseEnvFile(envContent);

    // Resolve port: .env takes priority, then process.env, then fail
    const port = envVars.PORT || process.env.PORT;
    const adminPassword = envVars.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;

    const missingFields = [];
    if (!port) missingFields.push('PORT');
    if (!adminPassword) missingFields.push('ADMIN_PASSWORD');

    if (missingFields.length > 0) {
      console.error('\n❌ ERROR: Required fields missing!');
      console.error(`Missing fields: ${missingFields.join(', ')}`);
      console.error('\nBoth PORT and ADMIN_PASSWORD are required (via .env file or environment variables).');
      console.error('Example .env configuration:');
      console.error('  PORT=8990');
      console.error('  ADMIN_PASSWORD=your-secure-password');
      console.error('\nOr pass via environment:');
      console.error('  PORT=8990 ADMIN_PASSWORD=secret node index.js\n');
      throw new Error(`Required fields missing: ${missingFields.join(', ')}`);
    }

    // Set required fields
    this.port = parseInt(port);
    this.adminPassword = adminPassword;

    const portSource = envVars.PORT ? '.env' : 'environment';
    console.log(`[CONFIG] Port: ${this.port} (from ${portSource})`);
    console.log(`[CONFIG] Admin panel enabled with password authentication`);

    // Clear existing providers
    this.providers.clear();

    // Parse new provider format and maintain backward compatibility
    this.parseProviders(envVars);
    this.parseBackwardCompatibility(envVars);

    // Parse outbound proxy configuration
    this.parseProxyConfig(envVars);

    // Parse API request log storage (memory vs. file + retention window)
    this.parseApiLogsConfig(envVars);

    console.log(`[CONFIG] Found ${this.providers.size} providers configured`);

    // Log each provider
    for (const [providerName, config] of this.providers.entries()) {
      const maskedKeys = config.keys.map(key => this.maskApiKey(key));
      const keys = config.keyless ? 'no API key' : `${config.keys.length} keys [${maskedKeys.join(', ')}]`;
      console.log(`[CONFIG] Provider '${providerName}' (${config.apiType}): ${keys} → ${config.baseUrl}`);
    }

    if (this.providers.size === 0) {
      console.log(`[CONFIG] No providers configured yet - use the admin panel at http://localhost:${this.port}/admin to add providers`);
    }
  }

  parseEnvFile(content) {
    const envVars = {};
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine === '' || trimmedLine.startsWith('#')) {
        continue;
      }

      const equalIndex = trimmedLine.indexOf('=');
      if (equalIndex === -1) {
        continue;
      }

      const key = trimmedLine.substring(0, equalIndex).trim();
      const value = trimmedLine.substring(equalIndex + 1).trim();
      
      envVars[key] = value;
    }

    return envVars;
  }

  parseApiKeys(keysString) {
    if (!keysString) {
      return [];
    }

    return keysString
      .split(',')
      .map(key => key.trim())
      .filter(key => key.length > 0);
  }

  /**
   * Parse API keys with disabled state. Keys prefixed with ~ are disabled.
   * Returns { allKeys: [{key, disabled}], enabledKeys: [key] }
   */
  parseApiKeysWithState(keysString) {
    if (!keysString) {
      return { allKeys: [], enabledKeys: [] };
    }

    const allKeys = [];
    const enabledKeys = [];

    keysString.split(',').forEach(raw => {
      const trimmed = raw.trim();
      if (trimmed.length === 0) return;

      if (trimmed.startsWith('~')) {
        const key = trimmed.substring(1);
        if (key.length > 0) {
          allKeys.push({ key, disabled: true });
        }
      } else {
        allKeys.push({ key: trimmed, disabled: false });
        enabledKeys.push(trimmed);
      }
    });

    return { allKeys, enabledKeys };
  }

  parseProviders(envVars) {
    // Parse {API_TYPE}_{PROVIDER}_API_KEYS, {API_TYPE}_{PROVIDER}_BASE_URL, and {API_TYPE}_{PROVIDER}_ACCESS_KEY format
    const providerConfigs = new Map();

    const defaultConfig = () => ({ apiType: null, named: false, keyless: false, keys: [], allKeys: [], baseUrl: null, accessKey: null, defaultModel: null, modelsUrl: null, disabled: false, proxy: null });

    // {TYPE}_{NAME}_{SUFFIX}, or {TYPE}_{SUFFIX} for the legacy single-provider
    // form. Anchored on the suffix so a name like "proxyapi" can't be mistaken for it.
    const SUFFIX_RE = /^([^_]+)(?:_(.+?))?_(API_KEYS|BASE_URL|ACCESS_KEY|DEFAULT_MODEL|MODELS_URL|PROXY|DISABLED)$/;
    const typeOf = new Map(); // provider -> the API type it was first seen with

    for (const [key, value] of Object.entries(envVars)) {
      const m = key.match(SUFFIX_RE);
      if (!m || !value) continue;
      const apiType = m[1].toLowerCase();
      const provider = (m[2] || m[1]).toLowerCase();
      const suffix = m[3];

      // Providers are keyed by name, so OPENAI_FOO and GEMINI_FOO would merge into one
      if (typeOf.has(provider) && typeOf.get(provider) !== apiType) {
        console.log(`[CONFIG] Skipping ${key}: provider '${provider}' is already defined as ${typeOf.get(provider)}`);
        continue;
      }
      typeOf.set(provider, apiType);

      if (!providerConfigs.has(provider)) {
        providerConfigs.set(provider, defaultConfig());
      }
      const cfg = providerConfigs.get(provider);
      cfg.apiType = apiType;
      if (m[2]) cfg.named = true;

      if (suffix === 'API_KEYS') {
        // Parse keys with disabled state (~ prefix)
        const { allKeys, enabledKeys } = this.parseApiKeysWithState(value);
        cfg.keys = enabledKeys;
        cfg.allKeys = allKeys;
      } else if (suffix === 'BASE_URL') {
        cfg.baseUrl = value.trim();
      } else if (suffix === 'ACCESS_KEY') {
        cfg.accessKey = value.trim();
      } else if (suffix === 'DEFAULT_MODEL') {
        cfg.defaultModel = value.trim();
      } else if (suffix === 'MODELS_URL') {
        // Where this provider lists its models, when that isn't {base}/models
        cfg.modelsUrl = value.trim();
      } else if (suffix === 'PROXY') {
        cfg.proxy = (value.trim().toLowerCase() === 'true');
      } else if (suffix === 'DISABLED') {
        cfg.disabled = (value.trim().toLowerCase() === 'true');
      }
    }

    // Add valid providers to the main providers map
    for (const [provider, config] of providerConfigs.entries()) {
      // No keys at all but its own base URL: a keyless provider (added after its
      // /models answered without a key). One empty "key" lets it share the
      // rotation path, proxies included - requests just carry no auth.
      if (config.allKeys.length === 0 && config.named && config.baseUrl) {
        config.keyless = true;
        config.keys = [''];
      }
      if (config.allKeys.length > 0 || config.keyless) {
        // Set default base URLs if not specified
        if (!config.baseUrl) {
          if (config.apiType === 'openai') {
            config.baseUrl = 'https://api.openai.com/v1';
          } else if (config.apiType === 'gemini') {
            config.baseUrl = 'https://generativelanguage.googleapis.com/v1';
          }
        }

        this.providers.set(provider, config);
      }
    }
  }

  parseBackwardCompatibility(envVars) {
    // Maintain backward compatibility with old format
    this.geminiApiKeys = this.parseApiKeys(envVars.GEMINI_API_KEYS);
    this.openaiApiKeys = this.parseApiKeys(envVars.OPENAI_API_KEYS);
    this.baseUrl = (envVars.BASE_URL && envVars.BASE_URL.trim()) ? envVars.BASE_URL.trim() : null;

    // If old format is used, create default providers
    if (this.openaiApiKeys.length > 0) {
      const baseUrl = this.baseUrl || 'https://api.openai.com/v1';
      this.providers.set('openai', {
        apiType: 'openai',
        keys: this.openaiApiKeys,
        baseUrl: baseUrl
      });
    }

    if (this.geminiApiKeys.length > 0) {
      const baseUrl = 'https://generativelanguage.googleapis.com/v1';
      this.providers.set('gemini', {
        apiType: 'gemini',
        keys: this.geminiApiKeys,
        baseUrl: baseUrl
      });
    }
  }

  parseProxyConfig(envVars) {
    this.proxyUrls = (envVars.PROXY_URLS || '')
      .split(',')
      .map(u => u.trim())
      .filter(u => u.length > 0);

    this.proxyAutoFetch = (envVars.PROXY_AUTO_FETCH || '').trim().toLowerCase() === 'true';

    // Proxying is opted into per provider. PROXY_ENABLED is the old global
    // switch; it now only supplies a default for providers that have no
    // explicit {TYPE}_{NAME}_PROXY of their own, so existing setups keep working.
    const legacyGlobal = (envVars.PROXY_ENABLED || '').trim().toLowerCase() === 'true';
    for (const [, provider] of this.providers.entries()) {
      if (provider.proxy === null || provider.proxy === undefined) {
        provider.proxy = legacyGlobal;
      }
    }

    const proxied = this.getProxiedProviderNames();

    // The proxy subsystem runs when at least one provider asks for it and there
    // is somewhere for proxies to come from.
    this.proxyEnabled = proxied.length > 0 && (this.proxyUrls.length > 0 || this.proxyAutoFetch);

    // Green/red line and tries per request, both editable in the Proxy tab
    const int = (v, min, max) => { const n = parseInt(v, 10); return n >= min && n <= max ? n : undefined; };
    this.proxyManager = new ProxyManager(this.proxyUrls, this.proxyEnabled, {
      goodMs: int(envVars.PROXY_GOOD_MS, 100, 30000),
      maxTries: int(envVars.PROXY_MAX_TRIES, 1, 50),
    });

    if (proxied.length === 0) {
      if (this.proxyUrls.length > 0) {
        console.log(`[CONFIG] ${this.proxyUrls.length} proxy(ies) configured but no provider is set to use them`);
      }
    } else {
      const masked = this.proxyUrls.map(u => ProxyManager.maskProxyUrl(u));
      const manual = this.proxyUrls.length > 0
        ? `${this.proxyUrls.length} manual proxy(ies): [${masked.join(', ')}]`
        : 'no manual proxies';
      const auto = this.proxyAutoFetch ? ' + auto-fetched pool' : '';
      console.log(`[CONFIG] Proxy routing for [${proxied.join(', ')}] — ${manual}${auto}`);
    }
  }

  isProxyAutoFetchEnabled() {
    return this.proxyAutoFetch;
  }

  /** Providers that have opted into routing through the proxy pool. */
  getProxiedProviderNames() {
    const names = [];
    for (const [name, provider] of this.providers.entries()) {
      if (provider.proxy) names.push(name);
    }
    return names;
  }

  usesProxy(providerName) {
    const provider = this.providers.get(providerName);
    return !!(provider && provider.proxy);
  }

  /**
   * Parse API_LOGS. Request logging can never be turned off - the only choice is
   * where the entries live:
   *   API_LOGS=memory  -> RAM only, last 100 entries, cleared on restart (default)
   *   API_LOGS=<N>D    -> one file per request under logs/<date>/, holding the
   *                       full request and response, kept for N days
   * Anything unrecognized falls back to memory.
   */
  parseApiLogsConfig(envVars) {
    const raw = (envVars.API_LOGS || '').trim();
    const match = raw.match(/^(\d+)\s*d$/i);
    const days = match ? parseInt(match[1], 10) : 0;

    if (days > 0) {
      this.apiLogs = { mode: 'file', retentionDays: days };
      console.log(`[CONFIG] API logs: one file per request under logs/, keeping ${days} day(s)`);
    } else {
      this.apiLogs = { mode: 'memory', retentionDays: null };
      if (raw && raw.toLowerCase() !== 'memory') {
        console.log(`[CONFIG] API logs: unrecognized API_LOGS value "${raw}" - falling back to memory`);
      } else {
        console.log('[CONFIG] API logs: memory only (last 100 entries, cleared on restart)');
      }
    }

    return this.apiLogs;
  }

  getApiLogsConfig() {
    return { ...this.apiLogs };
  }

  getProxyManager() {
    return this.proxyManager;
  }

  getProxyUrls() {
    return [...this.proxyUrls];
  }

  isProxyEnabled() {
    return this.proxyEnabled;
  }

  getPort() {
    return this.port;
  }

  getGeminiApiKeys() {
    return [...this.geminiApiKeys];
  }

  getOpenaiApiKeys() {
    return [...this.openaiApiKeys];
  }

  getBaseUrl() {
    return this.baseUrl;
  }

  getGeminiBaseUrl() {
    return this.baseUrl || 'https://generativelanguage.googleapis.com';
  }

  getOpenaiBaseUrl() {
    return this.baseUrl || 'https://api.openai.com';
  }

  hasGeminiKeys() {
    return this.geminiApiKeys.length > 0;
  }

  hasOpenaiKeys() {
    return this.openaiApiKeys.length > 0;
  }

  getAdminPassword() {
    return this.adminPassword;
  }

  hasAdminPassword() {
    return this.adminPassword && this.adminPassword.length > 0;
  }

  maskApiKey(key) {
    return maskKey(key);
  }

  // New provider methods
  getProviders() {
    return this.providers;
  }

  getProvider(providerName) {
    return this.providers.get(providerName);
  }

  hasProvider(providerName) {
    return this.providers.has(providerName);
  }

  getProvidersByApiType(apiType) {
    const result = new Map();
    for (const [name, config] of this.providers.entries()) {
      if (config.apiType === apiType) {
        result.set(name, config);
      }
    }
    return result;
  }

  // Backward compatibility - these methods now aggregate across all providers
  getAllGeminiKeys() {
    const keys = [];
    for (const [, config] of this.providers.entries()) {
      if (config.apiType === 'gemini') {
        keys.push(...config.keys);
      }
    }
    return keys;
  }

  getAllOpenaiKeys() {
    const keys = [];
    for (const [, config] of this.providers.entries()) {
      if (config.apiType === 'openai') {
        keys.push(...config.keys);
      }
    }
    return keys;
  }
}

module.exports = Config;