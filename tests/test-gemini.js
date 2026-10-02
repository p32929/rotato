const test = require('node:test');
const assert = require('node:assert/strict');
const GeminiClient = require('../src/geminiClient');
const KeyRotator = require('../src/keyRotator');

function makeClient() {
  const rotator = new KeyRotator(['gk1', 'gk2'], 'gemini');
  return new GeminiClient(rotator, 'https://generativelanguage.googleapis.com');
}

test('GeminiClient - builds a request URL with the key as a query param by default', () => {
  const client = makeClient();
  const options = client._buildRequestOptions('POST', '/v1beta/models/gemini-pro:generateContent', { a: 1 }, {}, 'my-key', false);

  assert.equal(options.hostname, 'generativelanguage.googleapis.com');
  assert.ok(options.path.startsWith('/v1beta/models/gemini-pro:generateContent'));
  assert.ok(options.path.includes('key=my-key'));
  assert.equal(options.headers['x-goog-api-key'], undefined);
});

test('GeminiClient - builds a request with the key as a header when useHeader is true', () => {
  const client = makeClient();
  const options = client._buildRequestOptions('POST', '/v1beta/models/gemini-pro:generateContent', { a: 1 }, {}, 'my-key', true);

  assert.equal(options.headers['x-goog-api-key'], 'my-key');
  assert.ok(!options.path.includes('key=my-key'));
});

test('GeminiClient - sets Content-Length only for non-GET requests with a body', () => {
  const client = makeClient();
  const withBody = client._buildRequestOptions('POST', '/v1/test', { a: 1 }, {}, 'k', false);
  const getRequest = client._buildRequestOptions('GET', '/v1/test', null, {}, 'k', false);

  assert.ok(withBody.headers['Content-Length'] > 0);
  assert.equal(getRequest.headers['Content-Length'], undefined);
});

test('GeminiClient - maskApiKey hides the middle of a key', () => {
  const client = makeClient();
  assert.equal(client.maskApiKey('AIzaSyABCDEFGH1234'), 'AIza...1234');
});
