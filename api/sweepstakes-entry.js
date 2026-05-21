// /api/sweepstakes-entry.js
//
// Receives Step 2 sweepstakes form submissions and saves them to Vercel KV.
// Posts the entry to AWeber's Step 2 form ID 463086401 as a best-effort
// background call so the entry-complete tag still applies if AWeber accepts
// re-submissions (older accounts sometimes do; newer ones don't).
//
// Storage key shape: entry:<quarter>:<email>   (one entry per email per quarter)
// Example:           entry:Q1-2026:dave@example.com
//
// Env vars required (set in Vercel dashboard → Project → Environment Variables):
//   KV_REST_API_URL          (auto-set when you create a Vercel KV store)
//   KV_REST_API_TOKEN        (auto-set when you create a Vercel KV store)
//   SWEEPS_QUARTER           (manual, e.g. "Q1-2026")  — change at start of each quarter
//   AWEBER_FORM_LISTNAME     (manual, e.g. "awlist6949115") — same value as in the form
//
// No other dependencies. Uses the Vercel KV REST API directly via fetch().

export default async function handler(req, res) {
  // ─── CORS for safety (page is on same domain, but be defensive) ────
  res.setHeader('Access-Control-Allow-Origin', 'https://themulliganreport.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // ─── Parse the form body (supports both JSON and form-encoded) ──
    let body = req.body;
    if (typeof body === 'string') {
      // Could be JSON string or url-encoded string; try JSON first.
      try {
        body = JSON.parse(body);
      } catch (_) {
        body = parseFormEncoded(body);
      }
    }
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'Invalid form data' });
    }

    // ─── Required-field validation ──────────────────────────────────
    const email      = clean(body.email);
    const name       = clean(body.name);
    const street     = clean(body.street || body['custom Street Address']);
    const city       = clean(body.city || body['custom City']);
    const state      = clean(body.state || body['custom State']).toUpperCase();
    const zip        = clean(body.zip || body['custom zip_code']);
    const ballChoice = clean(body.ballChoice || body['custom ball_choice']);
    const phone      = clean(body.phone || body['custom Phone Number']);
    const handicap   = clean(body.handicap || body['custom handicap_range']);

    const missing = [];
    if (!email)      missing.push('email');
    if (!name)       missing.push('name');
    if (!street)     missing.push('street');
    if (!city)       missing.push('city');
    if (!state)      missing.push('state');
    if (!zip)        missing.push('zip');
    if (!ballChoice) missing.push('ballChoice');

    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field(s)',
        missing,
      });
    }

    if (!isLikelyEmail(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid email format' });
    }

    if (!/^[A-Z]{2}$/.test(state)) {
      return res.status(400).json({ ok: false, error: 'State must be a 2-letter abbreviation' });
    }

    if (!['Pro V1', 'Pro V1x', 'AVX'].includes(ballChoice)) {
      return res.status(400).json({ ok: false, error: 'Invalid ball choice' });
    }

    // ─── Build the entry record ─────────────────────────────────────
    const quarter = process.env.SWEEPS_QUARTER || 'Q1-2026';
    const entry = {
      email: email.toLowerCase(),
      name,
      street,
      city,
      state,
      zip,
      phone:    phone    || null,
      handicap: handicap || null,
      ballChoice,
      quarter,
      submittedAt: new Date().toISOString(),
      ip:         req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || null,
      userAgent:  req.headers['user-agent'] || null,
    };

    // ─── Save to Vercel KV ──────────────────────────────────────────
    const kvKey = `entry:${quarter}:${entry.email}`;
    const kvOk  = await kvSet(kvKey, entry);
    if (!kvOk) {
      // KV write failed — log it but don't fail the user. We'll still try to
      // hit AWeber so the entry at least exists somewhere.
      console.error('[sweepstakes] KV write failed for', kvKey);
    }

    // ─── Also try AWeber (best effort, fire and forget) ─────────────
    // If AWeber accepts the re-submission, the entry-complete tag gets
    // applied automatically. If not, we still have the entry in KV.
    awebernSubmit(entry).catch(err => {
      console.error('[sweepstakes] AWeber best-effort submit failed:', err.message);
    });

    return res.status(200).json({
      ok: true,
      quarter,
      saved: kvOk,
    });

  } catch (err) {
    console.error('[sweepstakes] handler error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function clean(v) {
  if (v == null) return '';
  return String(v).trim().slice(0, 500); // sane upper bound
}

function isLikelyEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function parseFormEncoded(s) {
  const out = {};
  s.split('&').forEach(pair => {
    if (!pair) return;
    const [k, v = ''] = pair.split('=');
    const key   = decodeURIComponent(k.replace(/\+/g, ' '));
    const value = decodeURIComponent(v.replace(/\+/g, ' '));
    out[key] = value;
  });
  return out;
}

// Vercel KV REST API — uses the same endpoint Vercel exposes via env vars.
async function kvSet(key, value) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.error('[sweepstakes] KV env vars not configured');
    return false;
  }
  try {
    const resp = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(value),
    });
    return resp.ok;
  } catch (err) {
    console.error('[sweepstakes] kvSet network error:', err.message);
    return false;
  }
}

// Best-effort AWeber submit. Posts the same fields the form would have posted.
// We don't wait for or care about the response — if AWeber updates the
// subscriber's tag, great; if not, we have KV.
async function awebernSubmit(entry) {
  const listname = process.env.AWEBER_FORM_LISTNAME || 'awlist6949115';
  const params = new URLSearchParams();
  params.set('meta_web_form_id', '463086401');
  params.set('listname', listname);
  params.set('meta_adtracking', 'Sweepstakes_Step_2');
  params.set('meta_message', '1');
  params.set('email', entry.email);
  params.set('name',  entry.name);
  params.set('custom Street Address', entry.street);
  params.set('custom City',           entry.city);
  params.set('custom State',          entry.state);
  params.set('custom zip_code',       entry.zip);
  params.set('custom Phone Number',   entry.phone    || '');
  params.set('custom handicap_range', entry.handicap || '');
  params.set('custom ball_choice',    entry.ballChoice);
  params.set('tag_118699418', 'entry-complete');

  const resp = await fetch('https://www.aweber.com/scripts/addlead.pl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return resp.ok;
}
