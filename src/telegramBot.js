const https = require('https');
const http = require('http');
const { Readable } = require('stream');

class TelegramBot {
  constructor(server) {
    this.server = server;
    this.token = null;
    this.allowedUsers = new Set();
    this.polling = false;
    this.lastUpdateId = 0;
    this.pollTimeout = null;
    this.consecutiveErrors = 0;
    this.maxBackoff = 30000; // Max 30s between retries
    this.keepAliveTimer = null;
    this.keepAliveInterval = 10 * 60 * 1000; // 10 minutes

    // Per-user state
    this.userModels = new Map();       // chatId -> { provider, model, apiType }
    this.userHistory = new Map();      // chatId -> [{ role, content }]
    this.awaitingCustomModel = new Map(); // chatId -> { provider, apiType }
    this.awaitingModelSearch = new Map(); // chatId -> { provider, apiType, messageId }
    this.maxHistory = 50;
  }

  async start(token, allowedUsers) {
    if (this.polling) await this.stop();

    this.token = token;
    this.allowedUsers = new Set(allowedUsers.map(String));

    if (!this.token) {
      console.log('[TELEGRAM] No bot token configured');
      return;
    }

    // Flush any lingering getUpdates session from a previous instance
    try {
      await this.apiCall('getUpdates', { offset: -1, timeout: 0 });
    } catch {
      // Ignore — just clearing the old session
    }

    this.polling = true;
    this.lastUpdateId = 0;
    this.consecutiveErrors = 0;
    console.log(`[TELEGRAM] Bot starting with ${this.allowedUsers.size} allowed user(s)`);
    this.registerCommands();
    this.poll();
    this.startKeepAlive();
  }

  async registerCommands() {
    try {
      await this.apiCall('setMyCommands', {
        commands: [
          { command: 'models', description: 'Select a provider and model' },
          { command: 'clear', description: 'Clear conversation history' },
          { command: 'logs', description: 'View recent API logs' },
          { command: 'status', description: 'Show current model info' },
          { command: 'help', description: 'Show available commands' }
        ]
      });
      console.log('[TELEGRAM] Bot commands registered');
    } catch (err) {
      console.log(`[TELEGRAM] Failed to register commands: ${err.message}`);
    }
  }

  async stop() {
    this.polling = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    // Abort in-flight getUpdates request
    if (this._activePollingReq) {
      this._activePollingReq.destroy();
      this._activePollingReq = null;
    }
    // Flush the old polling session so the next start doesn't conflict
    if (this.token) {
      try {
        await this.apiCall('getUpdates', { offset: -1, timeout: 0 });
      } catch {
        // Ignore — just clearing
      }
    }
    console.log('[TELEGRAM] Bot stopped');
  }

  setKeepAliveInterval(minutes) {
    this.keepAliveInterval = minutes > 0 ? minutes * 60 * 1000 : 0;
    // Restart keep-alive if bot is currently polling
    if (this.polling) {
      this.startKeepAlive();
    }
  }

  startKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.keepAliveInterval <= 0) {
      console.log('[TELEGRAM] Keep-alive disabled');
      return;
    }
    const minutes = Math.round(this.keepAliveInterval / 60000);
    console.log(`[TELEGRAM] Keep-alive enabled (every ${minutes} min)`);
    this.keepAliveTimer = setInterval(() => {
      if (!this.polling) return;
      const port = this.server.config.getPort();
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume(); // drain response
      });
      req.on('error', () => {}); // ignore errors
      req.setTimeout(5000, () => req.destroy());
      console.log('[TELEGRAM] Keep-alive ping sent');
    }, this.keepAliveInterval);
    // Don't let the timer prevent process exit
    if (this.keepAliveTimer.unref) this.keepAliveTimer.unref();
  }

  async poll() {
    if (!this.polling) return;

    try {
      const updates = await this.apiCall('getUpdates', {
        offset: this.lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ['message', 'callback_query']
      });

      // Success — reset error counter
      this.consecutiveErrors = 0;

      if (updates && updates.length > 0) {
        for (const update of updates) {
          this.lastUpdateId = update.update_id;
          try {
            await this.handleUpdate(update);
          } catch (err) {
            console.log(`[TELEGRAM] Error handling update: ${err.message}`);
          }
        }
      }
    } catch (err) {
      this.consecutiveErrors++;
      const backoff = Math.min(1000 * Math.pow(2, this.consecutiveErrors - 1), this.maxBackoff);

      if (this.polling) {
        this.pollTimeout = setTimeout(() => this.poll(), backoff);
      }
      return;
    }

    if (this.polling) {
      this.pollTimeout = setTimeout(() => this.poll(), 500);
    }
  }

  isAllowed(chatId) {
    return this.allowedUsers.size === 0 || this.allowedUsers.has(String(chatId));
  }

  async handleUpdate(update) {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    const msg = update.message;
    if (!msg) return;

    const chatId = msg.chat.id;

    if (!this.isAllowed(chatId)) {
      await this.sendMessage(chatId, `You are not authorized to use this bot.\n\nYour Chat ID: \`${chatId}\`\nAsk the admin to add your ID to the allowed users list.`, { parse_mode: 'Markdown' });
      return;
    }

    // Handle photo messages
    if (msg.photo && msg.photo.length > 0) {
      await this.handlePhoto(chatId, msg);
      return;
    }

    // Handle document images (when sent as file)
    if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image/')) {
      await this.handleDocumentImage(chatId, msg);
      return;
    }

    if (!msg.text) return;

    const text = msg.text.trim();

    // Check if user is searching for a model
    if (this.awaitingModelSearch.has(chatId) && !text.startsWith('/')) {
      const { provider: providerName, apiType, messageId } = this.awaitingModelSearch.get(chatId);
      this.awaitingModelSearch.delete(chatId);

      const cached = this._modelCache.get(`${chatId}:${providerName}`);
      if (cached) {
        const query = text.toLowerCase();
        const matched = cached.models.filter(m => m.toLowerCase().includes(query));

        if (matched.length === 0) {
          await this.sendMessage(chatId, `No models matching "*${text}*" in *${providerName}*.`, { parse_mode: 'Markdown' });
        } else {
          // Store filtered results in cache for selection
          const searchCacheKey = `${chatId}:${providerName}:search`;
          this._modelCache.set(searchCacheKey, { models: matched, apiType });

          const buttons = [];
          for (let i = 0; i < matched.length && i < 50; i++) {
            buttons.push([{ text: matched[i], callback_data: `ms:${providerName}:${i}` }]);
          }
          buttons.push([
            { text: '\ud83d\udd0d Search again', callback_data: `search:${providerName}` },
            { text: '\u2190 All models', callback_data: `provider:${providerName}` }
          ]);

          await this.sendMessage(chatId, `Found *${matched.length}* model(s) matching "*${text}*":`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
          });
        }
      } else {
        await this.sendMessage(chatId, 'Model list not cached. Use /models to fetch first.');
      }
      return;
    }

    // Check if user is typing a custom model name
    if (this.awaitingCustomModel.has(chatId) && !text.startsWith('/')) {
      const { provider: providerName, apiType } = this.awaitingCustomModel.get(chatId);
      this.awaitingCustomModel.delete(chatId);

      this.userModels.set(chatId, { provider: providerName, model: text, apiType });
      this.userHistory.delete(chatId);

      await this.sendMessage(chatId, `Model set to: *${text}*\nProvider: *${providerName}*\n\nYou can now start chatting!`, { parse_mode: 'Markdown' });
      return;
    }

    // Any command cancels the awaiting state
    if (text.startsWith('/')) {
      this.awaitingCustomModel.delete(chatId);
      this.awaitingModelSearch.delete(chatId);
    }

    if (text === '/start' || text === '/help') {
      await this.handleHelp(chatId);
    } else if (text === '/models') {
      await this.handleModels(chatId);
    } else if (text === '/logs') {
      await this.handleLogs(chatId);
    } else if (text === '/clear') {
      this.userHistory.delete(chatId);
      await this.sendMessage(chatId, 'Conversation cleared.');
    } else if (text === '/status') {
      await this.handleStatus(chatId);
    } else if (text.startsWith('/')) {
      await this.sendMessage(chatId, 'Unknown command. Use /help to see available commands.');
    } else {
      await this.handleChat(chatId, text);
    }
  }

  async handleHelp(chatId) {
    const selection = this.userModels.get(chatId);
    const current = selection
      ? `*Current model:* \`${selection.model}\` (${selection.provider})`
      : '*No model selected yet*';

    const helpText = [
      '*API Key Rotator Bot*',
      '',
      current,
      '',
      '*Commands:*',
      '/models - Select a provider and model',
      '/clear - Clear conversation history',
      '/logs - View recent API logs',
      '/status - Show current model & history size',
      '/help - Show this message',
      '',
      'Just send a message to chat with the selected model.'
    ].join('\n');

    await this.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
  }

  async handleStatus(chatId) {
    const selection = this.userModels.get(chatId);
    const history = this.userHistory.get(chatId) || [];
    const lines = [];

    if (selection) {
      lines.push(`*Provider:* \`${selection.provider}\``);
      lines.push(`*Model:* \`${selection.model}\``);
      lines.push(`*API Type:* ${selection.apiType}`);
    } else {
      lines.push('*No model selected.* Use /models to pick one.');
    }
    lines.push(`*History:* ${history.length} messages`);
    await this.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  }

  // ─── /models ───

  async handleModels(chatId) {
    const providers = this.server.config.getProviders();
    if (providers.size === 0) {
      await this.sendMessage(chatId, 'No providers configured. Add providers via the admin panel.');
      return;
    }

    const buttons = [];
    for (const [name, cfg] of providers.entries()) {
      if (cfg.disabled) continue;
      if (cfg.keys.length === 0) continue;
      buttons.push([{ text: `${name} (${cfg.apiType})`, callback_data: `provider:${name}` }]);
    }

    if (buttons.length === 0) {
      await this.sendMessage(chatId, 'No active providers available.');
      return;
    }

    await this.sendMessage(chatId, 'Select a provider:', {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  async handleProviderSelected(chatId, providerName, messageId) {
    const provider = this.server.config.getProvider(providerName);
    if (!provider) {
      await this.answerCallback(chatId, 'Provider not found');
      return;
    }

    await this.editMessage(chatId, messageId, `Fetching models from *${providerName}*...`, { parse_mode: 'Markdown' });

    try {
      const models = await this.fetchModels(providerName, provider);

      if (models.length === 0) {
        await this.editMessage(chatId, messageId, `No models found for *${providerName}*.`, { parse_mode: 'Markdown' });
        return;
      }

      // Paginate: show first 50, with pages if more
      const pageSize = 50;
      const page = 0;
      await this.showModelPage(chatId, messageId, providerName, provider.apiType, models, page, pageSize);
    } catch (err) {
      await this.editMessage(chatId, messageId, `Failed to fetch models: ${err.message}`);
    }
  }

  async showModelPage(chatId, messageId, providerName, apiType, models, page, pageSize) {
    const start = page * pageSize;
    const pageModels = models.slice(start, start + pageSize);

    // Use index-based callback_data to avoid Telegram's 64-byte limit
    const cacheKey = `${chatId}:${providerName}`;

    // One model per row
    const buttons = [];
    for (let i = 0; i < pageModels.length; i++) {
      buttons.push([{ text: pageModels[i], callback_data: `m:${providerName}:${start + i}` }]);
    }

    // Pagination nav
    const totalPages = Math.ceil(models.length / pageSize);
    if (totalPages > 1) {
      const nav = [];
      if (page > 0) nav.push({ text: '\u2190 Prev', callback_data: `pg:${providerName}:${page - 1}` });
      nav.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
      if (page < totalPages - 1) nav.push({ text: 'Next \u2192', callback_data: `pg:${providerName}:${page + 1}` });
      buttons.push(nav);
    }

    // Search, Custom model + Back buttons
    buttons.push([
      { text: '\ud83d\udd0d Search models', callback_data: `search:${providerName}` }
    ]);
    buttons.push([
      { text: '\u270f\ufe0f Type custom model', callback_data: `custom:${providerName}` },
      { text: '\u2190 Back', callback_data: 'back_providers' }
    ]);

    await this.editMessage(chatId, messageId, `Select a model from *${providerName}* (${models.length} available):`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
  }

  async fetchModels(providerName, provider) {
    const headers = this.buildAuthHeader(provider);
    const res = await this.internalRequest('GET', `/${providerName}/models`, headers);
    const parsed = JSON.parse(res.data);

    if (res.statusCode >= 400) {
      throw new Error(parsed.error?.message || `HTTP ${res.statusCode}`);
    }

    if (provider.apiType === 'gemini') {
      return (parsed.models || []).map(m => m.name.replace('models/', '')).sort();
    } else {
      return (parsed.data || []).map(m => m.id).sort();
    }
  }

  /**
   * Make a request directly through the server's HTTP handler — no network needed.
   * Goes through the full proxy pipeline (routing, key rotation, logging, access keys).
   */
  internalRequest(method, urlPath, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
      // Build a minimal IncomingMessage-like readable stream
      const req = new Readable({ read() {} });
      req.method = method;
      req.url = urlPath;
      req.headers = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
      );
      req.connection = { remoteAddress: '127.0.0.1' };

      if (body) req.push(body);
      req.push(null);

      // Build a minimal ServerResponse-like object that collects the output
      let statusCode = 200;
      const resHeaders = {};
      const chunks = [];
      let finished = false;

      const res = {
        setHeader(key, val) { resHeaders[key.toLowerCase()] = val; },
        writeHead(code, hdrs) {
          statusCode = code;
          if (hdrs) {
            for (const [k, v] of Object.entries(hdrs)) {
              resHeaders[k.toLowerCase()] = v;
            }
          }
        },
        write(chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return true;
        },
        end(data) {
          if (finished) return;
          finished = true;
          if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
          resolve({
            statusCode,
            headers: resHeaders,
            data: Buffer.concat(chunks).toString('utf8')
          });
        },
        get headersSent() { return false; },
        on() { return res; }
      };

      try {
        this.server.handleRequest(req, res);
      } catch (err) {
        reject(err);
      }
    });
  }

  buildAuthHeader(provider) {
    const headers = {};

    // Read default status codes from env
    const statusCodes = this.getDefaultStatusCodes();
    let authContent = `[STATUS_CODES:${statusCodes}]`;

    if (provider.accessKey) {
      authContent += `[ACCESS_KEY:${provider.accessKey}]`;
    }

    if (provider.apiType === 'gemini') {
      headers['x-goog-api-key'] = authContent;
    } else {
      headers['authorization'] = `Bearer ${authContent}`;
    }

    return headers;
  }

  getDefaultStatusCodes() {
    try {
      const fs = require('fs');
      const path = require('path');
      const envPath = path.join(process.cwd(), '.env');
      if (!fs.existsSync(envPath)) return '429';
      const envContent = fs.readFileSync(envPath, 'utf8');
      const envVars = this.server.config.parseEnvFile(envContent);
      return envVars.DEFAULT_STATUS_CODES || '429';
    } catch {
      return '429';
    }
  }

  // Store models cache for pagination
  _modelCache = new Map();

  async handleCallback(query) {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    if (!this.isAllowed(chatId)) {
      await this.answerCallbackQuery(query.id, 'Not authorized');
      return;
    }

    await this.answerCallbackQuery(query.id);

    if (data.startsWith('provider:')) {
      const providerName = data.substring(9);
      const provider = this.server.config.getProvider(providerName);
      if (provider) {
        try {
          await this.editMessage(chatId, messageId, `Fetching models from *${providerName}*...`, { parse_mode: 'Markdown' });
          const models = await this.fetchModels(providerName, provider);
          this._modelCache.set(`${chatId}:${providerName}`, { models, apiType: provider.apiType });
          await this.showModelPage(chatId, messageId, providerName, provider.apiType, models, 0, 50);
        } catch (err) {
          await this.editMessage(chatId, messageId, `Failed to fetch models: ${err.message}`);
        }
      }
    } else if (data.startsWith('m:')) {
      // m:providerName:index
      const parts = data.split(':');
      const providerName = parts[1];
      const modelIndex = parseInt(parts[2]);

      const cached = this._modelCache.get(`${chatId}:${providerName}`);
      if (cached && modelIndex < cached.models.length) {
        const model = cached.models[modelIndex];
        const apiType = cached.apiType;

        this.userModels.set(chatId, { provider: providerName, model, apiType });
        this.userHistory.delete(chatId);

        await this.editMessage(chatId, messageId, `Model selected: *${model}*\nProvider: *${providerName}*\n\nYou can now start chatting!`, { parse_mode: 'Markdown' });
      }
    } else if (data.startsWith('pg:')) {
      // pg:providerName:page
      const parts = data.split(':');
      const providerName = parts[1];
      const page = parseInt(parts[2]);

      const cached = this._modelCache.get(`${chatId}:${providerName}`);
      if (cached) {
        await this.showModelPage(chatId, messageId, providerName, cached.apiType, cached.models, page, 50);
      }
    } else if (data.startsWith('custom:')) {
      const providerName = data.substring(7);
      const provider = this.server.config.getProvider(providerName);
      if (provider) {
        this.awaitingCustomModel.set(chatId, { provider: providerName, apiType: provider.apiType });
        await this.editMessage(chatId, messageId, `Type the model name for *${providerName}*:`, { parse_mode: 'Markdown' });
      }
    } else if (data.startsWith('search:')) {
      const providerName = data.substring(7);
      const provider = this.server.config.getProvider(providerName);
      if (provider) {
        this.awaitingModelSearch.set(chatId, { provider: providerName, apiType: provider.apiType, messageId });
        await this.editMessage(chatId, messageId, `Type part of the model name to search in *${providerName}*:`, { parse_mode: 'Markdown' });
      }
    } else if (data.startsWith('ms:')) {
      // ms:providerName:index — model selected from search results
      const parts = data.split(':');
      const providerName = parts[1];
      const modelIndex = parseInt(parts[2]);

      const searchCacheKey = `${chatId}:${providerName}:search`;
      const cached = this._modelCache.get(searchCacheKey);
      if (cached && modelIndex < cached.models.length) {
        const model = cached.models[modelIndex];
        const apiType = cached.apiType;

        this.userModels.set(chatId, { provider: providerName, model, apiType });
        this.userHistory.delete(chatId);

        await this.editMessage(chatId, messageId, `Model selected: *${model}*\nProvider: *${providerName}*\n\nYou can now start chatting!`, { parse_mode: 'Markdown' });
      }
    } else if (data === 'back_providers') {
      // Show providers again
      const providers = this.server.config.getProviders();
      const buttons = [];
      for (const [name, cfg] of providers.entries()) {
        if (cfg.disabled) continue;
        if (cfg.keys.length === 0) continue;
        buttons.push([{ text: `${name} (${cfg.apiType})`, callback_data: `provider:${name}` }]);
      }
      await this.editMessage(chatId, messageId, 'Select a provider:', {
        reply_markup: { inline_keyboard: buttons }
      });
    } else if (data.startsWith('logdetail:')) {
      const requestId = data.substring(10);
      await this.showLogDetail(chatId, messageId, requestId);
    } else if (data === 'back_logs') {
      await this.showLogsMessage(chatId, messageId);
    }
  }

  // ─── Photo handling ───

  async handlePhoto(chatId, msg) {
    // Telegram sends multiple sizes, pick the largest
    const photo = msg.photo[msg.photo.length - 1];
    const caption = msg.caption || 'What is in this image?';

    await this.handleImageMessage(chatId, photo.file_id, caption);
  }

  async handleDocumentImage(chatId, msg) {
    const caption = msg.caption || 'What is in this image?';
    await this.handleImageMessage(chatId, msg.document.file_id, caption);
  }

  async handleImageMessage(chatId, fileId, text) {
    const selection = this.userModels.get(chatId);
    if (!selection) {
      await this.sendMessage(chatId, 'No model selected. Use /models to select a provider and model first.');
      return;
    }

    // Send temporary "Generating..." message
    const thinkingMsg = await this.sendMessage(chatId, '\u2728 _Generating..._', { parse_mode: 'Markdown' });

    try {
      // Get file path from Telegram
      const fileInfo = await this.apiCall('getFile', { file_id: fileId });
      const fileUrl = `https://api.telegram.org/file/bot${this.token}/${fileInfo.file_path}`;

      // Download image as base64
      const imageBuffer = await this.httpGetBuffer(fileUrl);
      const base64Image = imageBuffer.toString('base64');

      // Determine mime type from file path
      const ext = fileInfo.file_path.split('.').pop().toLowerCase();
      const mimeTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
      const mimeType = mimeTypes[ext] || 'image/jpeg';

      // Build multimodal history entry
      if (!this.userHistory.has(chatId)) {
        this.userHistory.set(chatId, []);
      }
      const history = this.userHistory.get(chatId);

      // Add as multimodal content
      history.push({
        role: 'user',
        content: text,
        image: { base64: base64Image, mimeType }
      });

      while (history.length > this.maxHistory) {
        history.shift();
      }

      const result = await this.chatWithModel(selection, history);
      const statusTag = `\`[${result.statusCode}]\``;

      if (result.multimodal) {
        if (thinkingMsg) this.deleteMessage(chatId, thinkingMsg.message_id).catch(() => {});
        const textParts = [];
        for (const part of result.parts) {
          if (part.type === 'image') {
            await this.sendPhoto(chatId, part.url, statusTag);
          } else if (part.type === 'text') {
            textParts.push(part.text);
          }
        }
        const textReply = textParts.join('\n');
        if (textReply) {
          const withStatus = `${textReply}\n\n${statusTag}`;
          await this.sendMessage(chatId, withStatus, { parse_mode: 'Markdown' }).catch(async () => {
            await this.sendMessage(chatId, withStatus);
          });
        }
        history.push({ role: 'assistant', content: textReply || '[image]' });
        while (history.length > this.maxHistory) history.shift();
        return;
      }

      const reply = result.text;
      const replyWithStatus = `${reply}\n\n${statusTag}`;

      history.push({ role: 'assistant', content: reply });
      while (history.length > this.maxHistory) {
        history.shift();
      }

      // Replace thinking message with actual reply
      if (thinkingMsg && replyWithStatus.length <= 4096) {
        try {
          await this.editMessage(chatId, thinkingMsg.message_id, replyWithStatus, { parse_mode: 'Markdown' });
        } catch {
          try {
            await this.editMessage(chatId, thinkingMsg.message_id, replyWithStatus);
          } catch {
            await this.sendMessage(chatId, replyWithStatus);
          }
        }
      } else {
        if (thinkingMsg) this.deleteMessage(chatId, thinkingMsg.message_id).catch(() => {});
        const chunks = this.splitMessage(replyWithStatus, 4096);
        for (const chunk of chunks) {
          await this.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }).catch(async () => {
            await this.sendMessage(chatId, chunk);
          });
        }
      }
    } catch (err) {
      if (thinkingMsg) {
        await this.editMessage(chatId, thinkingMsg.message_id, `Error: ${err.message}`).catch(() => {});
      } else {
        await this.sendMessage(chatId, `Error: ${err.message}`);
      }
    }
  }

  // ─── Chat ───

  async handleChat(chatId, text) {
    const selection = this.userModels.get(chatId);
    if (!selection) {
      await this.sendMessage(chatId, 'No model selected. Use /models to select a provider and model first.');
      return;
    }

    // Build conversation history
    if (!this.userHistory.has(chatId)) {
      this.userHistory.set(chatId, []);
    }
    const history = this.userHistory.get(chatId);
    history.push({ role: 'user', content: text });

    // Trim history
    while (history.length > this.maxHistory) {
      history.shift();
    }

    // Send temporary "Generating..." message
    const thinkingMsg = await this.sendMessage(chatId, '\u2728 _Generating..._', { parse_mode: 'Markdown' });

    try {
      const result = await this.chatWithModel(selection, history);
      const statusTag = `\`[${result.statusCode}]\``;

      // Handle multimodal response (images)
      if (result.multimodal) {
        if (thinkingMsg) this.deleteMessage(chatId, thinkingMsg.message_id).catch(() => {});

        const textParts = [];
        for (const part of result.parts) {
          if (part.type === 'image') {
            await this.sendPhoto(chatId, part.url, statusTag);
          } else if (part.type === 'text') {
            textParts.push(part.text);
          }
        }
        const textReply = textParts.join('\n');
        if (textReply) {
          const withStatus = `${textReply}\n\n${statusTag}`;
          await this.sendMessage(chatId, withStatus, { parse_mode: 'Markdown' }).catch(async () => {
            await this.sendMessage(chatId, withStatus);
          });
        }

        history.push({ role: 'assistant', content: textReply || '[image]' });
        while (history.length > this.maxHistory) history.shift();
        return;
      }

      const reply = result.text;
      const replyWithStatus = `${reply}\n\n${statusTag}`;

      history.push({ role: 'assistant', content: reply });
      while (history.length > this.maxHistory) {
        history.shift();
      }

      // Replace thinking message with actual reply
      if (thinkingMsg && replyWithStatus.length <= 4096) {
        try {
          await this.editMessage(chatId, thinkingMsg.message_id, replyWithStatus, { parse_mode: 'Markdown' });
        } catch {
          // Markdown parse failure — try plain text edit, fallback to new message
          try {
            await this.editMessage(chatId, thinkingMsg.message_id, replyWithStatus);
          } catch {
            await this.sendMessage(chatId, replyWithStatus);
          }
        }
      } else {
        // Delete thinking message and send chunks
        if (thinkingMsg) this.deleteMessage(chatId, thinkingMsg.message_id).catch(() => {});
        const chunks = this.splitMessage(replyWithStatus, 4096);
        for (const chunk of chunks) {
          await this.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }).catch(async () => {
            await this.sendMessage(chatId, chunk);
          });
        }
      }
    } catch (err) {
      // Remove the user message from history on failure
      history.pop();
      if (thinkingMsg) {
        await this.editMessage(chatId, thinkingMsg.message_id, `Error: ${err.message}`).catch(() => {});
      } else {
        await this.sendMessage(chatId, `Error: ${err.message}`);
      }
    }
  }

  async chatWithModel(selection, history) {
    const { provider: providerName, model, apiType } = selection;
    const provider = this.server.config.getProvider(providerName);
    if (!provider) throw new Error(`Provider '${providerName}' not found`);

    const headers = { 'content-type': 'application/json', ...this.buildAuthHeader(provider) };

    let reqPath, body;

    if (apiType === 'gemini') {
      reqPath = `/${providerName}/models/${model}:generateContent`;
      body = JSON.stringify({
        contents: history.map(m => {
          const parts = [];
          if (m.image) {
            parts.push({ inline_data: { mime_type: m.image.mimeType, data: m.image.base64 } });
          }
          parts.push({ text: m.content });
          return { role: m.role === 'assistant' ? 'model' : 'user', parts };
        })
      });
    } else {
      reqPath = `/${providerName}/chat/completions`;
      body = JSON.stringify({
        model: model,
        messages: history.map(m => {
          if (m.image) {
            return {
              role: m.role,
              content: [
                { type: 'image_url', image_url: { url: `data:${m.image.mimeType};base64,${m.image.base64}` } },
                { type: 'text', text: m.content }
              ]
            };
          }
          return { role: m.role, content: m.content };
        })
      });
    }

    const res = await this.internalRequest('POST', reqPath, headers, body);
    const statusCode = res.statusCode;
    const data = JSON.parse(res.data);

    if (data.error) {
      const errMsg = data.error.message || data.error.status || JSON.stringify(data.error);
      throw new Error(`(${statusCode}) ${errMsg}`);
    }

    if (apiType === 'gemini') {
      const parts = data.candidates?.[0]?.content?.parts;
      if (!parts || parts.length === 0) throw new Error(`(${statusCode}) Empty response from Gemini`);
      return { text: parts.map(p => p.text).join(''), statusCode };
    } else {
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error(`(${statusCode}) Empty response from model`);

      const content = message.content;
      const parts = [];

      // Check message.images[] (OpenRouter image gen format)
      if (message.images && Array.isArray(message.images)) {
        for (const img of message.images) {
          if (img.image_url?.url) {
            parts.push({ type: 'image', url: img.image_url.url });
          }
        }
      }

      // Check content array (OpenAI multimodal format)
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === 'text' && item.text) {
            parts.push({ type: 'text', text: item.text });
          } else if (item.type === 'image_url' && item.image_url?.url) {
            parts.push({ type: 'image', url: item.image_url.url });
          }
        }
      }

      if (parts.length > 0) return { multimodal: true, parts, statusCode };

      if (typeof content === 'string' && content) {
        // Check for image URLs in markdown format ![alt](url)
        const imgMarkdown = content.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
        if (imgMarkdown) {
          return { multimodal: true, parts: [{ type: 'image', url: imgMarkdown[1] }], statusCode };
        }
        return { text: content, statusCode };
      }

      throw new Error(`(${statusCode}) Empty response from model`);
    }
  }

  // ─── /logs ───

  async handleLogs(chatId) {
    const msg = await this.sendMessage(chatId, 'Loading logs...');
    if (msg) {
      await this.showLogsMessage(chatId, msg.message_id);
    }
  }

  async showLogsMessage(chatId, messageId) {
    const logs = this.server.logBuffer.slice(-20).reverse();

    if (logs.length === 0) {
      await this.editMessage(chatId, messageId, 'No logs available.');
      return;
    }

    const lines = logs.map((log, i) => {
      if (typeof log === 'string') return log;
      const time = new Date(log.timestamp).toLocaleTimeString();
      const status = log.status || '???';
      const statusEmoji = log.status >= 400 ? '\u274c' : '\u2705';
      return `${statusEmoji} \`${time}\` ${log.method} \`${log.endpoint}\` (${log.provider}) → ${status}`;
    });

    const buttons = [];
    // Show "View Details" buttons for logs with requestId, max 10
    const detailLogs = logs.filter(l => typeof l === 'object' && l.requestId && l.requestId !== 'unknown').slice(0, 10);
    for (const log of detailLogs) {
      const time = new Date(log.timestamp).toLocaleTimeString();
      const label = `${log.method} ${log.endpoint} (${log.status || '?'}) - ${time}`;
      buttons.push([{ text: label, callback_data: `logdetail:${log.requestId}` }]);
    }

    await this.editMessage(chatId, messageId, `*Recent Logs* (${logs.length}):\n\n${lines.join('\n')}`, {
      parse_mode: 'Markdown',
      reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined
    });
  }

  async showLogDetail(chatId, messageId, requestId) {
    const responseData = this.server.responseStorage.get(requestId);
    const logEntry = this.server.logBuffer.find(l => typeof l === 'object' && l.requestId === requestId);

    const lines = [`*Log Detail:* \`${requestId}\``];

    if (logEntry) {
      lines.push(`*Time:* ${new Date(logEntry.timestamp).toLocaleString()}`);
      lines.push(`*Method:* ${logEntry.method}`);
      lines.push(`*Endpoint:* \`${logEntry.endpoint}\``);
      lines.push(`*Provider:* ${logEntry.provider}`);
      lines.push(`*Status:* ${logEntry.status || 'N/A'}`);
      lines.push(`*Response Time:* ${logEntry.responseTime ? logEntry.responseTime + 'ms' : 'N/A'}`);
      if (logEntry.keyUsed) lines.push(`*Key Used:* \`${logEntry.keyUsed}\``);
      if (logEntry.error) lines.push(`*Error:* ${logEntry.error}`);
      if (logEntry.failedKeys && logEntry.failedKeys.length > 0) {
        const failed = logEntry.failedKeys.map(fk => `\`${fk.key}\` (${fk.status || 'err'})`).join(', ');
        lines.push(`*Failed Keys:* ${failed}`);
      }
    }

    if (responseData) {
      lines.push('');
      lines.push(`*Response Status:* ${responseData.status} ${responseData.statusText || ''}`);
      lines.push(`*Content Type:* ${responseData.contentType || 'N/A'}`);

      if (responseData.requestBody) {
        let reqPreview = typeof responseData.requestBody === 'string' ? responseData.requestBody : JSON.stringify(responseData.requestBody);
        if (reqPreview.length > 500) reqPreview = reqPreview.substring(0, 500) + '...';
        lines.push(`\n*Request Body:*\n\`\`\`\n${reqPreview}\n\`\`\``);
      }

      if (responseData.responseData) {
        let resPreview = responseData.responseData;
        if (resPreview.length > 500) resPreview = resPreview.substring(0, 500) + '...';
        lines.push(`\n*Response:*\n\`\`\`\n${resPreview}\n\`\`\``);
      }
    } else if (!logEntry) {
      lines.push('Log details not found (may have been cleared from memory).');
    }

    const buttons = [[{ text: '\u2190 Back to logs', callback_data: 'back_logs' }]];

    let text = lines.join('\n');
    // Truncate if too long for Telegram
    if (text.length > 4000) text = text.substring(0, 4000) + '\n...truncated';

    await this.editMessage(chatId, messageId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
  }

  // ─── Telegram API helpers ───

  splitMessage(text, maxLen) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Try to split at newline
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt < maxLen / 2) splitAt = maxLen;
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt);
    }
    return chunks;
  }

  async sendMessage(chatId, text, opts = {}) {
    const payload = {
      chat_id: chatId,
      text: text,
      ...opts
    };
    try {
      const result = await this.apiCall('sendMessage', payload);
      return result;
    } catch (err) {
      console.log(`[TELEGRAM] sendMessage error: ${err.message}`);
      return null;
    }
  }

  async editMessage(chatId, messageId, text, opts = {}) {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      ...opts
    };
    try {
      await this.apiCall('editMessageText', payload);
    } catch (err) {
      console.log(`[TELEGRAM] editMessage error: ${err.message}`);
    }
  }

  async answerCallbackQuery(queryId, text) {
    const payload = { callback_query_id: queryId };
    if (text) payload.text = text;
    try {
      await this.apiCall('answerCallbackQuery', payload);
    } catch {}
  }

  async sendPhoto(chatId, photoUrl, caption) {
    try {
      // Handle base64 data URIs — must upload as multipart
      const dataUriMatch = photoUrl.match(/^data:image\/(\w+);base64,(.+)$/);
      if (dataUriMatch) {
        const ext = dataUriMatch[1] === 'jpeg' ? 'jpg' : dataUriMatch[1];
        const buffer = Buffer.from(dataUriMatch[2], 'base64');
        await this.sendPhotoBuffer(chatId, buffer, `image.${ext}`, caption);
      } else {
        const payload = { chat_id: chatId, photo: photoUrl };
        if (caption) payload.caption = caption;
        await this.apiCall('sendPhoto', payload);
      }
    } catch (err) {
      // Fallback: if it's a URL, send as link; if base64, just report success/failure
      if (!photoUrl.startsWith('data:')) {
        await this.sendMessage(chatId, photoUrl);
      } else {
        console.log(`[TELEGRAM] Failed to send photo: ${err.message}`);
        await this.sendMessage(chatId, 'Generated an image but failed to send it.');
      }
    }
  }

  sendPhotoBuffer(chatId, buffer, filename, caption) {
    return new Promise((resolve, reject) => {
      const boundary = '----TGBotBoundary' + Math.random().toString(36).substring(2);

      let body = '';
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;

      if (caption) {
        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
      }

      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="photo"; filename="${filename}"\r\n`;
      body += `Content-Type: image/${filename.split('.').pop()}\r\n\r\n`;

      const ending = `\r\n--${boundary}--\r\n`;

      const bodyBuffer = Buffer.concat([
        Buffer.from(body, 'utf8'),
        buffer,
        Buffer.from(ending, 'utf8')
      ]);

      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${this.token}/sendPhoto`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': bodyBuffer.length
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) resolve(parsed.result);
            else reject(new Error(parsed.description || 'sendPhoto failed'));
          } catch (e) {
            reject(new Error('Invalid response'));
          }
        });
      });

      req.setTimeout(60000, () => {
        req.destroy();
        reject(new Error('Upload timeout'));
      });

      req.on('error', reject);
      req.write(bodyBuffer);
      req.end();
    });
  }

  async deleteMessage(chatId, messageId) {
    try {
      await this.apiCall('deleteMessage', { chat_id: chatId, message_id: messageId });
    } catch {}
  }

  async sendChatAction(chatId, action) {
    await this.apiCall('sendChatAction', { chat_id: chatId, action });
  }

  apiCall(method, payload = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${this.token}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      // Use longer timeout for getUpdates (long polling uses 30s, give extra buffer)
      const timeoutMs = method === 'getUpdates' ? 60000 : 30000;
      const isLongPoll = method === 'getUpdates' && payload.timeout > 0;

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (isLongPoll) this._activePollingReq = null;
          try {
            const parsed = JSON.parse(body);
            if (parsed.ok) {
              resolve(parsed.result);
            } else {
              reject(new Error(parsed.description || 'Telegram API error'));
            }
          } catch (e) {
            reject(new Error('Invalid response from Telegram'));
          }
        });
      });

      req.setTimeout(timeoutMs, () => {
        if (isLongPoll) this._activePollingReq = null;
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.on('error', (err) => {
        if (isLongPoll) this._activePollingReq = null;
        reject(err);
      });

      // Track the long-polling request so stop() can abort it
      if (isLongPoll) this._activePollingReq = req;

      req.write(data);
      req.end();
    });
  }

  httpGetBuffer(url, headers = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers
      };

      const req = mod.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
          } else {
            resolve(buffer);
          }
        });
      });

      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Image download timeout'));
      });

      req.on('error', reject);
      req.end();
    });
  }

  httpPost(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;

      const bodyData = typeof body === 'string' ? body : JSON.stringify(body);
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(bodyData)
        }
      };

      const req = mod.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 400) {
            // Still resolve with body so caller can parse the error
            resolve(data);
          } else {
            resolve(data);
          }
        });
      });

      req.setTimeout(120000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.on('error', reject);
      req.write(bodyData);
      req.end();
    });
  }

  httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers
      };

      const req = mod.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      });

      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.on('error', reject);
      req.end();
    });
  }
}

module.exports = TelegramBot;
