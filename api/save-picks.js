// /api/save-picks.js
// ═══════════════════════════════════════════════════════════════
// THE MULLIGAN REPORT — Caddie's Picks Storage
//
// POST  →  Aaron hits "Publish to TMR" in the Caddie Manager
// GET   →  Returns current picks (for homepage) + full archive
//
// Storage: Upstash Redis via REST API (persistent)
//          Falls back to in-memory if Redis unavailable
//
// Two Redis keys:
//   tmr:caddie-picks   → today's active picks (powers Clubhouse TV)
//   tmr:caddie-archive → all picks ever published (powers archives)
//
// Special query params:
//   ?action=reset       → Wipes both picks and archive (clean slate)
//   ?mode=archive       → Returns the full archive
//
// Caddie's Take:
//   Manual only. Aaron writes the quote in the Caddie Manager UI
//   on the featured pick. Stored in the `comment` field. No AI.
// ═══════════════════════════════════════════════════════════════

let memoryStore = null;
let memoryArchive = null;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const KEY_PICKS   = 'tmr:caddie-picks';
const KEY_ARCHIVE = 'tmr:caddie-archive';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).end();
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  // ── GET: Serve picks to the live site ──
  // ?action=reset  → wipe everything (picks + archive)
  // ?mode=archive  → returns the full archive
  // Default        → returns current picks (for homepage Clubhouse TV)
  if (req.method === 'GET') {
    try {
      const action = req.query && req.query.action;
      const mode = req.query && req.query.mode;

      // ── RESET: Wipe both picks and archive ──
      if (action === 'reset') {
        const secret = req.query && req.query.key;
        const RESET_KEY = process.env.TMR_RESET_KEY || 'tmr2026caddie';
        if (secret !== RESET_KEY) {
          return res.status(403).json({ error: 'Invalid reset key' });
        }
        const emptyPicks = { picks: [], lastPublished: null };
        const emptyArchive = { videos: [], totalPublished: 0, lastUpdated: null };
        const r1 = await saveKey(KEY_PICKS, emptyPicks, 'memoryStore');
        const r2 = await saveKey(KEY_ARCHIVE, emptyArchive, 'memoryArchive');
        return res.status(200).json({
          success: true,
          message: 'All picks and archive cleared',
          picks: r1.source,
          archive: r2.source,
        });
      }

      if (mode === 'archive') {
        const result = await loadKey(KEY_ARCHIVE, memoryArchive);
        const archive = result.data || { videos: [], totalPublished: 0 };
        archive._storage = result.source;
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(archive);
      }

      // Default: current picks for homepage
      const result = await loadKey(KEY_PICKS, memoryStore);
      if (!result.data) {
        return res.status(200).json({ picks: [], lastPublished: null, _storage: result.source });
      }
      const out = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
      out._storage = result.source;
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(out);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to load picks', detail: err.message });
    }
  }

  // ── POST: Aaron publishes from Caddie Manager ──
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      if (!body.picks || !Array.isArray(body.picks) || body.picks.length === 0) {
        return res.status(400).json({ error: 'Missing or empty "picks" array' });
      }
      if (body.picks.length > 9) {
        return res.status(400).json({ error: 'Maximum 9 picks (1 featured + 8 grid)' });
      }

      // Sanitize each pick
      const clean = body.picks.map(p => ({
        videoId:   String(p.videoId || p.id || '').slice(0, 20),
        title:     String(p.title || '').slice(0, 200),
        channel:   String(p.channel || '').slice(0, 100),
        thumbnail: String(p.thumbnail || '').slice(0, 500),
        duration:  String(p.duration || '').slice(0, 20),
        views:     String(p.views || '').slice(0, 20),
        featured:  Boolean(p.featured),
        timestamp: p.timestamp ? parseInt(p.timestamp) || null : null,
        comment:   String(p.comment || '').slice(0, 500),
      }));

      if (!clean.some(p => p.featured)) clean[0].featured = true;

      // ── Caddie's Take is manual only — entered in the Caddie Manager UI ──
      // Featured pick's `comment` field is what shows on the home page.
      // No AI generation. If empty, no quote renders.

      const now = new Date().toISOString();

      // ── 1. Save current picks (replaces previous — powers homepage) ──
      const payload = {
        picks: clean,
        lastPublished: now,
      };
      const saveResult = await saveKey(KEY_PICKS, payload, 'memoryStore');

      // ── 2. Append to archive (accumulates — powers archives page) ──
      let archiveResult = { source: 'skipped' };
      try {
        const existing = await loadKey(KEY_ARCHIVE, memoryArchive);
        const archive = existing.data || { videos: [], totalPublished: 0 };

        // Build a set of existing video IDs to avoid duplicates
        const existingIds = new Set(archive.videos.map(v => v.videoId));

        // Add new picks that aren't already in the archive
        let added = 0;
        clean.forEach(pick => {
          if (!existingIds.has(pick.videoId)) {
            archive.videos.unshift({
              ...pick,
              publishedToTMR: now,
            });
            added++;
          }
        });

        archive.totalPublished = archive.videos.length;
        archive.lastUpdated = now;

        archiveResult = await saveKey(KEY_ARCHIVE, archive, 'memoryArchive');
        archiveResult.added = added;
        archiveResult.total = archive.totalPublished;
      } catch (archErr) {
        archiveResult = { source: 'error', error: archErr.message };
      }

      return res.status(200).json({
        success: true,
        message: `Published ${clean.length} videos to TMR`,
        lastPublished: now,
        storage: saveResult.source,
        archive: archiveResult,
      });

    } catch (err) {
      return res.status(500).json({ error: 'Save failed: ' + err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};


// ═══════════════════════════════════════════════════════════════
// STORAGE — Direct Upstash REST API (no npm package needed)
// ═══════════════════════════════════════════════════════════════

function getRedisConfig() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

async function redisRequest(command, args) {
  const config = getRedisConfig();
  if (!config) return null;

  const resp = await fetch(config.url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });

  if (!resp.ok) {
    throw new Error('Redis HTTP ' + resp.status + ': ' + (await resp.text()));
  }

  const json = await resp.json();
  return json.result;
}

async function loadKey(key, memFallback) {
  try {
    const config = getRedisConfig();
    if (config) {
      const data = await redisRequest('GET', [key]);
      if (data) {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        return { data: parsed, source: 'redis' };
      }
      return { data: null, source: 'redis-empty' };
    }
  } catch (err) {
    console.error('Redis load error (' + key + '):', err.message);
  }
  return { data: memFallback, source: memFallback ? 'memory' : 'memory-empty' };
}

async function saveKey(key, payload, memName) {
  const jsonStr = JSON.stringify(payload);
  try {
    const config = getRedisConfig();
    if (config) {
      await redisRequest('SET', [key, jsonStr]);
      // Keep memory in sync
      if (memName === 'memoryStore') memoryStore = payload;
      if (memName === 'memoryArchive') memoryArchive = payload;
      return { source: 'redis' };
    }
  } catch (err) {
    console.error('Redis save error (' + key + '):', err.message);
    if (memName === 'memoryStore') memoryStore = payload;
    if (memName === 'memoryArchive') memoryArchive = payload;
    return { source: 'memory', error: err.message };
  }
  if (memName === 'memoryStore') memoryStore = payload;
  if (memName === 'memoryArchive') memoryArchive = payload;
  return { source: 'memory', error: 'No Redis config' };
}
