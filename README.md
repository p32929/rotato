# rotato

rotato is a small proxy you run yourself that rotates your API keys for OpenAI, Gemini, Groq, OpenRouter and any OpenAI or Gemini compatible API. Free and cheap keys hit their rate limit fast. Give rotato several keys, and when one is limited it quietly tries the next, so your app keeps working.

**No third-party packages, so there is no supply chain to attack.** Most tools like this pull in hundreds of npm packages, and any one of them could be hijacked to steal the API keys you give it. rotato uses only Node.js itself: there is nothing to `npm install`, no `node_modules`, and every line that touches your keys is in this repo where you can read it. The admin panel's code and Tailwind styles are served from this repo too (only its font comes from Google Fonts).

<img width="3024" height="1714" alt="rotato admin panel" src="https://github.com/user-attachments/assets/f265cc8f-941e-43e4-998e-c713dacfd248" />

## Features

1. **Switches keys for you** when a provider answers with a rate limit (429 by default) or any other codes you choose.
2. **Works with any OpenAI or Gemini compatible API,** each provider on its own path, like `/groq` or `/gemini`.
3. **Streaming works,** so chat replies still arrive word by word.
4. **Avoids keys that just failed,** and lets you reorder keys or turn off a key or a whole provider.
5. **Checks a key before saving it,** and counts how often each key is used.
6. **Change providers without a restart:** add, edit, rename or delete them from the admin panel.
7. **Optional access key,** so only your own apps can use your proxy.
8. **Request logs** that show which key worked and which failed, kept in memory or on disk for as many days as you like.
9. **Optional outbound proxies** (HTTP, HTTPS, SOCKS4, SOCKS5), including free public ones that rotato finds and checks itself.
10. **Telegram bot** to chat with any of your models from your phone, with images too.
11. **Light and dark admin panel.**

## Screenshots

<img width="3600" height="2110" alt="Image" src="https://github.com/user-attachments/assets/e2dba567-31b7-4b1a-9b60-6bd4532aeb1f" />

<img width="3600" height="2110" alt="Image" src="https://github.com/user-attachments/assets/0dcfeac0-f1fa-40ab-8afa-5f1a83cc2b74" />

<img width="3600" height="2110" alt="Image" src="https://github.com/user-attachments/assets/d550796a-5b51-427f-a81c-d0e7a881782c" />

<img width="3600" height="2110" alt="Image" src="https://github.com/user-attachments/assets/e4da21f4-0e33-4089-9982-e61cfeffdb5d" />

<img width="3600" height="2110" alt="Image" src="https://github.com/user-attachments/assets/d459f988-eae2-4495-bcb0-98aa6587419e" />

<img width="3600" height="2110" alt="Image" src="https://github.com/user-attachments/assets/5faa6bee-0eee-4b1f-8772-c1828184b1d1" />

## Quick Start

```bash
git clone https://github.com/p32929/rotato.git
cd rotato
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

1. **Model Selection**: Browse providers → fetch available models → select, or type a custom model name
2. **Conversation History**: Maintains up to 50 messages per user
3. **Image Input**: Send photos to vision-capable models (auto-converts to base64)
4. **Image Generation**: Supports image gen models — renders base64 and URL responses as Telegram photos
5. **All requests go through the proxy**, so you get key rotation, access key validation, and logging automatically

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

**Which status codes rotate**: `[STATUS_CODES:...]` says which upstream responses make rotato move on to the next key. Combine any of these with commas:

| Form | Means |
|---|---|
| `429` | that code |
| `420-429` | every code from 420 to 429 |
| `>=400`, `>400`, `<=404`, `<300` | every code above / below |

For example `[STATUS_CODES:403, 420-429, >=500]`. The admin panel's default (Settings → Key rotation) takes the same syntax, refuses anything it can't read, and tells you which codes it covers.

## Per-Key Values

Some providers need more than a key, and it differs per key: Cloudflare Workers AI puts the account ID in the URL, so each token only works with its own account. Put a `{name}` placeholder in the base URL and give each key its value after a `|`:

```env
OPENAI_CLOUDFLARE_BASE_URL=https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1
OPENAI_CLOUDFLARE_API_KEYS=token1|accountId=abc123,token2|accountId=def456
```

Every request fills the placeholders from whichever key is being tried, so rotation works across accounts. Any name works (`{accountId}`, `{region}`, ...), and a key can carry several: `token|accountId=abc|region=eu`. A key missing a value the URL needs is skipped with an error naming it. Keys without `|` are used exactly as before.

In the admin panel you never type the `|` format: once the base URL has a `{placeholder}`, every key row gets a field for it, existing keys show their values as tags (a missing one shows red; click it to fill it in), and **Edit** changes a key's values.

## Providers Without a Key

Some APIs work without a key. Leave the keys empty in the **Add provider** dialog (with a name and base URL): rotato calls the provider's models list (its custom models URL, if set) with no auth, and only adds it if that answers 2xx with JSON. In `.env` such a provider is just its base URL:

```env
OPENAI_POLLINATIONS_BASE_URL=https://text.pollinations.ai/openai
```

Requests go out with no key of their own (a caller's own `Authorization` header still goes through), everything else works as usual — proxies, retries, access key, logs — and the logs show **no API key** in the key column. Adding a key later turns it into a normal provider; deleting its last key still removes the whole provider.

## Custom Models URL

Some providers list their models somewhere other than `{base URL}/models` (Cloudflare Workers AI's OpenAI-compatible API has no `/models` at all). Set a models list URL for that provider (in the **Add provider** dialog, later under the provider's **Connection** settings, or in `.env`), and every `GET /{provider}/models` (the models browser, the Telegram bot, your own apps) is fetched from there instead:

```env
OPENAI_CLOUDFLARE_MODELS_URL=https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/models/search?per_page=1000
```

It can be a path joined to the base URL (`/v2/models`) or a full `https://` URL, and `{placeholders}` are filled from the key in use, just like in the base URL. Leave it empty to keep using `{base URL}/models`. Saving it in the panel immediately tries the list and tells you how many models it found. If it uses a `{placeholder}` the base URL doesn't, each key gets a field for that value too.

The models browser and the Telegram bot read the list wherever the reply puts it (`data`, `models`, `result`, ...), and take the model name from `model`, `id` or `name`, skipping internal UUID ids.

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

Pulls the SOCKS5, SOCKS4 and HTTP lists from [monosans/proxy-list](https://github.com/monosans/proxy-list) and [proxifly/free-proxy-list](https://github.com/proxifly/free-proxy-list) (~10k entries after removing duplicates), **validates every one**, and keeps only those that respond — typically several hundred. A full sweep takes a few minutes; when the pool starts empty, proxies are handed over as they are found, so the first requests don't wait for the whole sweep. Validation opens the proxy tunnel to one of your configured providers and completes the TLS handshake, then hangs up — no HTTP request is sent, no API key is used, and no third-party "what is my IP" service is involved.

The pool is held in memory and never written to `.env`. The list is re-fetched every 30 minutes, and sooner when fewer than 5 green proxies are left (at most one fetch every 5 minutes). Auto-fetch works on its own — you don't need any proxies of your own.

Expect heavy attrition: typically a quarter to a third of the entries answer, and SOCKS5 fares far better than SOCKS4 (many SOCKS4 proxies don't implement the SOCKS4a hostname extension this needs). Some providers (Groq, for one) block most free-proxy IPs outright. Treat proxy rotation as best-effort.

### Green, red, and how a proxy is picked

Every proxy has a live speed: how long it takes to open the tunnel and finish the TLS handshake with the provider — the part the proxy controls, not the provider's own response time. Only checks (fetch, background, rescue) set it — real requests don't, so a proxy that was briefly slow during a burst doesn't turn red. Below the line (`PROXY_GOOD_MS`, default 1000ms) it is **green** and used; at or above it, **red** and only shown. The Proxy tab colours the list accordingly and keeps it live while open.

Each request gets a **random green proxy**. Proxies come out of a shuffled list, so concurrent requests never share one and none is reused until every other green proxy has had a turn. The shuffle spreads proxies on the same IP evenly through the cycle — free lists often carry dozens of ports on one machine, and picking those back to back would overload it. If a proxy fails, the **same key moves on to the next proxy**, never one this request already tried, up to `PROXY_MAX_TRIES` (default 5), and the failed proxy waits at the back of the shuffle. When a key is rotated (429 and so on — that's the key's fault, not the proxy's), the next key gets a proxy this request hasn't used yet.

**A provider with the proxy on always goes through a proxy.** When a request has used every green proxy it reuses the one it used longest ago (the same one, if it's the only green one); with no green at all, it takes the fastest red one; with everything benched, the one whose bench ends soonest. Right after a start, while the list is still loading, requests wait for it (up to 30s) instead of going direct. A request only goes direct when the list is empty. The same host:port listed as both socks4 and socks5 counts as one proxy.

```env
PROXY_GOOD_MS=1000     # green below this many ms
PROXY_MAX_TRIES=5      # proxies one request may try before the next key
```

Both are editable in the Proxy tab.

### Background checks

Every couple of minutes rotato re-checks the list, least recently checked first:

1. **Every proxy** gets a handshake check, under traffic too: tunnel + TLS handshake to a proxied provider's host, then hang up. No request, no API key. Its timing becomes the proxy's speed, so proxies move between green and red, and a benched proxy that passes is back in play at once. Real requests never use red proxies, so without this a proxy that turned red would stay red.
2. **When green runs low** (fewer than 5) even during traffic, red and benched proxies get an immediate handshake check — at most once a minute, until 10 are green again — so proxies that were only slow under load come back instead of requests going direct.
3. **Green proxies**, while no proxied request has gone out for 30 seconds, also list a provider's models through the proxy, each at most once every 10 minutes, one call every few seconds, taking turns across proxied providers and their keys. Listing models is free, and unlike a handshake it catches a provider blocking the proxy's IP (a 403/407 counts against it).

### Timeouts and recovery

Every request is bounded. A proxy that accepts the tunnel and then goes silent used to hang the caller indefinitely; now:

1. **Connect (tunnel + TLS)** is capped per proxy, scaled to its measured speed — a proxy that benchmarked at 400ms gets 4s, never the full 8s ceiling.
2. **Response** is capped at 60s through a proxy, 120s direct. For streaming, only the wait for headers is bounded; the stream itself may run as long as it likes.
3. **On a proxy failure the same API key is retried through the next proxy** (up to `PROXY_MAX_TRIES`) rather than burning the key or failing the request. With a single key configured, one dead proxy no longer fails the call.

A stall benches the proxy immediately rather than after three strikes, since silence is conclusive. An HTTP **403 or 407 through a proxy** counts as a strike too, and the request moves on to the next proxy — a blocked proxy IP answers quickly. If every proxy tried gets one, the provider's answer is passed on.

Proxies that fail three times in a row are **benched for 10 minutes**, or until a background check finds them working. Only connection-level failures (and 403/407) count — other HTTP errors from the provider aren't the proxy's fault. Your own `PROXY_URLS` entries are never removed automatically.

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

### Version 7.x.x
1. **Status code ranges and comparisons** — `[STATUS_CODES:...]` and the default in Settings take codes, ranges and comparisons, mixed with commas: `403, 420-429, >=500`. Settings refuses anything it can't read instead of silently dropping it, and tells you which codes it covers
2. **Per-key values** — a key can carry values for `{placeholders}` in its provider's URLs (`token|accountId=abc`), so providers like Cloudflare Workers AI rotate across accounts
3. **Custom models URL** — any provider can list its models from somewhere other than `{base URL}/models`; the models browser and Telegram bot read lists in any common shape
4. **Redesigned admin panel** — collapsible providers with expand/collapse all, an Add provider dialog, drag-to-reorder keys, and a full phone layout
5. **Test all** — one button checks every key of every provider without spending tokens; each key gets a status dot and each provider a summary
6. Request logs show the model each request asked for (searchable and sortable)
7. Keys are validated even for providers without a `/models` endpoint
8. **Proxy picking** — proxies are green (under 1000ms by default) or red; each request takes a random green one no other request is using, moves on to the next on failure (5 tries by default), and background checks keep the list and its colours current. Both numbers are set in the Proxy tab
9. **Providers without a key** — leave the keys empty when adding a provider; it's added only if its models list answers without one, and it works with proxies like any other
10. **More free proxies** — the auto-fetched pool also pulls proxifly/free-proxy-list and HTTP proxies (~10k candidates, several hundred usually alive, up from a few dozen), and an empty pool starts using proxies while the first sweep is still running
11. **Proxy on means proxied** — a rotated key gets a different proxy; with few or no green proxies a request reuses one or takes a red one rather than going direct; right after a start it waits for the list to load
12. Key tests can go through the proxy or direct for providers that use it, and the Proxy tab can select all/none
13. Removed the keep-alive ping setting: it pinged the server from inside itself, so it couldn't keep a free host awake

**Breaking Changes**:
1. The old `400+` (above 400) and `400=+` (400 and above) status code forms are gone. Use `>400` and `>=400` instead
2. **Migration**: search your apps for `[STATUS_CODES:` and replace any `NNN+` with `>NNN` and `NNN=+` with `>=NNN`. In a header, an old form is now ignored; if nothing else in it is valid, rotato rotates on 429 only

### Version 6.x.x
1. **Telegram Bot** — chat with any model from Telegram with interactive model selection, conversation history, image input/output support
2. **File Logging** — all API requests logged to `logs.jsonl` with debounced writes
3. **Settings Panel** — gear icon in admin panel for configuring Telegram bot
4. Admin panel improvements: password input autofocus, logs sorted newest-first, disabled providers shown at bottom

### Version 5.x.x
1. Streaming support — SSE responses piped through without buffering
2. Disable/enable individual API keys (persisted via `~` prefix in `.env`)
3. Disable/enable entire providers (`_DISABLED=true` in `.env`)
4. Reorder API keys to control rotation priority
5. Per-key usage tracking displayed in admin panel
6. Logs now show which key was used and which keys failed per request

### Version 4.x.x
1. Dynamic status code configuration via headers
2. Optional ACCESS_KEY for provider-level security
3. Enhanced admin panel with improved UX
4. Auto-generated curl commands reflect the new API format

**Breaking Changes**:
1. API endpoints changed from `/provider/v1/*` to `/provider/*`
2. Version suffix (`/v1`) now derived from provider's base URL configuration
3. **Migration**: Simply copy the curl command from admin panel to see the new format in action

### Version 3.x.x
1. Enhanced admin panel with better UI/UX
2. No breaking changes

### Version 2.x.x
1. Added admin panel for dynamic provider management
2. No breaking changes

### Version 1.x.x
1. Basic API key rotation
2. OpenAI and Gemini-compatible API support

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are very welcome, thank you! Before you start on a pull request, please open an issue and tell me what you would like to add or change. That way we can agree on it first, and your time is not wasted on something that might not fit. Thanks for helping make rotato better.

## You might also like

<p><a href="https://openstore.pfay.workers.dev/more/p32929/rotato/0"><picture><source media="(prefers-color-scheme: dark)" srcset="https://openstore.pfay.workers.dev/more/p32929/rotato/0-dark.svg"><img src="https://openstore.pfay.workers.dev/more/p32929/rotato/0-light.svg" width="50%" align="top" alt="More apps by p32929 on OpenStore (1)"></picture></a><a href="https://openstore.pfay.workers.dev/more/p32929/rotato/1"><picture><source media="(prefers-color-scheme: dark)" srcset="https://openstore.pfay.workers.dev/more/p32929/rotato/1-dark.svg"><img src="https://openstore.pfay.workers.dev/more/p32929/rotato/1-light.svg" width="50%" align="top" alt="More apps by p32929 on OpenStore (2)"></picture></a><br><a href="https://openstore.pfay.workers.dev/more/p32929/rotato/2"><picture><source media="(prefers-color-scheme: dark)" srcset="https://openstore.pfay.workers.dev/more/p32929/rotato/2-dark.svg"><img src="https://openstore.pfay.workers.dev/more/p32929/rotato/2-light.svg" width="50%" align="top" alt="More apps by p32929 on OpenStore (3)"></picture></a><a href="https://openstore.pfay.workers.dev/more/p32929/rotato/3"><picture><source media="(prefers-color-scheme: dark)" srcset="https://openstore.pfay.workers.dev/more/p32929/rotato/3-dark.svg"><img src="https://openstore.pfay.workers.dev/more/p32929/rotato/3-light.svg" width="50%" align="top" alt="More apps by p32929 on OpenStore (4)"></picture></a></p>

<p><a href="https://p32929.github.io/share/?repo=rotato"><picture><source media="(prefers-color-scheme: dark)" srcset="https://p32929.github.io/readme/footer-share-dark.svg"><img src="https://p32929.github.io/readme/footer-share-light.svg" width="50%" align="top" alt="Share this project with your friends in one click"></picture></a><a href="https://p32929.github.io/support/"><picture><source media="(prefers-color-scheme: dark)" srcset="https://p32929.github.io/readme/footer-support-dark.svg"><img src="https://p32929.github.io/readme/footer-support-light.svg" width="50%" align="top" alt="If you like my work and want to support me, feel free to support"></picture></a><br><a href="https://openstore.pfay.workers.dev/add"><picture><source media="(prefers-color-scheme: dark)" srcset="https://p32929.github.io/readme/footer-join-dark.svg"><img src="https://p32929.github.io/readme/footer-join-light.svg" width="100%" align="top" alt="Put your own apps on OpenStore: free, your listing lives in your own repo"></picture></a></p>
