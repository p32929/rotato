// A stored key can carry its own values for the base URL:
//
//   BASE_URL=https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1
//   API_KEYS=token1|accountId=abc,token2|accountId=def
//
// Each {name} in the base URL is filled from the key being tried, so every key
// in a rotation can hit its own account. A key without "|name=value" parts is
// used exactly as written, so existing configs behave as before.

const PAIR_RE = /^(\w+)=(.*)$/;

function parseKey(raw) {
  const str = String(raw || '').trim();
  const [token, ...pairs] = str.split('|');
  const values = {};
  for (const pair of pairs) {
    const match = pair.trim().match(PAIR_RE);
    // Anything that isn't name=value means "|" belongs to the key itself
    if (!match) return { token: str, values: {} };
    values[match[1]] = match[2].trim();
  }
  return { token: token.trim(), values };
}

/** The real token plus the base URL with this key's values filled in. Throws if a value is missing. */
function resolveKey(raw, baseUrl) {
  const { token, values } = parseKey(raw);
  if (!baseUrl) return { token, baseUrl };

  const missing = [];
  const filled = baseUrl.replace(/\{(\w+)\}/g, (placeholder, name) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) return encodeURIComponent(values[name]);
    missing.push(name);
    return placeholder;
  });

  if (missing.length > 0) {
    const hint = missing.map(name => `|${name}=...`).join('');
    throw new Error(`Key has no value for {${missing.join('}, {')}} in the URL - add it after the key, like key${hint}`);
  }
  return { token, baseUrl: filled };
}

/** Mask the token; show only the start of each value so keys stay tellable apart. */
function maskKey(raw) {
  const { token, values } = parseKey(raw);
  const masked = !token || token.length < 8 ? '***' : token.substring(0, 4) + '...' + token.substring(token.length - 4);
  const names = Object.keys(values);
  if (names.length === 0) return masked;
  return `${masked} (${names.map(name => `${name}=${values[name].substring(0, 4)}…`).join(', ')})`;
}

module.exports = { parseKey, resolveKey, maskKey };
