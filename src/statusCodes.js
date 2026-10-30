// Which upstream status codes make rotato try the next key. One syntax, used by
// the [STATUS_CODES:...] header and the default in Settings:
//
//   429          one code
//   420-429      a range, both ends included
//   >=400  >400  <=404  <300    comparisons
//
// Mix them with commas: "403, 420-429, >=500".

const MIN = 100;
const MAX = 599;

function range(from, to) {
  const out = [];
  for (let i = Math.max(from, MIN); i <= Math.min(to, MAX); i++) out.push(i);
  return out;
}

/** Codes one part stands for, or null if the part isn't valid. */
function expandPart(part) {
  let m;
  if ((m = part.match(/^(\d{3})$/))) {
    const code = Number(m[1]);
    return code >= MIN && code <= MAX ? [code] : null;
  }
  if ((m = part.match(/^(\d{3})\s*-\s*(\d{3})$/))) {
    const from = Number(m[1]), to = Number(m[2]);
    return from <= to && from >= MIN && to <= MAX ? range(from, to) : null;
  }
  if ((m = part.match(/^(>=|>|<=|<)\s*(\d{3})$/))) {
    const n = Number(m[2]);
    if (n < MIN || n > MAX) return null;
    const codes = { '>=': range(n, MAX), '>': range(n + 1, MAX), '<=': range(MIN, n), '<': range(MIN, n - 1) }[m[1]];
    return codes.length ? codes : null;
  }
  return null;
}

/**
 * Parse a spec like "403, 420-429, >=500".
 * Returns { codes: Set<number>, parts: string[] (the valid ones, tidied), invalid: string[] }.
 */
function parseStatusCodes(spec) {
  const codes = new Set();
  const parts = [];
  const invalid = [];
  for (const raw of String(spec || '').split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const expanded = expandPart(part);
    if (!expanded) { invalid.push(part); continue; }
    expanded.forEach(c => codes.add(c));
    const tidy = part.replace(/\s+/g, '');
    if (!parts.includes(tidy)) parts.push(tidy);
  }
  return { codes, parts, invalid };
}

/** "403, 420–429, 500–599" — the codes a set covers, with runs collapsed. */
function describeStatusCodes(codes) {
  const sorted = [...codes].sort((a, b) => a - b);
  const runs = [];
  for (const c of sorted) {
    const last = runs[runs.length - 1];
    if (last && c === last[1] + 1) last[1] = c; else runs.push([c, c]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

module.exports = { parseStatusCodes, describeStatusCodes };
