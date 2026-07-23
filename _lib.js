// Shared helpers. No npm dependencies — talks to Supabase over its REST API
// using the global fetch available in the Vercel Node runtime.

const SUPABASE_URL = process.env.SUPABASE_URL;          // https://xxxx.supabase.co
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;  // service_role key
const TOKEN        = process.env.DISPATCH_TOKEN;        // optional shared secret

export function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dispatch-Token');
}

// Returns null when authorised, or an error object to send back.
export function checkAuth(req) {
  if (!TOKEN) return null;                       // no token configured = open
  const given = req.headers['x-dispatch-token'];
  if (given === TOKEN) return null;
  return { status: 401, body: { error: 'Bad or missing X-Dispatch-Token header.' } };
}

export function configError() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { status: 500, body: {
      error: 'Server not configured.',
      detail: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY in the Vercel project environment variables.'
    }};
  }
  return null;
}

// Thin wrapper over the Supabase REST endpoint.
export async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!res.ok) {
    const msg = (body && (body.message || body.hint)) || `Supabase returned ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}
