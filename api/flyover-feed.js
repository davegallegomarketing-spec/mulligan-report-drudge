// /api/flyover-feed.js
// ═══════════════════════════════════════════════════════════════
// THE MULLIGAN REPORT — Course Flyover Feed (YouTube Data API)
//
// HOW IT WORKS:
// 1. Calls playlistItems.list on ONE hand-curated YouTube playlist
//    ("TMR Course Flyovers"). Pages through pageToken so ALL videos
//    are returned, not just the first 50. Costs 1 quota unit per page.
// 2. Returns clean JSON for course-flyover.html to render.
// 3. Optionally caches the payload in Vercel KV for speed.
//
// WHY A PLAYLIST:
//   "Only flyover videos get added" is guaranteed by curation — a
//   video only appears here if it was added to the playlist by hand.
//   Nothing automatic can put non-flyover content on the page.
//
// QUOTA MATH (free tier = 10,000 units/day):
//   1 playlist page (up to 50 videos) = 1 unit
//   A 200-video playlist              = 4 units per full read
//   With KV caching it reads a handful of times a day  → near zero.
//
// ENV VARS REQUIRED:
//   YT_API_KEY  — YouTube Data API v3 key (same key as fetch-videos.js)
//   KV_*        — Optional. Used for caching the response.
// ═══════════════════════════════════════════════════════════════

// ── The one curated playlist that feeds the Course Flyover page ──
const PLAYLIST_ID = 'PLDMi_eMJgjU1lgyJ2_wPyll19WA3XQU1V';

const MAX_PAGES   = 10;          // safety cap: 10 pages = up to 500 videos
const CACHE_KEY   = 'tmr:flyover-feed-cache';
const CACHE_TTL   = 1800;        // seconds the cached payload stays fresh (30 min)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).end();
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const noCache = req.query && (req.query.nocache === '1' || req.query.nocache === 'true');

  try {
    const YT_KEY = process.env.YT_API_KEY || null;

    // ── No key: return an empty-but-valid payload (page won't break) ──
    if (!YT_KEY) {
      return res.status(200).json({
        flyovers: [],
        lastUpdated: new Date().toISOString(),
        count: 0,
        source: 'no_api_key',
        error: 'YT_API_KEY env var is not set on this deployment',
      });
    }

    // ── Try the cache first (unless ?nocache=1) ──
    if (!noCache) {
      try {
        const { kv } = require('@vercel/kv');
        const cached = await kv.get(CACHE_KEY);
        if (cached) {
          const payload = typeof cached === 'string' ? JSON.parse(cached) : cached;
          payload.source = 'cache';
          return res.status(200).json(payload);
        }
      } catch (_) {
        // KV not configured — fine, fall through to a live fetch
      }
    } else {
      try {
        const { kv } = require('@vercel/kv');
        await kv.del(CACHE_KEY);
      } catch (_) {}
    }

    // ── Live fetch: page through the whole playlist ──
    const flyovers = await fetchPlaylist(PLAYLIST_ID, YT_KEY);

    const payload = {
      flyovers,
      lastUpdated: new Date().toISOString(),
      count: flyovers.length,
      source: 'live',
    };

    // ── Save to cache for the next visitors ──
    try {
      const { kv } = require('@vercel/kv');
      await kv.set(CACHE_KEY, JSON.stringify(payload), { ex: CACHE_TTL });
    } catch (_) {
      // KV not set up — fine
    }

    return res.status(200).json(payload);

  } catch (err) {
    console.error('[TMR Flyover] Fatal:', err);
    return res.status(500).json({ error: err.message });
  }
};


// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

// Pulls every video in a playlist, following pageToken across pages.
async function fetchPlaylist(playlistId, apiKey) {
  let videos = [];
  let pageToken = '';
  let pages = 0;

  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems` +
      `?part=snippet,status&playlistId=${playlistId}` +
      `&maxResults=50&key=${apiKey}` +
      (pageToken ? `&pageToken=${pageToken}` : '');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const errBody = await response.json();
        if (errBody?.error?.message) detail += ` — ${errBody.error.message}`;
      } catch (_) {}
      throw new Error(detail);
    }

    const data = await response.json();
    const items = data.items || [];

    items.forEach(item => {
      const s = item.snippet || {};
      const videoId = s.resourceId?.videoId;
      if (!videoId) return;

      // Skip videos that are private/deleted — they can't be watched
      const privacy = item.status?.privacyStatus;
      if (privacy === 'private' || privacy === 'privacyStatusUnspecified') return;
      if (s.title === 'Deleted video' || s.title === 'Private video') return;

      const thumb =
        s.thumbnails?.maxres?.url ||
        s.thumbnails?.standard?.url ||
        s.thumbnails?.high?.url ||
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      videos.push({
        videoId,
        title:       s.title || 'Course Flyover',
        // The course name + location can be typed into the YouTube
        // video's own title, or overridden later. For now we expose
        // the raw title and let the page format it.
        thumbnail:   thumb,
        publishedAt: s.publishedAt || null,
        position:    s.position ?? null,
      });
    });

    pageToken = data.nextPageToken || '';
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  // ──────────────────────────────────────────────────────────
  // EMBEDDABILITY FILTER
  // Some uploaders disable embedding on their videos. Those videos
  // can't play on this page (YouTube blocks the embed). Strip them
  // out here so the user only ever sees flyovers that will actually
  // play — no fallback panel, no broken experience.
  // ──────────────────────────────────────────────────────────
  if (videos.length > 0) {
    try {
      const embeddable = await checkEmbeddable(videos.map(v => v.videoId), apiKey);
      videos = videos.filter(v => embeddable[v.videoId] !== false);
    } catch (err) {
      console.error('[TMR Flyover] Embeddable check failed:', err.message);
      // If the check fails, keep all videos rather than ship an empty page.
    }
  }

  // Playlist order (the order you arranged them in YouTube) is kept
  // by sorting on position. Lower position = higher on the page.
  videos.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  return videos;
}

// Calls videos.list with part=status on up to 50 IDs per request
// and returns a map of { videoId: boolean }. true = embeddable.
async function checkEmbeddable(videoIds, apiKey) {
  const map = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = `https://www.googleapis.com/youtube/v3/videos` +
      `?part=status&id=${batch.join(',')}&key=${apiKey}`;

    const r = await fetch(url);
    const data = await r.json();
    if (data.error) {
      console.error('[TMR Flyover] Embeddable API error:', data.error.message);
      continue;
    }
    (data.items || []).forEach(item => {
      // YouTube returns status.embeddable as true/false.
      // Also drop videos that aren't publicly viewable.
      const status = item.status || {};
      const ok = status.embeddable === true && status.privacyStatus !== 'private';
      map[item.id] = ok;
    });
  }
  return map;
}
