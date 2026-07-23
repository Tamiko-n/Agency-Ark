// Saved settings: the sub-account name -> webhook mappings.
// GET    /api/destinations           list
// POST   /api/destinations           add    { name, webhook_url }
// PATCH  /api/destinations?id=...    update { name?, webhook_url?, active? }
// DELETE /api/destinations?id=...    remove

import { sb, cors, checkAuth, configError, normName, readJsonBody } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const cfg = configError();
  if (cfg) return res.status(cfg.status).json(cfg.body);

  const auth = checkAuth(req);
  if (auth) return res.status(auth.status).json(auth.body);

  try {
    if (req.method === 'GET') {
      const rows = await sb('dispatch_destinations?select=*&order=name.asc');
      return res.status(200).json({ destinations: rows });
    }

    if (req.method === 'POST') {
      const { name, webhook_url } = await readJsonBody(req);
      if (!name || !webhook_url) {
        return res.status(400).json({ error: 'A destination needs a name and a webhook URL.' });
      }
      if (!/^https?:\/\//i.test(webhook_url)) {
        return res.status(400).json({ error: 'The webhook URL must start with http:// or https://' });
      }
      const match_key = normName(name);
      if (!match_key) {
        return res.status(400).json({ error: 'That name has no letters or numbers to match on.' });
      }

      const existing = await sb(`dispatch_destinations?match_key=eq.${encodeURIComponent(match_key)}&select=id`);
      if (existing.length) {
        return res.status(409).json({ error: `A destination matching "${name}" already exists.` });
      }

      const rows = await sb('dispatch_destinations', {
        method: 'POST',
        body: JSON.stringify({ name: String(name).trim(), match_key, webhook_url: String(webhook_url).trim() })
      });
      return res.status(201).json({ destination: rows[0] });
    }

    const id = req.query?.id || new URL(req.url, 'http://x').searchParams.get('id');
    if (!id) return res.status(400).json({ error: 'Missing id.' });

    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const patch = { updated_at: new Date().toISOString() };
      if (body.name !== undefined)        { patch.name = String(body.name).trim();
                                            patch.match_key = normName(body.name); }
      if (body.webhook_url !== undefined) patch.webhook_url = String(body.webhook_url).trim();
      if (body.active !== undefined)      patch.active = !!body.active;

      const rows = await sb(`dispatch_destinations?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(patch)
      });
      if (!rows.length) return res.status(404).json({ error: 'No destination with that id.' });
      return res.status(200).json({ destination: rows[0] });
    }

    if (req.method === 'DELETE') {
      await sb(`dispatch_destinations?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: `${req.method} is not supported here.` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
