# openai-gemini-api-key-rotator

Node.js proxy server for automatic API key rotation across multiple LLM providers (OpenAI, Gemini, Groq, OpenRouter, etc.). Includes a built-in Telegram bot for chatting with any model. ***Zero external dependencies***.

## Features

- **Automatic Key Rotation**: Rotates keys on configurable status codes (default: 429)
- **Outbound Proxy Rotation**: HTTP/HTTPS/SOCKS4/SOCKS5, with optional auto-fetched free proxies
- **Universal API Compatibility**: Works with any OpenAI or Gemini-compatible API
- **Streaming Support**: Full pass-through for SSE/streaming responses (`"stream": true`)
- **Smart Key Shuffling**: Avoids recently failed keys using intelligent rotation
- **Key Management**: Reorder keys, disable/enable individual keys or entire providers
- **Key Usage Tracking**: See how many times each key has been used (in-memory)
- **Live Key Validation**: API keys automatically tested before saving
- **Hot Configuration**: Add, edit, rename, or delete providers without restart
- **Custom Status Codes**: Configure which HTTP codes trigger rotation per request
- **Optional Access Control**: Secure providers with access keys requiring authorization
- **Default Models**: Pre-save models for easy curl command generation
- **Modern Admin Panel**: Dark/light theme support for comfortable management
- **Request Monitoring**: Last 100 requests logged with key usage details (which key succeeded/failed)
- **Persistent Logs**: Keep full requests and responses on disk for N days, or in memory only — switchable from the admin panel
- **Telegram Bot**: Chat with any configured model directly from Telegram (text, images, image generation)

## Quick Start

```bash
git clone https://github.com/p32929/openai-gemini-api-key-rotator.git
cd openai-gemini-api-key-rotator
cp .env.example .env
# Edit .env: Set PORT and ADMIN_PASSWORD
npm start
```

Access admin panel: `http://localhost:8990/admin`

## Configuration

```env
PORT=8990
ADMIN_PASSWORD=your-secure-password
API_LOGS=memory
```

Visit http://localhost:8990/admin to configure your providers and start using the API.

## Telegram Bot

Chat with any of your configured models directly from Telegram. Set it up from the admin panel (Settings icon) or add these to your `.env`:

```env
TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather
TELEGRAM_ALLOWED_USERS=123456789,987654321
```

Leave `TELEGRAM_ALLOWED_USERS` empty to allow anyone.

### Setup

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to create your bot
3. Copy the bot token
4. Go to the admin panel → click the **Settings** icon (next to theme toggle) → paste the token and save
5. To find your User ID, message [@userinfobot](https://t.me/userinfobot) on Telegram

### Bot Commands

| Command | Description |
|---------|-------------|
| `/models` | Select a provider and model (interactive buttons) |
| `/clear` | Clear conversation history |
| `/logs` | View recent API logs with details |
| `/status` | Show current model and history size |
| `/help` | Show available commands |

### Bot Features

- **Model Selection**: Browse providers → fetch available models → select, or type a custom model name
- **Conversation History**: Maintains up to 50 messages per user
- **Image Input**: Send photos to vision-capable models (auto-converts to base64)
- **Image Generation**: Supports image gen models — renders base64 and URL responses as Telegram photos
- **All requests go through the proxy**, so you get key rotation, access key validation, and logging automatically

## API Usage Examples

### OpenAI-Compatible APIs
```bash
curl -X POST "http://localhost:8990/groq/chat/completions" \
  -H "Authorization: Bearer [STATUS_CODES:429][ACCESS_KEY:your-access-key]" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-oss-120b",
    "messages": [
      {
        "role": "user",
        "content": "Hello! Please say hello back."
      }
    ]
  }'
```

### Gemini-Compatible APIs
```bash
curl -X POST "http://localhost:8990/gemini/models/gemini-2.5-flash:generateContent" \
  -H "x-goog-api-key: [STATUS_CODES:429][ACCESS_KEY:your-access-key]" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "parts": [
          {
            "text": "Hello! Please say hello back."
          }
        ]
      }
    ]
  }'
```

**Note**: Replace `your-access-key` with your provider's ACCESS_KEY if configured. If no ACCESS_KEY is set for the provider, you can omit the `[ACCESS_KEY:...]` parameter entirely.

## Outbound Proxy

Route upstream API requests through proxies — useful when a provider rate-limits by IP rather than by key. Managed from the admin panel's **Proxy** tab, or via `.env`:

```env
PROXY_URLS=http://user:pass@host:port,socks5://host:1080
OPENAI_GROQ_PROXY=true      # per provider: only groq routes through the proxy
```

**Proxying is opted into per provider**, so you can route only the one that's rate-limiting you and leave everything else on a direct connection. The Proxy tab lists every provider with its own toggle. (The old global `PROXY_ENABLED=true` still works as a default for providers that have no explicit setting, so existing configs keep behaving as before.)

Supported schemes: `http://`, `https://`, `socks4://` (SOCKS4a), `socks5://`, each with optional `user:pass@`. A bare `host:port` is treated as HTTP. SOCKS4 has no authentication in the protocol, so credentials are ignored there.

### Auto-fetched free proxies

```env
PROXY_AUTO_FETCH=true
```

Pulls the SOCKS4 and SOCKS5 lists from [monosans/proxy-list](https://github.com/monosans/proxy-list) (~260 entries between them), **validates every one**, and keeps only those that respond. Validation opens the proxy tunnel to one of your configured providers and completes the TLS handshake, then hangs up — no HTTP request is sent, no API key is used, and no third-party "what is my IP" service is involved.

The pool is held in memory and never written to `.env`. It refreshes every 30 minutes, and again whenever every proxy has stopped responding (rate-limited to at most one refresh every 5 minutes). Auto-fetch works on its own — you don't need any proxies of your own for `PROXY_ENABLED=true` to be valid.

Expect heavy attrition: in testing, **32 of 260 entries were alive**, and SOCKS5 fared far better than SOCKS4 (many SOCKS4 proxies don't implement the SOCKS4a hostname extension this needs). Treat proxy rotation as best-effort.

### Fastest-first selection

Proxies are ranked by measured round-trip time and traffic rotates across only the **fastest slice** (a quarter of the usable pool, at least 3 and at most 10). Validation timings seed the ranking so even the first request picks a quick proxy, and every real request updates it via a rolling average.

Rotating across a slice rather than always taking the single fastest keeps several IPs in play, which is the whole point of proxying in the first place. In a typical sweep the rotation sits around 400–800ms while the slowest live proxies measure over 6 seconds, so the tail never carries traffic.

Proxies that fail to carry a request three times in a row are **benched for 10 minutes**, then given another chance. Only connection-level failures count — an HTTP error from the provider isn't the proxy's fault. Your own `PROXY_URLS` entries are never removed automatically. If every proxy is benched, requests fall back to going **direct** rather than failing, and a pool refresh is triggered.

> Free public proxies are run by strangers. Provider traffic is HTTPS inside a CONNECT tunnel, so your API keys and request bodies stay encrypted, but the operator can see which hosts you reach and can stall or drop traffic.

## Request Logs

Every API request is logged. `API_LOGS` in `.env` only decides *where* — logging can't be turned off.

```env
API_LOGS=memory   # default: RAM only, last 100 requests, cleared on restart
API_LOGS=7D       # on disk, full request + response, kept for 7 days
```

Any day count works — `1D`, `30D`, `90D`. Anything unrecognized falls back to `memory`.

You don't have to edit `.env` by hand: the admin panel's **Settings** tab has a **Request Logs** card with the same two choices and the retention in days. Saving there writes `API_LOGS` and applies it immediately — no restart, and requests start landing on disk (or stop) right away.

### On-disk layout

In `<N>D` mode each request gets its own file, in a directory named for the day it arrived:

```
logs/
  2026-08-30/
    index.jsonl        one summary line per request
    0000001849.json    that request's full record
  2026-08-31/
    ...
```

Request IDs are sequential and zero-padded (`0000001849`), and the same ID appears in the console output, the admin panel and the filename — so a log line leads straight to its file. The counter resumes from the highest ID on disk after a restart.

Sharding by day makes retention a directory delete rather than a file rewrite, and the per-day `index.jsonl` keeps the log list cheap to render — drawing the table never opens the (much larger) detail files. Index writes are debounced 5 seconds and batched.

A summary line:

```json
{"timestamp":"2026-08-31T11:09:46.818Z","requestId":"0000001849","method":"POST","endpoint":"/chat/completions","provider":"cerebras","status":200,"responseTime":497,"error":null,"clientIp":"::ffff:127.0.0.1","keyUsed":"csk-...9ft2","failedKeys":[],"proxyUsed":null}
```

The matching `0000001849.json` holds that summary plus the full request body, request headers, and response body — which is what the panel's **View** button shows. Because the bodies survive a restart, the panel can page back through everything still inside the retention window with **Load older**; in `memory` mode it shows the last 100 and no more.

Old day directories are deleted at startup and hourly after that. `logs/` is gitignored. Credentials in stored request headers (your `ACCESS_KEY`, bearer tokens) are masked before anything is written; provider API keys are already masked everywhere they appear.

## Changelog

### Version 6.x.x
- **Telegram Bot** — chat with any model from Telegram with interactive model selection, conversation history, image input/output support
- **File Logging** — all API requests logged to `logs.jsonl` with debounced writes
- **Settings Panel** — gear icon in admin panel for configuring Telegram bot
- Admin panel improvements: password input autofocus, logs sorted newest-first, disabled providers shown at bottom

### Version 5.x.x
- Streaming support — SSE responses piped through without buffering
- Disable/enable individual API keys (persisted via `~` prefix in `.env`)
- Disable/enable entire providers (`_DISABLED=true` in `.env`)
- Reorder API keys to control rotation priority
- Per-key usage tracking displayed in admin panel
- Logs now show which key was used and which keys failed per request

### Version 4.x.x
- Dynamic status code configuration via headers
- Optional ACCESS_KEY for provider-level security
- Enhanced admin panel with improved UX
- Auto-generated curl commands reflect the new API format

**Breaking Changes**:
- API endpoints changed from `/provider/v1/*` to `/provider/*`
- Version suffix (`/v1`) now derived from provider's base URL configuration
- **Migration**: Simply copy the curl command from admin panel to see the new format in action

### Version 3.x.x
- Enhanced admin panel with better UI/UX
- No breaking changes

### Version 2.x.x
- Added admin panel for dynamic provider management
- No breaking changes

### Version 1.x.x
- Basic API key rotation
- OpenAI and Gemini-compatible API support

### Screenshots

<img width="3600" height="2110" alt="Image" src="https://github.com/user-attachments/assets/e2dba567-31b7-4b1a-9b60-6bd4532aeb1f" />

<img width="3600" height="2110" alt="Image" src="https://github.com/user-attachments/assets/0dcfeac0-f1fa-40ab-8afa-5f1a83cc2b74" />

<img width="3600" height="2110" alt="Image" src="https://github.com/user-attachments/assets/d550796a-5b51-427f-a81c-d0e7a881782c" />

<img width="3600" height="2110" alt="Image" src="https://github.com/user-attachments/assets/e4da21f4-0e33-4089-9982-e61cfeffdb5d" />

<img width="3600" height="2110" alt="Image" src="https://github.com/user-attachments/assets/d459f988-eae2-4495-bcb0-98aa6587419e" />

<img width="3600" height="2110" alt="Image" src="https://github.com/user-attachments/assets/5faa6bee-0eee-4b1f-8772-c1828184b1d1" />

## Contributing

Contributions are warmly welcomed and greatly appreciated! Whether it's a bug fix, new feature, or improvement, your input helps make this project better for everyone.

**Before submitting a pull request**, please:
1. Create an issue describing the feature or bug fix you'd like to work on
2. Wait for discussion and approval to ensure alignment with project goals
3. Fork the repository and create your feature branch
4. Submit your pull request with a clear description of changes

This approach helps avoid duplicate efforts and ensures smooth collaboration. Thank you for considering contributing!

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
