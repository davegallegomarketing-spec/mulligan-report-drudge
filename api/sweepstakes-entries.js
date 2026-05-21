// /api/sweepstakes-entries.js
//
// Admin endpoint to list all sweepstakes entries for a quarter.
// Protected by a secret key — DO NOT make this public.
//
// Usage:
//   GET /api/sweepstakes-entries?key=YOUR_SECRET&quarter=Q1-2026
//
// Optional query params:
//   key      (required) — must match env var SWEEPS_ADMIN_KEY
//   quarter  (optional) — defaults to env var SWEEPS_QUARTER
//   format   (optional) — "json" (default) or "csv"
//   draw     (optional) — if "1", picks one random entry instead of listing all
//
// Env vars:
//   KV_REST_API_URL
//   KV_REST_API_TOKEN
//   SWEEPS_ADMIN_KEY     — set this to a long random string in Vercel dashboard
//   SWEEPS_QUARTER       — defaults the quarter filter

export default async function handler(req, res) {
  // ─── Auth ───────────────────────────────────────────────────────
  const key = req.query.key || '';
  const expected = process.env.SWEEPS_ADMIN_KEY || '';
  if (!expected || key !== expected) {
    // Generic message — don't leak whether the key var is set
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const quarter = (req.query.quarter || process.env.SWEEPS_QUARTER || 'Q1-2026').trim();
    const prefix  = `entry:${quarter}:`;

    // ─── List all keys with the prefix ──────────────────────────
    const keys = await kvKeys(prefix);
    if (!keys) {
      return res.status(500).json({ ok: false, error: 'KV unreachable' });
    }

    // ─── Fetch each entry ───────────────────────────────────────
    const entries = [];
    for (const k of keys) {
      const v = await kvGet(k);
      if (v) entries.push(v);
    }

    // ─── Optional: random draw ──────────────────────────────────
    if (req.query.draw === '1') {
      if (entries.length === 0) {
        return res.status(200).json({ ok: true, quarter, winner: null, totalEntries: 0 });
      }
      const winner = entries[Math.floor(Math.random() * entries.length)];
      return res.status(200).json({
        ok: true,
        quarter,
        totalEntries: entries.length,
        winner,
      });
    }

    // ─── Optional: CSV format ───────────────────────────────────
    if (req.query.format === 'csv') {
      const csv = toCsv(entries);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="sweepstakes-${quarter}.csv"`);
      return res.status(200).send(csv);
    }

    // ─── Default: JSON list ─────────────────────────────────────
    return res.status(200).json({
      ok: true,
      quarter,
      totalEntries: entries.length,
      entries,
    });

  } catch (err) {
    console.error('[sweepstakes-entries] error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

async function kvKeys(prefix) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    // KV's "scan" command returns paginated keys. We loop until done.
    const all = [];
    let cursor = 0;
    do {
      const resp = await fetch(`${url}/scan/${cursor}/match/${encodeURIComponent(prefix + '*')}/count/1000`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!resp.ok) return null;
      const body = await resp.json();
      // KV scan returns: { result: [ "newCursor", [key1, key2, ...] ] }
      const result = body && body.result;
      if (!Array.isArray(result) || result.length < 2) break;
      cursor = parseInt(result[0], 10) || 0;
      const batch = result[1] || [];
      all.push(...batch);
    } while (cursor !== 0);
    return all;
  } catch (err) {
    console.error('[sweepstakes-entries] kvKeys error:', err.message);
    return null;
  }
}

async function kvGet(key) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    return body && body.result ? body.result : null;
  } catch (err) {
    return null;
  }
}

function toCsv(entries) {
  if (!entries.length) return '';
  const cols = ['submittedAt', 'email', 'name', 'street', 'city', 'state', 'zip', 'phone', 'handicap', 'ballChoice'];
  const escape = v => {
    const s = v == null ? '' : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const header = cols.join(',');
  const rows = entries.map(e => cols.map(c => escape(e[c])).join(','));
  return [header, ...rows].join('\n');
}
