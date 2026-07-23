// The endpoint n8n posts contacts to.
//
//   POST /api/dispatch
//   Header: X-Dispatch-Token: <your token>   (if DISPATCH_TOKEN is set)
//   Body:   { "contacts": [ { ..., "tags": ["Agency Ark"] }, ... ] }
//           (a bare array also works)
//
// Each contact goes to the destination whose name matches one of its tags.
// Matching ignores case, spaces and punctuation.
// Contacts that match nothing are RETURNED, never silently dropped.

import { sb, cors, checkAuth, configError, normName, readJsonBody } from './_lib.js';

const FORWARD_TIMEOUT_MS = 20000;

function readTags(c) {
  const raw = c.tags ?? c.tag ?? c.subaccount ?? c.destination ??
              c.destination_name ?? c.destination_subaccount;
  if (raw == null) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String);
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
    return { ok: r.ok, status: r.status, body: text.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Send contacts with POST.' });
  }

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

  // ---- load saved settings ------------------------------------------------
  let destinations;
  try {
    destinations = await sb('dispatch_destinations?select=*&active=eq.true');
  } catch (err) {
    return res.status(500).json({ error: 'Could not read destinations.', detail: err.message });
  }
  if (!destinations.length) {
    return res.status(409).json({
      error: 'No active destinations are saved.',
      detail: 'Add at least one sub-account and webhook in the portal before dispatching.',
      received: contacts.length
    });
  }

  const byKey = new Map(destinations.map(d => [d.match_key, d]));

  // ---- sort into lanes ----------------------------------------------------
  const lanes = new Map(destinations.map(d => [d.id, []]));
  const unrouted = [];

  for (const c of contacts) {
    const tags = readTags(c).map(normName).filter(Boolean);
    let dest = null;
    for (const t of tags) { if (byKey.has(t)) { dest = byKey.get(t); break; } }
    if (dest) lanes.get(dest.id).push(c);
    else unrouted.push({ contact: c, tags: readTags(c) });
  }

  // ---- forward, one call per destination ---------------------------------
  const run_id = (globalThis.crypto?.randomUUID?.() ||
                  `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const results = [];
  const logRows = [];

  for (const d of destinations) {
    const batch = lanes.get(d.id) || [];
    if (!batch.length) continue;
    try {
      const r = await postWithTimeout(d.webhook_url, {
        subaccount: d.name, count: batch.length, run_id, contacts: batch
      });
      const ok = r.ok;
      results.push({ destination: d.name, count: batch.length,
                     status: ok ? 'sent' : 'failed',
                     detail: ok ? undefined : `HTTP ${r.status} ${r.body}` });
      logRows.push({ run_id, destination: d.name, webhook_url: d.webhook_url,
                     contact_count: batch.length, status: ok ? 'sent' : 'failed',
                     detail: ok ? null : `HTTP ${r.status} ${r.body}` });
    } catch (err) {
      const detail = err.name === 'AbortError'
        ? `No response within ${FORWARD_TIMEOUT_MS / 1000}s`
        : err.message;
      results.push({ destination: d.name, count: batch.length, status: 'failed', detail });
      logRows.push({ run_id, destination: d.name, webhook_url: d.webhook_url,
                     contact_count: batch.length, status: 'failed', detail });
    }
  }

  if (unrouted.length) {
    const tagList = [...new Set(unrouted.flatMap(u => u.tags))].slice(0, 20);
    logRows.push({ run_id, destination: null, webhook_url: null,
                   contact_count: unrouted.length, status: 'unrouted',
                   detail: `Unmatched tags: ${tagList.join(', ') || '(none)'}` });
  }

  try { if (logRows.length) await sb('dispatch_log', {
    method: 'POST', body: JSON.stringify(logRows), prefer: 'return=minimal' }); }
  catch (e) { /* logging must never fail the dispatch */ }

  const sent = results.filter(r => r.status === 'sent')
                      .reduce((s, r) => s + r.count, 0);

  return res.status(200).json({
    run_id,
    received: contacts.length,
    sent,
    unrouted: unrouted.length,
    results,
    // returned so nothing is lost — n8n can retry or hold these
    unrouted_contacts: unrouted.map(u => u.contact),
    unmatched_tags: [...new Set(unrouted.flatMap(u => u.tags))]
  });
}
