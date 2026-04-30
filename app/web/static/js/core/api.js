// ─── core/api.js ───────────────────────────────────────────────────────────
// Thin fetch wrappers consolidating the {method, headers, body:
// JSON.stringify(...)} boilerplate that the legacy file repeats at
// every POST callsite. Named apiGet/apiPost/apiDelete/apiPut so a
// callsite reads "what HTTP verb am I doing" without scanning the
// options dict.
//
// Error semantics match the legacy `j` helper: throw on non-2xx with
// the response body as the message, return parsed JSON on success.
// The legacy `j` is re-exported here so existing callsites in
// legacy.js keep working unchanged during the staged refactor — once
// legacy.js is gone, only the apiX names remain.

async function _request(url, init = {}) {
  const r = await fetch(url, init);
  if (!r.ok) {
    let detail;
    try { detail = await r.text(); } catch { detail = r.statusText; }
    throw new Error(detail || `${r.status} ${r.statusText}`);
  }
  // 204 No Content / empty body — return null rather than crashing
  // on JSON.parse. Production endpoints always return JSON but the
  // delete handlers return 204 in some places.
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return null;
  return r.json();
}

export const apiGet = (url) => _request(url);

export const apiPost = (url, body) => _request(url, {
  method: 'POST',
  headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

export const apiPut = (url, body) => _request(url, {
  method: 'PUT',
  headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

export const apiDelete = (url, body) => _request(url, {
  method: 'DELETE',
  headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

// Legacy fetch helper — same shape as the original. Other modules
// that haven't migrated yet still import this name.
export const j = async (url, opt) => {
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};
