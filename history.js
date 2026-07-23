// Recent dispatch activity, newest first. Used by the portal's receipts panel.
// GET /api/history?limit=40

import { sb, cors, checkAuth, configError } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only.' });

  const cfg = configError();
  if (cfg) return res.status(cfg.status).json(cfg.body);

  const auth = checkAuth(req);
  if (auth) return res.status(auth.status).json(auth.body);

  const limit = Math.min(parseInt(req.query?.limit || '40', 10) || 40, 200);
  try {
    const rows = await sb(`dispatch_log?select=*&order=created_at.desc&limit=${limit}`);
    return res.status(200).json({ history: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
