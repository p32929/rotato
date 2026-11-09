const assert = require('assert');
const { parseKey, resolveKey, maskKey } = require('../src/keyValues');
const OpenAIClient = require('../src/openaiClient');
const GeminiClient = require('../src/geminiClient');

const CF = 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1';

// Old-style keys are untouched, including ones with "=", "+", "/" (base64-ish)
for (const key of ['sk-abc123', 'gsk_x', 'AbC+/dEf==', 'weird|notapair']) {
  assert.deepStrictEqual(parseKey(key), { token: key, values: {} });
  assert.deepStrictEqual(resolveKey(key, 'https://api.groq.com/openai/v1'), { token: key, baseUrl: 'https://api.groq.com/openai/v1' });
}
assert.deepStrictEqual(resolveKey('sk-abc', null), { token: 'sk-abc', baseUrl: null });

// Values fill placeholders; values may contain "="
assert.deepStrictEqual(resolveKey('cfut_tok|accountId=111', CF),
  { token: 'cfut_tok', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/111/ai/v1' });
assert.deepStrictEqual(parseKey('tok==|a=1|b=x=y').values, { a: '1', b: 'x=y' });
assert.strictEqual(resolveKey('t|a=1|b=2', 'https://x/{a}/{b}/{a}').baseUrl, 'https://x/1/2/1');
assert.strictEqual(resolveKey('t|a=a/b', 'https://x/{a}').baseUrl, 'https://x/a%2Fb');

// Missing value is an error naming it
assert.throws(() => resolveKey('cfut_tok', CF), /accountId/);

// Masking hides the token, shows only the start of values
assert.strictEqual(maskKey('sk-abcdefgh1234'), 'sk-a...1234');
assert.strictEqual(maskKey('cfut_abcdefgh|accountId=1234567890'), 'cfut...efgh (accountId=1234…)');

// Clients build the per-key URL and send only the token
const openai = new OpenAIClient(null, CF);
let opts = openai._buildRequestOptions('POST', '/chat/completions', '{}', {}, 'cfut_tok|accountId=111');
assert.strictEqual(opts.hostname, 'api.cloudflare.com');
assert.strictEqual(opts.path, '/client/v4/accounts/111/ai/v1/chat/completions');
assert.strictEqual(opts.headers.Authorization, 'Bearer cfut_tok');
opts = new OpenAIClient(null, 'https://api.groq.com/openai/v1')._buildRequestOptions('GET', '/models', null, {}, 'gsk_plain');
assert.strictEqual(opts.path, '/openai/v1/models');
assert.strictEqual(opts.headers.Authorization, 'Bearer gsk_plain');

const gemini = new GeminiClient(null, 'https://example.com/{project}/v1beta');
opts = gemini._buildRequestOptions('GET', '/models', null, {}, 'AIzaKEY|project=p1', true);
assert.strictEqual(opts.path, '/p1/v1beta/models');
assert.strictEqual(opts.headers['x-goog-api-key'], 'AIzaKEY');
opts = new GeminiClient(null, 'https://generativelanguage.googleapis.com/v1beta')._buildRequestOptions('GET', '/models', null, {}, 'AIzaPLAIN', false);
assert.strictEqual(opts.path, '/v1beta/models?key=AIzaPLAIN');

// Custom models URL: GET /models goes there instead; everything else is untouched
const ProxyServer = require('../src/server');
const up = ProxyServer.prototype.upstreamPath;
const absModels = { modelsUrl: 'https://api.example.com/accounts/{accountId}/ai/models/search?per_page=1000' };
assert.strictEqual(up('GET', '/models', absModels), absModels.modelsUrl);
assert.strictEqual(up('GET', '/models/', absModels), absModels.modelsUrl);
assert.strictEqual(up('GET', '/models?x=1', absModels), absModels.modelsUrl);            // its own query wins
assert.strictEqual(up('GET', '/models?x=1', { modelsUrl: '/v2/models' }), '/v2/models?x=1'); // else keep the caller's
assert.strictEqual(up('POST', '/models', absModels), '/models');
assert.strictEqual(up('GET', '/chat/completions', absModels), '/chat/completions');
assert.strictEqual(up('GET', '/models/gpt-4o', absModels), '/models/gpt-4o');
assert.strictEqual(up('GET', '/models', {}), '/models');
assert.strictEqual(up('GET', '/models', undefined), '/models');

// Clients: a full URL replaces the base URL, with the key's values filled in
opts = new OpenAIClient(null, CF)._buildRequestOptions('GET', absModels.modelsUrl, null, {}, 'cfut_tok|accountId=111');
assert.strictEqual(opts.hostname, 'api.example.com');
assert.strictEqual(opts.path, '/accounts/111/ai/models/search?per_page=1000');
assert.strictEqual(opts.headers.Authorization, 'Bearer cfut_tok');
opts = new OpenAIClient(null, CF)._buildRequestOptions('GET', '/../models/search', null, {}, 'cfut_tok|accountId=111');
assert.strictEqual(opts.path, '/client/v4/accounts/111/ai/models/search');                 // relative paths may climb out of the base
opts = new GeminiClient(null, 'https://example.com/v1beta')._buildRequestOptions('GET', 'https://other.example.com/{project}/list', null, {}, 'AIzaKEY|project=p9', true);
assert.strictEqual(opts.hostname, 'other.example.com');
assert.strictEqual(opts.path, '/p9/list');
assert.throws(() => new OpenAIClient(null, CF)._buildRequestOptions('GET', absModels.modelsUrl, null, {}, 'cfut_tok'), /accountId/);

// Telegram /models reads any list shape, like the panel
const TelegramBot = require('../src/telegramBot');
const ids = TelegramBot.modelIdsFrom;
assert.deepStrictEqual(ids({ object: 'list', data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }), ['gpt-a', 'gpt-b']);           // OpenAI
assert.deepStrictEqual(ids({ models: [{ name: 'models/gemini-2.5-flash' }] }), ['gemini-2.5-flash']);                   // Gemini
assert.deepStrictEqual(ids({ success: true, result: [{ id: 'c329a1f9-323d-4e91-b2aa-582dd4188d34', name: '@cf/meta/llama' }] }), ['@cf/meta/llama']); // list under result, UUID id skipped
assert.deepStrictEqual(ids([{ model: 'm1' }, { model: 'm1' }]), ['m1']);                                                 // bare array, de-duplicated
assert.deepStrictEqual(ids({ page: 1, things: [{ name: 'x' }] }), ['x']);                                                // first array of objects
assert.deepStrictEqual(ids({ error: 'nope' }), []);

// Status codes that rotate: codes, ranges, comparisons, mixed
const { parseStatusCodes, describeStatusCodes } = require('../src/statusCodes');
const sc = (spec) => [...parseStatusCodes(spec).codes].sort((a, b) => a - b);
assert.deepStrictEqual(sc('429'), [429]);
assert.deepStrictEqual(sc('420-429, 403'), [403, 420, 421, 422, 423, 424, 425, 426, 427, 428, 429]);
assert.deepStrictEqual(sc('400 - 402'), [400, 401, 402]);                  // spaces are fine
assert.strictEqual(sc('>=400').length, 200);                               // 400..599
assert.deepStrictEqual(sc('>=598'), [598, 599]);
assert.deepStrictEqual(sc('>598'), [599]);
assert.deepStrictEqual(sc('<=101'), [100, 101]);
assert.deepStrictEqual(sc('<102'), [100, 101]);
assert.deepStrictEqual(parseStatusCodes('400+, 400=+').invalid, ['400+', '400=+']);   // old spellings are gone
assert.deepStrictEqual(sc('429, 420-430, >=429'), sc('>=420'));            // overlaps merge
assert.deepStrictEqual(parseStatusCodes('429, abc, 450-440, 700, >=999, 42').invalid, ['abc', '450-440', '700', '>=999', '42']);
assert.deepStrictEqual(parseStatusCodes(' 403 , 420 - 429 ,>= 500, 403').parts, ['403', '420-429', '>=500']); // tidied, de-duplicated
assert.strictEqual(describeStatusCodes(parseStatusCodes('403, 420-429, >=500').codes), '403, 420–429, 500–599');
// the header uses the same rules
const hdr = ProxyServer.prototype.parseStatusCodesFromAuth;
assert.deepStrictEqual([...hdr('Bearer [STATUS_CODES:420-429, 403][ACCESS_KEY:x]')].sort((a, b) => a - b), sc('420-429, 403'));
assert.strictEqual(hdr('Bearer [STATUS_CODES:>=400]').size, 200);
assert.strictEqual(hdr('Bearer sk-abc'), null);
assert.strictEqual(hdr('Bearer [STATUS_CODES:nope]'), null);

// The model shown in the request log
const { requestModel } = require('../src/server');
assert.strictEqual(requestModel('{"model":"gpt-4o-mini","messages":[]}', '/groq/chat/completions'), 'gpt-4o-mini');   // OpenAI body
assert.strictEqual(requestModel('{"contents":[]}', '/gemini/models/gemini-2.5-flash:generateContent'), 'gemini-2.5-flash'); // Gemini path
assert.strictEqual(requestModel(null, '/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse'), 'gemini-2.5-pro');
assert.strictEqual(requestModel(null, '/groq/models'), null);                  // listing models: no model
assert.strictEqual(requestModel('not json', '/groq/chat/completions'), null);

// Provider vars: suffix is anchored, names with underscores and "proxy" in them parse right,
// and one name can't be claimed by two API types
const Config = require('../src/config');
const cfg = Object.create(Config.prototype);
cfg.providers = new Map();
cfg.parseProviders({ OPENAI_PROXYAPI_API_KEYS: 'k', OPENAI_PROXYAPI_PROXY: 'true', OPENAI_FOO_BAR_API_KEYS: 'x',
  OPENAI_DUP_API_KEYS: 'a', GEMINI_DUP_API_KEYS: 'b', GEMINI_API_KEYS: 'g' });
assert.strictEqual(cfg.providers.get('proxyapi').proxy, true);
assert.ok(cfg.providers.has('foo_bar'));
assert.strictEqual(cfg.providers.get('dup').apiType, 'openai');
assert.strictEqual(cfg.providers.get('gemini').apiType, 'gemini');

// Proxy timers: 30 min fetch / 2 min re-test by default; out-of-range values fall back
{
  const pc = Object.create(Config.prototype);
  pc.providers = new Map();
  pc.parseProxyConfig({});
  assert.deepStrictEqual([pc.proxyFetchMinutes, pc.proxyCheckMinutes], [30, 2]);
  pc.parseProxyConfig({ PROXY_FETCH_MINUTES: '45', PROXY_CHECK_MINUTES: '5' });
  assert.deepStrictEqual([pc.proxyFetchMinutes, pc.proxyCheckMinutes], [45, 5]);
  pc.parseProxyConfig({ PROXY_FETCH_MINUTES: '1', PROXY_CHECK_MINUTES: '999' });
  assert.deepStrictEqual([pc.proxyFetchMinutes, pc.proxyCheckMinutes], [30, 2]);

  // A new interval takes effect on the running timers
  const pool = new (require('../src/proxyPool'))();
  pool.timer = setInterval(() => {}, 1e9);
  const before = pool.timer;
  pool.setRefreshInterval(45 * 60 * 1000);
  assert.ok(pool.timer !== before && pool.refreshIntervalMs === 45 * 60 * 1000);
  clearInterval(pool.timer);
  const ck = new (require('../src/proxyChecker'))({ getManager: () => null, getTargets: () => [] });
  ck.start();
  const t = ck.timer;
  ck.setInterval(5 * 60 * 1000);
  assert.ok(ck.timer && ck.timer !== t && ck.intervalMs === 5 * 60 * 1000);
  ck.stop();
}

// Keyless providers: a named provider with a base URL and no keys gets one empty key;
// requests carry no auth, logs say "no API key". A legacy bare BASE_URL is not a provider.
{
  const kc = Object.create(Config.prototype);
  kc.providers = new Map();
  kc.parseProviders({ OPENAI_FREE_BASE_URL: 'https://free.example.com/v1', OPENAI_FREE_PROXY: 'true',
    GEMINI_GFREE_BASE_URL: 'https://g.example.com/v1beta', OPENAI_BASE_URL: 'https://legacy.example.com/v1',
    OPENAI_OFF_API_KEYS: '~k1' });
  const free = kc.providers.get('free');
  assert.ok(free.keyless && free.proxy && free.apiType === 'openai');
  assert.deepStrictEqual(free.keys, ['']);
  assert.ok(!kc.providers.has('openai'));                                   // legacy BASE_URL alone: not a provider
  assert.ok(!kc.providers.get('off').keyless);                              // all keys disabled is not keyless
  assert.strictEqual(require('../src/keyValues').maskKey(''), 'no API key');
  const o = new OpenAIClient(null, free.baseUrl)._buildRequestOptions('POST', '/chat/completions', '{}', {}, '');
  assert.strictEqual(o.headers.Authorization, undefined);
  const g = new (require('../src/geminiClient'))(null, kc.providers.get('gfree').baseUrl)._buildRequestOptions('GET', '/models', null, {}, '', false);
  assert.ok(!g.path.includes('key=') && !g.headers['x-goog-api-key']);
}

// A malformed URL is not a route and must not throw (it used to crash the process)
assert.strictEqual(ProxyServer.prototype.parseRoute.call({ config: { getProvider: () => null } }, '//['), null);

// Proxy pool: turning auto-fetch off mid-sweep leaves it empty; back on refills at once
(async () => {
  const ProxyPool = require('../src/proxyPool');
  const ProxyManager = require('../src/proxyManager');
  const pool = new ProxyPool();
  pool.timer = 1;                                                      // no interval in tests
  pool.fetchCandidates = async () => ['socks5://1.1.1.1:1', 'socks5://2.2.2.2:2'];
  pool.probe = () => new Promise(r => setTimeout(() => r({ ok: true, ms: 5 }), 30));
  pool.start();
  await new Promise(r => setTimeout(r, 10));
  pool.stop();                                                          // mid-sweep
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(pool.live.length, 0);
  pool.start();                                                         // within the 5-minute gap
  await pool._activeRefresh;
  assert.strictEqual(pool.live.length, 2);
  assert.strictEqual(pool.refreshing, false);

  // An empty pool gets proxies while the sweep is still running, not only at the end
  {
    const p = new ProxyPool();
    const updates = [];
    p.enabled = true;
    p.onUpdate = () => updates.push({ n: p.live.length, refreshing: p.refreshing });
    p.fetchCandidates = async () => ['socks5://1.1.1.1:1', 'socks5://2.2.2.2:2', 'socks5://3.3.3.3:3'];
    p.probe = (u) => new Promise(r => setTimeout(() => r({ ok: true, ms: 5 }), u.includes('1.1.1.1') ? 1 : 60));
    await p.refresh('test', true);
    assert.ok(updates.some(u => u.refreshing && u.n === 1));            // first proxy handed over mid-sweep
    assert.strictEqual(p.live.length, 3);
    updates.length = 0;                                                 // a pool that has proxies waits for the full sweep
    await p.refresh('test', true);
    assert.deepStrictEqual(updates.map(u => u.n), [3]);
  }

  // A refresh re-tests the proxies we already have, even if the lists dropped them
  {
    const p = new ProxyPool();
    p.enabled = true;
    p.live = [{ url: 'socks5://9.9.9.9:1', ms: 100 }];
    p.fetchCandidates = async () => ['socks5://8.8.8.8:1', 'socks4://9.9.9.9:1'];   // same machine, other scheme
    const tested = [];
    p.probe = async (u) => { tested.push(u); return { ok: true, ms: 5 }; };
    await p.refresh('test', true);
    assert.deepStrictEqual(tested.sort(), ['socks4://9.9.9.9:1', 'socks5://8.8.8.8:1']);
    p.remove(['socks5://8.8.8.8:1']);
    assert.deepStrictEqual(p.live.map(e => e.url), ['socks4://9.9.9.9:1']);
  }

  // Lists that write the scheme on each line are read the same as bare host:port
  {
    const p = new ProxyPool();
    const orig = ProxyPool.httpGetWithRetry;
    ProxyPool.httpGetWithRetry = async () => 'socks5://5.5.5.5:1080\n5.5.5.5:1080\n6.6.6.6:8080:US\nnot a proxy\n';
    const c = await p.fetchCandidates();
    ProxyPool.httpGetWithRetry = orig;
    assert.deepStrictEqual(c, ['socks5://5.5.5.5:1080']);                // deduped across lists, junk dropped
  }

  // Green/red picking: random, no reuse until all have had a turn, never twice per request
  {
    const pm = new ProxyManager([], true, { goodMs: 1000, maxTries: 3 });
    const urls = ['a', 'b', 'c', 'd', 'e'].map((h, i) => `socks5://10.0.0.${i + 1}:1080`);
    pm.setAutoProxies(urls.map((url, i) => ({ url, ms: 200 + i * 100 })).concat([{ url: 'socks5://10.0.0.9:1080', ms: 1000 }]));
    assert.strictEqual(pm.isGreen('socks5://10.0.0.9:1080'), false);                 // 1000ms is red (green is below)
    assert.strictEqual(pm.getGreen().length, 5);
    for (let round = 0; round < 20; round++) {
      const seen = new Set();
      for (let i = 0; i < 5; i++) seen.add(pm.pick().url);
      assert.strictEqual(seen.size, 5);                                             // each green once per cycle
      assert.ok(!seen.has('socks5://10.0.0.9:1080'));                               // red never picked
    }
    let last = pm.pick().url;                                                      // no back-to-back repeat across a reshuffle
    for (let i = 0; i < 200; i++) { const u = pm.pick().url; assert.notStrictEqual(u, last); last = u; }
    const tried = new Set();
    for (let i = 0; i < 5; i++) assert.ok(pm.pick(tried));
    assert.strictEqual(tried.size, 5);
    const order = [...tried];
    const reused = pm.pick(tried);                                                  // tried them all: reuse rather than go direct...
    assert.strictEqual(reused.url, order[0]);                                       // ...the one used longest ago
    assert.strictEqual([...tried].pop(), reused.url);                               // and it's now the last used
    pm.recordCheck(urls[0], 5000);
    assert.strictEqual(pm.isGreen(urls[0]), false);                                 // checked slow -> red
    pm.recordCheck(urls[0], 100);
    for (let i = 0; i < 3; i++) pm.reportFailure(urls[1]);
    assert.ok(pm.isBenched(urls[1]) && !pm.isGreen(urls[1]));
    pm.recordCheck(urls[1], 300);
    assert.ok(pm.isGreen(urls[1]));                                                 // a passing check un-benches
    // A successful request doesn't touch the speed: only checks set it
    const before = pm.latencyOf(urls[2]);
    pm.reportSuccess(urls[2]);
    assert.strictEqual(pm.latencyOf(urls[2]), before);
    assert.strictEqual(new ProxyManager([], true).pick(), null);                    // empty list: the only way to go direct
  }

  // Proxy on means a proxy, always: reuse, red, benched - never direct while the list has any
  {
    const mk = (n, ms = 300) => {
      const pm = new ProxyManager([], true);
      pm.setAutoProxies(Array.from({ length: n }, (_, i) => ({ url: `socks5://10.0.5.${i + 1}:1`, ms })));
      return pm;
    };
    const run = (pm, n) => { const tried = new Set(); return Array.from({ length: n }, () => pm.pick(tried).url.split('.').pop()); };
    assert.deepStrictEqual(run(mk(1), 5), ['1:1', '1:1', '1:1', '1:1', '1:1']);      // one green: every key through it
    const two = run(mk(2), 5);
    assert.ok(two.every((u, i) => i === 0 || u !== two[i - 1]));                    // two green: they alternate
    const red = mk(3, 2000);
    red.recordCheck('socks5://10.0.5.2:1', 1500);
    assert.deepStrictEqual(run(red, 4), ['2:1', '1:1', '3:1', '2:1']);              // no green: fastest red first, each once
    const benched = mk(2);
    for (const u of benched.proxyUrls) for (let i = 0; i < 3; i++) benched.reportFailure(u);
    benched.health.get('socks5://10.0.5.2:1').deadUntil = Date.now() + 1000;        // its bench ends first
    assert.strictEqual(benched.pick().url, 'socks5://10.0.5.2:1');
    // A proxy that just failed waits at the back of the bag
    const pm = mk(6);
    const first = pm.pick().url;
    const next = pm._bag[0];
    pm.reportFailure(next);
    assert.notStrictEqual(pm.pick().url, next);
    assert.strictEqual(pm._bag[pm._bag.length - 1], next);
    // Same host:port as socks4 and socks5 is one proxy
    const dup = new ProxyManager([], true);
    dup.setAutoProxies(['socks5://9.9.9.9:1080', 'socks4://9.9.9.9:1080', 'socks4://9.9.9.9:1081']);
    assert.deepStrictEqual(dup.proxyUrls, ['socks5://9.9.9.9:1080', 'socks4://9.9.9.9:1081']);
    assert.ok(first);
  }

  // A keyless provider still rotates through proxies, and is logged as "no API key"
  {
    const KeyRotator = require('../src/keyRotator');
    const pm = new ProxyManager([], true);
    pm.setAutoProxies(['1', '2', '3'].map(n => ({ url: `socks5://10.0.7.${n}:1`, ms: 100 })));
    const c = new OpenAIClient(new KeyRotator([''], 'openai'), 'https://free.example.com/v1', pm);
    const via = [];
    c.sendRequest = (m, p, b, h, key, tried) => {
      const o = c._buildRequestOptions(m, p, b, h, key, tried);
      assert.strictEqual(o.headers.Authorization, undefined);
      via.push(o._proxyUrl);
      return Promise.resolve(via.length < 2
        ? Promise.reject(Object.assign(new Error('dead'), { _proxyFailure: true }))
        : { statusCode: 200, data: '{}', proxyUsed: o._proxyMasked });
    };
    const res = await c.makeRequest('POST', '/chat/completions', '{}', {});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res._keyInfo.keyUsed, 'no API key');
    assert.ok(via.length === 2 && via[0] && via[1] && via[0] !== via[1]);    // proxied, and moved on to another proxy
  }

  // Just after a start: a proxied request waits for the list instead of going direct
  {
    const pm = new ProxyManager([], true);
    let loading = true;
    pm.isLoading = () => loading;
    const OpenAIClient = require('../src/openaiClient');
    const c = new OpenAIClient(null, 'https://x', pm);
    let via;
    const req = c._withProxyRetry((tried) => { via = pm.pick(tried); return Promise.resolve({ statusCode: 200 }); });
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(via, undefined);                                             // still waiting
    pm.setAutoProxies([{ url: 'socks5://10.0.6.1:1', ms: 300 }]); loading = false;
    await req;
    assert.strictEqual(via.url, 'socks5://10.0.6.1:1');                             // went out through the proxy
    const idle = new ProxyManager([], true);
    idle.isLoading = () => false;
    const t = Date.now(); await idle.waitForProxies();
    assert.ok(Date.now() - t < 50);                                                 // nothing loading: no wait
  }

  // A request moves on to another proxy on failure or 403, up to maxTries, then gives up
  {
    const OpenAIClient = require('../src/openaiClient');
    const pm = new ProxyManager([], true, { maxTries: 4 });
    pm.setAutoProxies(['1', '2', '3', '4', '5', '6'].map(n => ({ url: `socks5://10.0.1.${n}:1`, ms: 100 })));
    const c = new OpenAIClient(null, 'https://x', pm);
    let calls = 0;
    const fail = (tried) => { calls++; pm.pick(tried); const e = new Error('dead'); e._proxyFailure = true; return Promise.reject(e); };
    await assert.rejects(c._withProxyRetry(fail), /dead/);
    assert.strictEqual(calls, 4);
    calls = 0;
    const blocked = (tried) => { calls++; pm.pick(tried); return Promise.resolve({ statusCode: 403, _proxyBlocked: true }); };
    assert.strictEqual((await c._withProxyRetry(blocked)).statusCode, 403);          // all blocked: provider's answer passed on
    assert.strictEqual(calls, 4);
    calls = 0;
    const second = (tried) => { calls++; const t = tried.size; pm.pick(tried); return t ? Promise.resolve({ statusCode: 200 }) : Promise.reject(Object.assign(new Error('x'), { _proxyFailure: true })); };
    assert.strictEqual((await c._withProxyRetry(second)).statusCode, 200);
    assert.strictEqual(calls, 2);
  }

  // A key that gets rotated hands the next key a different proxy, and each failed key is logged with its own status and proxy
  {
    const OpenAIClient = require('../src/openaiClient');
    const KeyRotator = require('../src/keyRotator');
    const pm = new ProxyManager([], true);
    pm.setAutoProxies(['1', '2', '3', '4', '5', '6'].map(n => ({ url: `socks5://10.0.3.${n}:1`, ms: 100 })));
    const c = new OpenAIClient(new KeyRotator(['sk-aaaaaaaaaaaa1', 'sk-bbbbbbbbbbbb2', 'sk-cccccccccccc3'], 'openai'), 'https://x', pm);
    for (let round = 0; round < 20; round++) {
      const via = [];
      let n = 0;
      c.sendRequest = (m, p, b, h, key, tried) => {
        const picked = pm.pick(tried);
        via.push(picked.url);
        return Promise.resolve({ statusCode: ++n < 3 ? 429 : 200, data: '', proxyUsed: picked.maskedUrl });
      };
      const res = await c.makeRequest('POST', '/chat/completions', '{}', {});
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(new Set(via).size, 3);                                     // three keys, three different proxies
      const failed = res._keyInfo.failedKeys;
      assert.strictEqual(failed.length, 2);
      assert.deepStrictEqual(failed.map(f => f.status), [429, 429]);
      assert.ok(failed.every(f => f.proxy && f.ms >= 0 && f.at && f.key !== res._keyInfo.keyUsed));
    }
  }

  // Background checker: re-measures, un-benches what passes; handshakes go on under traffic, model calls don't
  {
    const ProxyChecker = require('../src/proxyChecker');
    const pm = new ProxyManager([], true);
    const urls = ['1', '2', '3', '4'].map(n => `socks5://10.0.2.${n}:1`);
    pm.setAutoProxies(urls.map(url => ({ url, ms: 1100 })));                        // all just red
    for (let i = 0; i < 3; i++) pm.reportFailure(urls[3]);                           // one benched
    const modelChecked = [];
    const ck = new ProxyChecker({
      getManager: () => pm, getTargets: () => ['api.example.com'],
      probe: async (url) => ({ ok: url !== urls[2], ms: 300 }),
      modelCheck: async (url) => { modelChecked.push(url); },
      modelGapMs: 0,
    });
    ck.start();
    await ck.cycle();
    assert.deepStrictEqual(urls.map(u => pm.isGreen(u)), [true, true, false, true]);  // re-measured; benched one is back
    assert.strictEqual(modelChecked.length, 3);                                       // green ones got a models check
    await ck.cycle();
    assert.strictEqual(modelChecked.length, 3);                                       // not again within 10 min
    pm.lastPickAt = Date.now();                                                       // traffic arrives
    let probed = 0; ck.probe = async () => { probed++; return { ok: true, ms: 1 }; };
    for (const u of urls) pm._entry(u).modelCheckedAt = 0;
    await ck.cycle();
    assert.strictEqual(probed, 3);                                                    // red ones still get their chance back; the one that failed twice was dropped
    assert.ok(!pm.autoUrls.includes(urls[2]));
    assert.strictEqual(modelChecked.length, 3);                                       // but no model calls while busy
    ck.stop();

    // Test all: every proxy, with no timer running and nothing proxied yet (falls back to the probe target)
    const hosts = [];
    const all = new ProxyChecker({ getManager: () => pm, getTargets: () => [], probe: async (url, host) => { hosts.push(host); return { ok: url !== urls[0], ms: 200 }; }, modelCheck: async () => {} });
    const done = await all.checkAll('api.fallback.com');
    assert.deepStrictEqual({ ...done }, { running: false, done: 3, total: 3, ok: 2, failed: 1 });
    assert.ok(hosts.every(h => h === 'api.fallback.com'));
    assert.deepStrictEqual(urls.map(u => pm.isGreen(u)), [true, true, true, true]);   // 200ms now; one failure is not a bench
  }

  // Dead fetched proxies leave; your own never do; too few green after a pass asks for more
  {
    const mine = 'socks5://10.0.7.1:1080', fetched = 'socks5://10.0.7.2:1080';
    const pm = new ProxyManager([mine], true, { goodMs: 1000 });
    pm.setAutoProxies([{ url: fetched, ms: 300 }]);
    let asked = 0; pm.onPoolExhausted = () => { asked++; };
    const dropped = [];
    const ck = new (require('../src/proxyChecker'))({ getManager: () => pm, getTargets: () => ['h'], probe: async () => ({ ok: false }), modelCheck: async () => {}, onDead: (u) => dropped.push(...u) });
    ck.start();
    await ck.cycle();
    assert.ok(asked > 0);                                                             // 2 green is under MIN_GREEN
    assert.deepStrictEqual(pm.proxyUrls, [mine, fetched]);                            // one failed check isn't dead
    await ck.cycle();
    assert.deepStrictEqual(pm.proxyUrls, [mine]);                                     // two in a row is
    assert.deepStrictEqual(dropped, [fetched]);
    await ck.cycle(); await ck.cycle();
    assert.deepStrictEqual(pm.proxyUrls, [mine]);                                     // yours stays, however often it fails
    ck.stop();
  }

  // Picks are spread across hosts: one big host never fills the start of a cycle
  {
    const list = [];
    for (let p = 1; p <= 10; p++) list.push(`socks5://1.1.1.1:${p}`);
    for (let p = 1; p <= 5; p++) list.push(`socks5://2.2.2.2:${p}`);
    for (let p = 1; p <= 5; p++) list.push(`socks5://3.3.3.3:${p}`);
    for (let i = 0; i < 50; i++) {
      const order = ProxyManager.spreadByHost(list);
      assert.strictEqual(new Set(order).size, 20);                                   // every proxy, once
      const firstHalfBig = order.slice(0, 10).filter(u => u.includes('1.1.1.1')).length;
      assert.ok(firstHalfBig >= 3 && firstHalfBig <= 7);                              // big host spread evenly
    }
  }

  // Rescue: green ran low under traffic -> red/benched proxies re-checked at once
  {
    const ProxyChecker = require('../src/proxyChecker');
    const pm = new ProxyManager([], true);
    const urls = Array.from({ length: 12 }, (_, i) => `socks5://10.0.3.${i + 1}:1`);
    pm.setAutoProxies(urls.map(url => ({ url, ms: 1800 })));                         // all red
    pm.lastPickAt = Date.now();                                                       // busy: idle cycle won't run
    const ck = new ProxyChecker({ getManager: () => pm, getTargets: () => ['h'], probe: async () => ({ ok: true, ms: 400 }), modelCheck: async () => {} });
    ck.start();
    await ck.rescue();
    assert.ok(pm.getGreen().length >= 10);                                            // checks replace the average
    for (const u of urls) pm.recordCheck(u, 9000);
    await ck.rescue();
    assert.ok(pm.getGreen().length < 10);                                             // at most once a minute
    ck.stop();
  }

  // The proxy list survives a restart: saved to disk, restored, no re-fetch while fresh
  {
    const fs = require('fs'), os = require('os'), path = require('path');
    const proxyCache = require('../src/proxyCache');
    const cwd = process.cwd();
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'rotato-cache-')));
    try {
      assert.strictEqual(proxyCache.load(), null);                                   // nothing saved yet
      const pool = new ProxyPool(); pool.timer = 1;
      pool.live = [{ url: 'socks5://10.0.4.1:1', ms: 400 }, { url: 'socks5://10.0.4.2:1', ms: 1500 }];
      pool.lastRefreshAt = Date.now(); pool.lastTested = 900;
      const pm = new ProxyManager([], true);
      pm.setAutoProxies(pool.live);
      for (let i = 0; i < 3; i++) pm.reportFailure('socks5://10.0.4.2:1');
      const json = proxyCache.save(pool, pm);
      assert.strictEqual(proxyCache.save(pool, pm, json), json);                     // unchanged: no rewrite

      const cache = proxyCache.load();
      const pool2 = new ProxyPool(); pool2.timer = 1;
      let fetched = 0; pool2.fetchCandidates = async () => { fetched++; return []; };
      pool2.restore(cache);
      pool2.start();
      assert.strictEqual(fetched, 0);                                                 // fresh: used as is
      assert.strictEqual(pool2.live.length, 2);
      assert.ok(cache.health['socks5://10.0.4.2:1'].deadUntil > Date.now());          // bench survives too

      const pool3 = new ProxyPool(); pool3.timer = 1;
      pool3.fetchCandidates = async () => { fetched++; return []; };
      pool3.restore({ ...cache, lastRefreshAt: Date.now() - 60 * 60 * 1000 });
      pool3.start();
      await pool3._activeRefresh;
      assert.strictEqual(fetched, 1);                                                 // stale: fetched again
      fs.writeFileSync(path.join(process.cwd(), proxyCache.FILE), '{broken');
      assert.strictEqual(proxyCache.load(), null);                                    // unreadable: start fresh
    } finally {
      process.chdir(cwd);
    }
  }

  // Dropped auto proxies don't keep their agents around
  const m = new ProxyManager([], true);
  m.setAutoProxies(['socks5://1.1.1.1:1']);
  m.getAgentFor('socks5://1.1.1.1:1');
  m.setAutoProxies(['socks5://2.2.2.2:2']);
  assert.strictEqual(m._agentCache.size, 0);

  console.log('All tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
