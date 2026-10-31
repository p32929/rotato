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

console.log('All tests passed');
