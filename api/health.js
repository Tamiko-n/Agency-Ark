// Diagnostic endpoint — open /api/health in a browser.
// Reports what the server sees and whether it can reach Supabase.
// The service key is never shown, only its length and shape.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const rawUrl = process.env.SUPABASE_URL || '';
  const url    = rawUrl.replace(/\/+$/, '');
  const key    = process.env.SUPABASE_SERVICE_KEY || '';
  const token  = process.env.DISPATCH_TOKEN || '';

  const report = {
    supabase_url_set: !!rawUrl,
    supabase_url_as_configured: rawUrl,           // not secret — safe to show
    supabase_url_used: url,
    url_looks_right: /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url),
    service_key_set: !!key,
    service_key_length: key.length,
    service_key_looks_like_jwt: key.startsWith('eyJ'),
    service_key_looks_like_new_secret: key.startsWith('sb_secret_'),
    dispatch_token_set: !!token,
    send_mode: process.env.SEND_MODE || 'per_contact (default)'
  };

  if (!report.url_looks_right) {
    report.problem =
      'SUPABASE_URL should look exactly like https://abcdefgh.supabase.co — ' +
      'no trailing slash, no /rest/v1, and not the dashboard address ' +
      '(supabase.com/dashboard/project/...). Fix it in Vercel and redeploy.';
    return res.status(200).json(report);
  }
  if (!key) {
    report.problem = 'SUPABASE_SERVICE_KEY is missing. Add it in Vercel and redeploy.';
    return res.status(200).json(report);
  }

  // Live test against the destinations table
  const target = `${url}/rest/v1/dispatch_destinations?select=id&limit=1`;
  report.test_request = target;
  try {
    const r = await fetch(target, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    const body = await r.text();
    report.test_status = r.status;
    report.test_response = body.slice(0, 300);
    report.supabase_reachable = true;

    if (r.ok) {
      report.result = 'All good — the API can read your Supabase tables.';
    } else if (r.status === 401 || r.status === 403) {
      report.problem = 'Supabase rejected the key. Make sure it is the service_role ' +
                       '(or sb_secret_) key, copied in full.';
    } else if (r.status === 404) {
      report.problem = 'Table dispatch_destinations not found. Run schema.sql in the ' +
                       'SQL Editor of THIS project.';
    } else {
      report.problem = 'Supabase answered with an error — see test_response.';
    }
  } catch (err) {
    report.supabase_reachable = false;
    report.test_error = err.message;
    report.problem = 'Could not reach that URL at all. The host in SUPABASE_URL is wrong.';
  }

  return res.status(200).json(report);
}
