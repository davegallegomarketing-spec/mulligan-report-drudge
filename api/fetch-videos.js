// /api/fetch-videos.js
// ═══════════════════════════════════════════════════════════════
// THE MULLIGAN REPORT — Video Feed Cache
//
// HOW IT WORKS:
// 1. Fetches YouTube RSS feeds for each channel (FREE — no quota)
// 2. Enriches with YouTube API for duration + views (~3 units total)
// 3. Filters out Shorts (< 90 seconds)
// 4. Returns sorted JSON for the Caddie Manager to consume
//
// RUNS: Once daily via Vercel Cron (vercel.json)
//       Also callable on-demand via GET
//
// FIXES (Nov 2025):
//   • Cache-Control changed to `no-store` so the Refresh button gets fresh data
//   • Added `?nocache=1` query param to force-bypass and clear KV
//   • Added `channelStatus` to response for at-a-glance channel health
//   • `?nocache=1` deletes tmr:video-cache before re-fetching
// ═══════════════════════════════════════════════════════════════

const { parseStringPromise } = require('xml2js');

// ── Aaron's Channels (23 total) ──
// RSS feeds require channel IDs (UC...), not handles (@name).
// If a channel ID is wrong, the feed returns 404 and gets skipped.
// Check the `channelStatus` field in the response to see which IDs are broken.
const CHANNELS = [
  // ── Original 6 (confirmed working) ──
  { name: 'Good Good',                 channelId: 'UCfi-mPMOmche6WI-jkvnGXw' },
  { name: 'Grant Horvat',              channelId: 'UCgUueMmSpcl-aCTt5CuCKQw' },
  { name: 'Bryan Bros',                channelId: 'UCdCxaD8rWfAj12rloIYS6jQ' },
  { name: 'Rick Shiels',               channelId: 'UCFHZHhZaH7Rc_FOMIzUziJA' },
  { name: 'Bryson DeChambeau',         channelId: 'UCCxF55adGXOscJ3L8qdKnrQ' },
  { name: 'Luke Kwon',                 channelId: 'UCJcc1x6emfrQquiV8Oe_pug' },

  // ── New 5 (from Aaron's PDF, page 7) ──
  { name: 'Phil Mickelson / HyFlyers', channelId: 'UC3jFoA7_6BTV90hsRSVHoaw' },
  { name: 'Ryan Ruffels',              channelId: 'UCmGSpvkyiQdFgW9BmymcXbw' },
  { name: 'The Lads',                  channelId: 'UCsazhBmAVDUL_WYcARQEFQA' },
  { name: 'Brad Dalke',                channelId: 'UCjchle1bmH0acutqK15_XSA' },
  { name: 'Good Good Pros',            channelId: 'UC2kHinOLqebNyh78zXpSCBg' },

  // ── High-volume channels ──
  { name: 'Bob Does Sports',           channelId: 'UCqr4sONkmFEOPc3rfoVLEvg' },
  { name: 'No Laying Up',              channelId: 'UCHr0bLJVR8RqMzEdIhwNJaw' },
  { name: 'Brodie Smith',              channelId: 'UCaHT88aobpcvRFEuy4t5Ezw' },
  { name: 'GM Golf',                   channelId: 'UCIh2wARyB4Gr1E3mTmKKIeg' },

  // ── Engagement boosters ──
  { name: 'PGA Tour',                  channelId: 'UCKwGZZMrh_sTmfNqVRqdKRg' },
  { name: 'Fore Play',                 channelId: 'UCwpbGAECmJOjact0arFTKxw' },
  { name: 'Peter Finch',               channelId: 'UCFoez1XjcSLKm8MvEzJJIxQ' },
  { name: 'Scratch Golf Academy',      channelId: 'UCgz5RwEa7GOUOI34pJfBJHA' },

  // ── Entertainment + instruction mix ──
  { name: 'Danny Maude',               channelId: 'UCSwdmDQhAi_-ICkAvNBLEBw' },
  { name: 'Golf Sidekick',             channelId: 'UCaeGjmOiTxekbGUDPKhoU-A' },
  { name: 'Not A Scratch Golfer',      channelId: 'UC3hrq3HFzlLv4z_Y_kQqmrw' },
  { name: 'Me and My Golf',            channelId: 'UCTwywdg9Sw5xs4wdN-qz7yw' },
];

const HOURS_FILTER = 336;  // 14 days

// ── CORS — FIX #1: no-store, so Vercel edge never serves stale ──
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

  // FIX #2: ?nocache=1 forces a fresh pull and clears KV
  const noCache = req.query && (req.query.nocache === '1' || req.query.nocache === 'true');

  try {
    const YT_KEY = process.env.YT_API_KEY || null;
    const cutoff = new Date(Date.now() - HOURS_FILTER * 60 * 60 * 1000);

    // If nocache requested, blow away the KV cache key before refetching
    if (noCache) {
      try {
        const { kv } = require('@vercel/kv');
        await kv.del('tmr:video-cache');
      } catch (_) {
        // KV not configured — no-op
      }
    }

    // ────────────────────────────────────────────
    // STEP 1: Fetch RSS feeds (FREE, no quota)
    // ────────────────────────────────────────────
    const results = await Promise.allSettled(
      CHANNELS.map(ch => fetchRSS(ch, cutoff))
    );

    let allVideos = [];
    const channelStatus = [];  // FIX #3: per-channel health report

    results.forEach((r, i) => {
      const ch = CHANNELS[i];
      if (r.status === 'fulfilled') {
        allVideos.push(...r.value);
        channelStatus.push({
          name: ch.name,
          channelId: ch.channelId,
          status: r.value.length > 0 ? 'OK' : 'EMPTY',
          videos: r.value.length,
        });
      } else {
        channelStatus.push({
          name: ch.name,
          channelId: ch.channelId,
          status: 'ERROR',
          error: r.reason?.message || 'Unknown error',
        });
      }
    });

    // Dedup
    const seen = new Set();
    allVideos = allVideos.filter(v => {
      if (seen.has(v.videoId)) return false;
      seen.add(v.videoId);
      return true;
    });

    // ────────────────────────────────────────────
    // STEP 2: Enrich (duration + views)
    // ────────────────────────────────────────────
    let enrichmentStatus = 'skipped';
    if (allVideos.length > 0 && YT_KEY) {
      enrichmentStatus = 'attempted';
      const enriched = await enrichVideos(allVideos.map(v => v.videoId), YT_KEY);
      const enrichedCount = Object.keys(enriched).length;

      if (enrichedCount > 0) {
        enrichmentStatus = `success (${enrichedCount}/${allVideos.length} videos)`;
        allVideos = allVideos.map(v => {
          const extra = enriched[v.videoId];
          return extra ? { ...v, ...extra } : v;
        });
        // Filter out Shorts
        allVideos = allVideos.filter(v => !v.durationSeconds || v.durationSeconds >= 90);
      }
    } else if (!YT_KEY) {
      enrichmentStatus = 'no_api_key';
    }

    // ────────────────────────────────────────────
    // STEP 3: Sort & return
    // ────────────────────────────────────────────
    allVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    // Quick summary so you can eyeball health at the top of the JSON
    const ok      = channelStatus.filter(c => c.status === 'OK').length;
    const empty   = channelStatus.filter(c => c.status === 'EMPTY').length;
    const broken  = channelStatus.filter(c => c.status === 'ERROR').length;

    const payload = {
      videos: allVideos,
      lastUpdated: new Date().toISOString(),
      videoCount: allVideos.length,
      enrichment: enrichmentStatus,
      cacheBypass: noCache,
      summary: { healthy: ok, empty, broken, total: CHANNELS.length },
      channelStatus,  // full per-channel breakdown — check this when videos go missing
    };

    // Persist to KV (24h TTL)
    try {
      const { kv } = require('@vercel/kv');
      await kv.set('tmr:video-cache', JSON.stringify(payload), { ex: 86400 });
    } catch (_) {
      // KV not set up — fine
    }

    return res.status(200).json(payload);

  } catch (err) {
    console.error('[TMR] Fatal:', err);
    return res.status(500).json({ error: err.message });
  }
};


// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

async function fetchRSS(channel, cutoff) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} (channel ID may be wrong)`);
  }

  const xml = await response.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });

  const entries = parsed?.feed?.entry;
  if (!entries) return [];

  const list = Array.isArray(entries) ? entries : [entries];

  return list
    .map(entry => ({
      videoId:         entry['yt:videoId'],
      title:           entry.title,
      channel:         channel.name,
      channelId:       channel.channelId,
      thumbnail:       `https://i.ytimg.com/vi/${entry['yt:videoId']}/hqdefault.jpg`,
      publishedAt:     entry.published,
      duration:        null,
      views:           null,
      durationSeconds: 0,
    }))
    .filter(v => v.videoId && new Date(v.publishedAt) >= cutoff);
}


async function enrichVideos(videoIds, apiKey) {
  const map = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${batch.join(',')}&key=${apiKey}`;

    try {
      const r = await fetch(url);
      const data = await r.json();
      if (data.error) {
        console.error('[TMR] API error:', JSON.stringify(data.error));
        break;
      }
      if (data.items) {
        data.items.forEach(item => {
          const d = parseDuration(item.contentDetails.duration);
          map[item.id] = {
            duration:        d.formatted,
            durationSeconds: d.seconds,
            views:           formatViews(parseInt(item.statistics?.viewCount || '0')),
          };
        });
      }
    } catch (err) {
      console.error(`[TMR] Enrichment batch ${i} failed:`, err.message);
    }
  }
  return map;
}


function parseDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return { formatted: '0:00', seconds: 0 };
  const h   = parseInt(m[1] || 0);
  const min = parseInt(m[2] || 0);
  const sec = parseInt(m[3] || 0);
  const total = h * 3600 + min * 60 + sec;
  const fmt = h > 0
    ? `${h}:${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${min}:${String(sec).padStart(2,'0')}`;
  return { formatted: fmt, seconds: total };
}


function formatViews(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return Math.round(n / 1_000) + 'K';
  return String(n);
}
