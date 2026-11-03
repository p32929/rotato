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
    assert.strictEqual(pm.pick(tried), null);                                       // this request tried them all
    pm.recordLatency(urls[0], 5000); pm.recordLatency(urls[0], 5000); pm.recordLatency(urls[0], 5000);
    assert.strictEqual(pm.isGreen(urls[0]), false);                                 // slowed down -> red
    pm.recordCheck(urls[0], 100);
    for (let i = 0; i < 3; i++) pm.reportFailure(urls[1]);
    assert.ok(pm.isBenched(urls[1]) && !pm.isGreen(urls[1]));
    pm.recordCheck(urls[1], 300);
    assert.ok(pm.isGreen(urls[1]));                                                 // a passing check un-benches
    // A successful request doesn't touch the speed: that's connect time, recorded by the agent
    const before = pm.latencyOf(urls[2]);
    pm.reportSuccess(urls[2]);
    assert.strictEqual(pm.latencyOf(urls[2]), before);
    pm.getAgentFor(urls[2]).onConnected(before);                                     // agent reports its connect time
    assert.strictEqual(pm.latencyOf(urls[2]), before);
        const none = new ProxyManager([], true);
    none.setAutoProxies([{ url: 'socks5://10.0.0.7:1', ms: 3000 }]);
    assert.strictEqual(none.pick(), null);                                          // no green: go direct
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

  // Background checker: checks while idle, un-benches what passes, stops on traffic
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
    await ck.cycle();
    assert.strictEqual(probed, 0);
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
    for (const u of urls) pm.recordLatency(u, 9000), pm.recordLatency(u, 9000), pm.recordLatency(u, 9000);
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
