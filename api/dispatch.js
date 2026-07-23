// The endpoint n8n posts contacts to.
//
//   POST /api/dispatch
//   Header: X-Dispatch-Token: <your token>   (if DISPATCH_TOKEN is set)
//   Body:   { "contacts": [ { ..., "tags": ["Agency Ark"] }, ... ] }
//           (a bare array also works)
//
// Each contact goes to the destination whose name matches one of its tags,
// or its destination_name / subaccount field.
// Contacts that match nothing are RETURNED, never silently dropped.
//
// ---------------------------------------------------------------------------
// SEND MODE  — set the SEND_MODE environment variable in Vercel
//
//   per_contact  (default)  one request per contact.
//                           Required for GoHighLevel Inbound Webhooks, which
//                           start one workflow run per POST and map fields from
//                           a single flat object. They cannot loop an array.
//
//   batch                   one request per destination carrying every contact
//                           in a "contacts" array. Fewer calls — use it when the
//                           receiving side can iterate.
// ---------------------------------------------------------------------------

import { sb, cors, checkAuth, configError, normName, readJsonBody } from './_lib.js';

const FORWARD_TIMEOUT_MS = 20000;
const SEND_MODE   = (process.env.SEND_MODE || 'per_contact').toLowerCase();
const CONCURRENCY = 5;     // parallel requests in per_contact mode

function readTags(c) {
  const raw = c.tags ?? c.tag ?? c.subaccount ?? c.destination ??
              c.destination_name ?? c.destination_subaccount;
  if (raw == null) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String);
}

// GHL webhooks map fields from a flat object, so give them clean top-level keys
// while keeping every original field the caller sent.
function flatten(c, destName) {
  const name = c.clean_name || c.name || '';
  const parts = String(name).trim().split(/\s+/);
  return {
    ...c,
    firstName: c.firstName || c.first_name || parts[0] || '',
    lastName:  c.lastName  || c.last_name  || parts.slice(1).join(' ') || '',
    name:      name || [c.firstName, c.lastName].filter(Boolean).join(' '),
    phone:     c.phone || c.clean_phone || '',
    email:     c.email || c.clean_email || '',
    source:    c.source || c.source_ad || '',
    subaccount: destName
  };
}

async function postWithTimeout(url, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FORWARD_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const text = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, body: text.slice(0, 200) };
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? `No response within ${FORWARD_TIMEOUT_MS / 1000}s`
      : err.message;
    return { ok: false, status: 0, body: msg };
  } finally {
    clearTimeout(timer);
  }
}

// Send one request per contact, a few at a time.
async function sendPerContact(dest, batch, run_id) {
  let ok = 0;
  const failures = [];
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const slice = batch.slice(i, i + CONCURRENCY);
    const rs = await Promise.all(slice.map(c =>
      postWithTimeout(dest.webhook_url, { ...flatten(c, dest.name), run_id })
    ));
    rs.forEach((r, n) => {
      if (r.ok) ok++;
      else failures.push(`${slice[n].lead_id || slice[n].phone || 'contact'}: ${r.status} ${r.body}`);
    });
  }
  return { ok, failures };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Send contacts with POST.' });

  const cfg = configError();
  if (cfg) return res.status(cfg.status).json(cfg.body);

  const auth = checkAuth(req);
  if (auth) return res.status(auth.status).json(auth.body);

  let contacts;
  try {
    const body = await readJsonBody(req);
    contacts = Array.isArray(body) ? body
             : (body.contacts || body.leads || body.data || (body.lead_id ? [body] : null));
    if (!Array.isArray(contacts)) {
      return res.status(400).json({
        error: 'Send a list of contacts.',
        detail: 'Expected { "contacts": [ ... ] } or a bare JSON array.'
      });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Body is not valid JSON.', detail: e.message });
  }

  if (!contacts.length) {
    return res.status(200).json({ run_id: null, received: 0, sent: 0, unrouted: 0,
                                  results: [], message: 'Nothing to dispatch.' });
  }

  let destinations;
  try {
    destinations = await sb('dispatch_destinations?select=*&active=eq.true');
  } catch (err) {
    return res.status(500).json({ error: 'Could not read destinations.', detail: err.message });
  }
  if (!destinations.length) {
    return res.status(409).json({
      error: 'No sub-accounts are receiving.',
      detail: 'Add at least one sub-account and webhook in the portal first.',
      received: contacts.length
    });
  }

  // ---- sort into lanes ----------------------------------------------------
  const byKey = new Map(destinations.map(d => [d.match_key, d]));
  const lanes = new Map(destinations.map(d => [d.id, []]));
  const unrouted = [];

  for (const c of contacts) {
    const tags = readTags(c).map(normName).filter(Boolean);
    let dest = null;
    for (const t of tags) { if (byKey.has(t)) { dest = byKey.get(t); break; } }
    if (dest) lanes.get(dest.id).push(c);
    else unrouted.push({ contact: c, tags: readTags(c) });
  }

  // ---- forward ------------------------------------------------------------
  const run_id = (globalThis.crypto?.randomUUID?.() ||
                  `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const results = [];
  const logRows = [];

  for (const d of destinations) {
    const batch = lanes.get(d.id) || [];
    if (!batch.length) continue;

    if (SEND_MODE === 'batch') {
      const r = await postWithTimeout(d.webhook_url,
        { subaccount: d.name, count: batch.length, run_id, contacts: batch });
      const detail = r.ok ? null : `HTTP ${r.status} ${r.body}`;
      results.push({ destination: d.name, count: batch.length, mode: 'batch',
                     status: r.ok ? 'sent' : 'failed', ...(detail ? { detail } : {}) });
      logRows.push({ run_id, destination: d.name, webhook_url: d.webhook_url,
                     contact_count: batch.length, status: r.ok ? 'sent' : 'failed', detail });
    } else {
      const { ok, failures } = await sendPerContact(d, batch, run_id);
      const failed = batch.length - ok;
      const status = failed === 0 ? 'sent' : (ok === 0 ? 'failed' : 'partial');
      const detail = failed ? `${failed} of ${batch.length} failed — ${failures.slice(0,3).join(' | ')}` : null;
      results.push({ destination: d.name, count: batch.length, sent: ok, failed,
                     mode: 'per_contact', status, ...(detail ? { detail } : {}) });
      logRows.push({ run_id, destination: d.name, webhook_url: d.webhook_url,
                     contact_count: ok, status, detail });
    }
  }

  const unmatched_tags = [...new Set(unrouted.flatMap(u => u.tags))];
  if (unrouted.length) {
    logRows.push({ run_id, destination: null, webhook_url: null,
                   contact_count: unrouted.length, status: 'unrouted',
                   detail: `Unmatched: ${unmatched_tags.slice(0, 20).join(', ') || '(no tag)'}` });
  }

  try { if (logRows.length) await sb('dispatch_log', {
    method: 'POST', body: JSON.stringify(logRows), prefer: 'return=minimal' }); }
  catch (e) { /* logging must never fail the dispatch */ }

  const sent = results.reduce((s, r) => s + (r.sent ?? (r.status === 'sent' ? r.count : 0)), 0);

  return res.status(200).json({
    run_id,
    mode: SEND_MODE,
    received: contacts.length,
    sent,
    unrouted: unrouted.length,
    results,
    unrouted_contacts: unrouted.map(u => u.contact),
    unmatched_tags
  });
}
