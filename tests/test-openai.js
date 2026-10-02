const test = require('node:test');
const assert = require('node:assert/strict');
const OpenAIClient = require('../src/openaiClient');
const KeyRotator = require('../src/keyRotator');

function makeClient() {
  const rotator = new KeyRotator(['ok1', 'ok2'], 'openai');
  return new OpenAIClient(rotator, 'https://api.openai.com');
}

test('OpenAIClient - adds a Bearer Authorization header by default', () => {
  const client = makeClient();
  const options = client._buildRequestOptions('POST', '/v1/chat/completions', { a: 1 }, {}, 'my-key');

  assert.equal(options.headers['Authorization'], 'Bearer my-key');
  assert.equal(options.hostname, 'api.openai.com');
});

test('OpenAIClient - does not overwrite an Authorization header already provided', () => {
  const client = makeClient();
  const options = client._buildRequestOptions(
    'POST',
    '/v1/chat/completions',
    { a: 1 },
    { authorization: 'Bearer custom-token' },
    'my-key'
  );

  assert.equal(options.headers.authorization, 'Bearer custom-token');
});

test('OpenAIClient - sets Content-Length only for non-GET requests with a body', () => {
  const client = makeClient();
  const withBody = client._buildRequestOptions('POST', '/v1/test', { a: 1 }, {}, 'k');
  const getRequest = client._buildRequestOptions('GET', '/v1/test', null, {}, 'k');

  assert.ok(withBody.headers['Content-Length'] > 0);
  assert.equal(getRequest.headers['Content-Length'], undefined);
});

test('OpenAIClient - maskApiKey hides the middle of a key', () => {
  const client = makeClient();
  assert.equal(client.maskApiKey('sk-abcdefgh1234'), 'sk-a...1234');
});
