// /api/sweepstakes-entry.js
//
// Receives Step 2 sweepstakes form submissions and saves them to Vercel KV.
//
// Storage keys:
//   entry:<quarter>:<email>     — the actual entry data (one per email per quarter)
//   rate:<ip>:<minute>          — rate-limit counter (auto-expires after 60s)
//
// Env vars required:
//   KV_REST_API_URL          (auto from Vercel KV)
//   KV_REST_API_TOKEN        (auto from Vercel KV)
//   SWEEPS_QUARTER           (e.g. "Q1-2026")
//   AWEBER_FORM_LISTNAME     (e.g. "awlist6949115")

const RATE_LIMIT_PER_MINUTE = 5;   // max submissions per IP per minute
const ALLOWED_ORIGIN = 'https://themulliganreport.com';

export default async function handler(req, res) {
  // ─── CORS ────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // ─── Bot check #1: Referer must be our domain ───────────────────
    const referer = (req.headers.referer || req.headers.referrer || '').toLowerCase();
    const allowedReferer = referer.startsWith('https://themulliganreport.com')
                        || referer.startsWith('https://www.themulliganreport.com');
    if (!allowedReferer) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    // ─── Parse body ─────────────────────────────────────────────────
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = parseFormEncoded(body); }
    }
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'Invalid form data' });
    }

    // ─── Bot check #2: Honeypot field ───────────────────────────────
    // The form includes a hidden "website" field. Real users never fill it
    // because they can't see it. Bots that auto-fill all fields will.
    if (body.website && String(body.website).trim() !== '') {
      // Silent reject — don't tell the bot why
      return res.status(200).json({ ok: true });
    }

    // ─── Bot check #3: Per-IP rate limit ────────────────────────────
    const ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '')
                 .toString().split(',')[0].trim() || 'unknown';
    const minute = Math.floor(Date.now() / 60000);
    const rateKey = `rate:${ip}:${minute}`;
    const rateCount = await kvIncr(rateKey, 60);  // 60s TTL
    if (rateCount !== null && rateCount > RATE_LIMIT_PER_MINUTE) {
      return res.status(429).json({ ok: false, error: 'Too many submissions. Please wait a minute and try again.' });
    }

    // ─── Field extraction ───────────────────────────────────────────
    const email      = clean(body.email).toLowerCase();
    const name       = clean(body.name);
    const street     = clean(body.street || body['custom Street Address']);
    const city       = clean(body.city || body['custom City']);
    const state      = clean(body.state || body['custom State']).toUpperCase();
    const zip        = clean(body.zip || body['custom zip_code']);
    const ballChoice = clean(body.ballChoice || body['custom ball_choice']);
    const phone      = clean(body.phone || body['custom Phone Number']);
    const handicap   = clean(body.handicap || body['custom handicap_range']);

    // ─── Required-field validation ──────────────────────────────────
    const missing = [];
    if (!email)      missing.push('email');
    if (!name)       missing.push('name');
    if (!street)     missing.push('street');
    if (!city)       missing.push('city');
    if (!state)      missing.push('state');
    if (!zip)        missing.push('zip');
    if (!ballChoice) missing.push('ballChoice');
    if (missing.length) {
      return res.status(400).json({ ok: false, error: 'Missing required field(s)', missing });
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

    // ─── Build entry record ─────────────────────────────────────────
    const quarter = process.env.SWEEPS_QUARTER || 'Q1-2026';
    const entry = {
      email, name, street, city, state, zip,
      phone:    phone    || null,
      handicap: handicap || null,
      ballChoice,
      quarter,
      submittedAt: new Date().toISOString(),
      ip,
      userAgent:  req.headers['user-agent'] || null,
      referer,
    };

    // ─── Save to KV ─────────────────────────────────────────────────
    const kvKey = `entry:${quarter}:${email}`;
    const kvOk  = await kvSet(kvKey, entry);
    if (!kvOk) {
      console.error('[sweepstakes] KV write failed for', kvKey);
      return res.status(500).json({ ok: false, error: 'Could not save your entry. Please try again.' });
    }

    // ─── Fire confirmation email + best-effort AWeber update ────────
    // Both fire-and-forget — we don't block the user response on them.
    sendConfirmationEmail(entry).catch(err => {
      console.error('[sweepstakes] confirmation email failed:', err.message);
    });
    awebernSubmit(entry).catch(err => {
      console.error('[sweepstakes] AWeber best-effort submit failed:', err.message);
    });

    return res.status(200).json({ ok: true, quarter, saved: true });

  } catch (err) {
    console.error('[sweepstakes] handler error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function clean(v) {
  if (v == null) return '';
  return String(v).trim().slice(0, 500);
}

function isLikelyEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function parseFormEncoded(s) {
  const out = {};
  s.split('&').forEach(pair => {
    if (!pair) return;
    const [k, v = ''] = pair.split('=');
    out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
  });
  return out;
}

// KV: SET (with optional TTL in seconds)
async function kvSet(key, value, ttlSeconds) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.error('[sweepstakes] KV env vars not configured');
    return false;
  }
  try {
    let endpoint = `${url}/set/${encodeURIComponent(key)}`;
    if (ttlSeconds) endpoint += `?EX=${ttlSeconds}`;
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(value),
    });
    return resp.ok;
  } catch (err) {
    console.error('[sweepstakes] kvSet error:', err.message);
    return false;
  }
}

// KV: INCR with TTL (returns new value, or null on failure)
async function kvIncr(key, ttlSeconds) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    // INCR first
    const incrResp = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!incrResp.ok) return null;
    const incrBody = await incrResp.json();
    const count = (incrBody && typeof incrBody.result === 'number') ? incrBody.result : null;
    // On the first increment (count === 1), set TTL so the key auto-expires
    if (count === 1 && ttlSeconds) {
      await fetch(`${url}/expire/${encodeURIComponent(key)}/${ttlSeconds}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      }).catch(() => {});
    }
    return count;
  } catch (err) {
    console.error('[sweepstakes] kvIncr error:', err.message);
    return null;
  }
}

// Best-effort AWeber submit (kept from v1 — still nice if AWeber accepts it)
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

// Send confirmation email via AWeber's submit-and-redirect endpoint.
// AWeber doesn't have a true transactional email API on the free tier,
// so we trigger it indirectly: a small "confirmation tag" tag application
// can be configured in AWeber to fire a follow-up message.
//
// What this function actually does: it posts a re-submission to the Step 2
// form with a special "entry-confirmed-email" tag. If you set up an AWeber
// automation rule that says "when tag entry-confirmed-email is added, send
// confirmation broadcast X", the user gets the email.
//
// If you don't set up that automation, this function is harmless (just adds
// a tag the user won't notice). It does NOT block the entry.
async function sendConfirmationEmail(entry) {
  const listname = process.env.AWEBER_FORM_LISTNAME || 'awlist6949115';
  const params = new URLSearchParams();
  params.set('meta_web_form_id', '463086401');
  params.set('listname', listname);
  params.set('meta_adtracking', 'Sweepstakes_Confirmation_Trigger');
  params.set('meta_message', '1');
  params.set('email', entry.email);
  // Send the user's choice details so the confirmation email can reference them
  params.set('name',  entry.name);
  params.set('custom ball_choice', entry.ballChoice);
  // A separate tag that an AWeber automation can listen to
  // (Ajid needs to configure this automation in AWeber)
  params.set('tag_118699418', 'sweepstakes-confirmation-trigger');

  await fetch('https://www.aweber.com/scripts/addlead.pl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}
