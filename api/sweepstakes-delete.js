// /api/sweepstakes-delete.js
//
// Admin endpoint to delete a single sweepstakes entry by email.
// Protected by SWEEPS_ADMIN_KEY — DO NOT make this public.
//
// Usage (GET, for easy browser testing):
//   /api/sweepstakes-delete?key=YOUR_SECRET&email=test@example.com
//   /api/sweepstakes-delete?key=YOUR_SECRET&email=test@example.com&quarter=Q1-2026
//
// Optional:
//   key      (required) — must match SWEEPS_ADMIN_KEY
//   email    (required) — the entry email to delete
//   quarter  (optional) — defaults to env var SWEEPS_QUARTER
//   confirm  (optional) — to delete ALL entries for a quarter, pass &all=1&confirm=YES
//
// Returns:
//   { ok: true, deleted: 1, key: "entry:Q1-2026:..." }
//   { ok: true, deleted: N, mode: "wipe-quarter" }
//   { ok: false, error: "..." }

export default async function handler(req, res) {
  // Auth
  const key = req.query.key || '';
  const expected = process.env.SWEEPS_ADMIN_KEY || '';
  if (!expected || key !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const quarter = (req.query.quarter || process.env.SWEEPS_QUARTER || 'Q1-2026').trim();

    // ─── Wipe-entire-quarter mode (dangerous, requires confirm=YES) ──
    if (req.query.all === '1') {
      if (req.query.confirm !== 'YES') {
        return res.status(400).json({
          ok: false,
          error: 'To wipe an entire quarter, pass &all=1&confirm=YES (case-sensitive).'
        });
      }
      const prefix = `entry:${quarter}:`;
      const keys = await kvKeys(prefix);
      if (!keys) {
        return res.status(500).json({ ok: false, error: 'KV unreachable' });
      }
      let deleted = 0;
      for (const k of keys) {
        const ok = await kvDel(k);
        if (ok) deleted++;
      }
      return res.status(200).json({ ok: true, mode: 'wipe-quarter', quarter, deleted });
    }

    // ─── Single-email delete ─────────────────────────────────────────
    const email = (req.query.email || '').toString().trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ ok: false, error: 'Missing email parameter' });
    }
    const kvKey = `entry:${quarter}:${email}`;
    const ok = await kvDel(kvKey);
    return res.status(200).json({
      ok: true,
      deleted: ok ? 1 : 0,
      key: kvKey,
    });

  } catch (err) {
    console.error('[sweepstakes-delete] error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

async function kvDel(key) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  try {
    const resp = await fetch(`${url}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) return false;
    const body = await resp.json();
    // KV returns { result: 1 } if deleted, { result: 0 } if didn't exist
    return body && body.result === 1;
  } catch (err) {
    console.error('[sweepstakes-delete] kvDel error:', err.message);
    return false;
  }
}

async function kvKeys(prefix) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const all = [];
    let cursor = 0;
    do {
      const resp = await fetch(
        `${url}/scan/${cursor}/match/${encodeURIComponent(prefix + '*')}/count/1000`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (!resp.ok) return null;
      const body = await resp.json();
      const result = body && body.result;
      if (!Array.isArray(result) || result.length < 2) break;
      cursor = parseInt(result[0], 10) || 0;
      all.push(...(result[1] || []));
    } while (cursor !== 0);
    return all;
  } catch (err) {
    console.error('[sweepstakes-delete] kvKeys error:', err.message);
    return null;
  }
}
