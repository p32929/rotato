# openai-gemini-api-key-rotator

Node.js proxy server for automatic API key rotation across multiple LLM providers (OpenAI, Gemini, Groq, OpenRouter, etc.). Includes a built-in Telegram bot for chatting with any model. ***Zero external dependencies***.

## Features

- **Automatic Key Rotation**: Rotates keys on configurable status codes (default: 429)
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
- **File Logging**: All API requests logged to `logs.jsonl` with debounced writes for performance
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

### Calling Gemini's OpenAI-Compatible Endpoint

Gemini also exposes an OpenAI-compatible surface at `/v1beta/openai/chat/completions`, which authenticates with an `Authorization: Bearer` header instead of the `key` query param / `x-goog-api-key` header used by native Gemini endpoints (e.g. `:generateContent`). A `gemini`-type provider automatically detects this and switches to `Authorization: Bearer` whenever the request path contains `/openai/` or `/chat/completions`, so you can hit it either through a native provider:

```bash
curl -X POST "http://localhost:8990/gemini/openai/chat/completions" \
  -H "x-goog-api-key: [STATUS_CODES:429]" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      { "role": "user", "content": "Hello! Please say hello back." 
      }
    ]
  }'
```

or by pointing `GEMINI_<PROVIDER>_BASE_URL` at `https://generativelanguage.googleapis.com/v1beta/openai` and calling `/chat/completions` directly.

## File Logging

## File Logging

All API requests are automatically logged to `logs.jsonl` in the project root. Writes are debounced (5 seconds) for performance — multiple requests within the window are batched into a single disk write. Each line is a JSON object:

```json
{"timestamp":"2026-04-01T15:33:15.221Z","requestId":"h8j4pqqot","method":"POST","endpoint":"/chat/completions","provider":"cerebras","status":200,"responseTime":497,"error":null,"clientIp":"::ffff:127.0.0.1","keyUsed":"csk-...9ft2","failedKeys":[]}
```

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

### Screenshot

<img width="3024" height="1714" alt="Image" src="https://github.com/user-attachments/assets/f265cc8f-941e-43e4-998e-c713dacfd248" />

<img width="3600" height="6418" alt="Image" src="https://github.com/user-attachments/assets/fc8f464b-bd06-4bfd-be9a-10844e25f3ed" />

<img width="3600" height="2110" alt="Image" src="https://github.com/user-attachments/assets/39833f4f-c4eb-4c77-9a3a-91aeab7ef92c" />

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
