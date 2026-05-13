// /api/fetch-videos.js
// ═══════════════════════════════════════════════════════════════
// THE MULLIGAN REPORT — Video Feed Cache (YouTube Data API edition)
//
// HOW IT WORKS:
// 1. For each channel, calls playlistItems.list on the channel's
//    uploads playlist (UU + channelId minus the leading UC).
//    This returns the most recent uploads. Costs 1 quota unit each.
// 2. Enriches with videos.list for duration + views (1 unit per 50 videos).
// 3. Filters out Shorts (< 90 seconds).
// 4. Returns sorted JSON for the Caddie Manager to consume.
//
// QUOTA MATH (free tier = 10,000 units/day):
//   23 channels × 1 unit (playlistItems)  = 23
//   1–2 batches × 1 unit (videos.list)    = ~2
//   TOTAL per run                         = ~25 units
//
// RUNS: Once daily via Vercel Cron (vercel.json)
//       Also callable on-demand via GET
//
// WHY NOT RSS:
//   YouTube started 404-ing the youtube.com/feeds/videos.xml endpoint
//   for requests originating from Vercel/AWS serverless IPs, even with
//   a Googlebot User-Agent. The Data API works from anywhere as long as
//   the YT_API_KEY is valid.
//
// ENV VARS REQUIRED:
//   YT_API_KEY  — YouTube Data API v3 key (Google Cloud Console)
//   KV_*        — Optional. Used for caching the response.
// ═══════════════════════════════════════════════════════════════

// ── Aaron's Channels (23 total) ──
// channelId starts with "UC". The uploads playlist is "UU" + the rest.
const CHANNELS = [
  // ── Original 6 ──
  { name: 'Good Good',                 channelId: 'UCfi-mPMOmche6WI-jkvnGXw' },
  { name: 'Grant Horvat',              channelId: 'UCgUueMmSpcl-aCTt5CuCKQw' },
  { name: 'Bryan Bros',                channelId: 'UCdCxaD8rWfAj12rloIYS6jQ' },
  { name: 'Rick Shiels',               channelId: 'UCFHZHhZaH7Rc_FOMIzUziJA' },
  { name: 'Bryson DeChambeau',         channelId: 'UCCxF55adGXOscJ3L8qdKnrQ' },
  { name: 'Luke Kwon',                 channelId: 'UCJcc1x6emfrQquiV8Oe_pug' },

  // ── New 5 ──
  { name: 'Phil Mickelson / HyFlyers', channelId: 'UC3jFoA7_6BTV90hsRSVHoaw' },
  { name: 'Ryan Ruffels',              channelId: 'UCmGSpvkyiQdFgW9BmymcXbw' },
  { name: 'The Lads',                  channelId: 'UCsazhBmAVDUL_WYcARQEFQA' },
  { name: 'Brad Dalke',                channelId: 'UCjchle1bmH0acutqK15_XSA' },
  { name: 'Good Good Pros',            channelId: 'UC2kHinOLqebNyh78zXpSCBg' },

  // ── High-volume channels ──
  { name: 'Bob Does Sports',           channelId: 'UCqr4sONkmFEOPc3rfoVLEvg' },
  { name: 'No Laying Up',              channelId: 'UCZn1UAWT9W0pLTWCdt8CTBg' },  // corrected May 2026
  { name: 'Brodie Smith',              channelId: 'UCkfXWo-UfGoJWHnD1jRrGpg' },  // corrected May 2026 (golf channel, not disc golf)
  { name: 'GM Golf',                   channelId: 'UClljAz6ZKy0XeViKsohdjqA' },  // corrected May 2026

  // ── Engagement boosters ──
  { name: 'PGA Tour',                  channelId: 'UCKwGZZMrhNYKzucCtTPY2Nw' },  // corrected May 2026
  { name: 'Fore Play',                 channelId: 'UCw3LGiL_bYbWrgpQ7w7QZrw' },  // corrected May 2026
  { name: 'Peter Finch',               channelId: 'UCFoez1Xjc90CsHvCzqKnLcw' },  // corrected May 2026
  { name: 'Scratch Golf Academy',      channelId: 'UC79FyJ_choPudvaY5Tx_TvA' },  // corrected May 2026

  // ── Entertainment + instruction mix ──
  { name: 'Danny Maude',               channelId: 'UCSwdmDQhAi_-ICkAvNBLEBw' },
  { name: 'Golf Sidekick',             channelId: 'UCaeGjmOiTxekbGUDPKhoU-A' },
  { name: 'Not A Scratch Golfer',      channelId: 'UC3hrq3HFzlLv4z_Y_kQqmrw' },
  { name: 'Me and My Golf',            channelId: 'UCTwywdg9Sw5xs4wdN-qz7yw' },
];

const HOURS_FILTER = 336;           // 14 days
const MAX_PER_CHANNEL = 10;         // max recent uploads to pull per channel

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

    if (!YT_KEY) {
      // Same error shape as before so the Manager UI doesn't break
      return res.status(200).json({
        videos: [],
        lastUpdated: new Date().toISOString(),
        videoCount: 0,
        enrichment: 'no_api_key',
        cacheBypass: noCache,
        summary: { healthy: 0, empty: 0, broken: 0, total: CHANNELS.length },
        channelStatus: CHANNELS.map(ch => ({
          name: ch.name,
          channelId: ch.channelId,
          status: 'ERROR',
          error: 'YT_API_KEY env var is not set on this deployment',
        })),
      });
    }

    const cutoff = new Date(Date.now() - HOURS_FILTER * 60 * 60 * 1000);

    if (noCache) {
      try {
        const { kv } = require('@vercel/kv');
        await kv.del('tmr:video-cache');
      } catch (_) {
        // KV not configured — fine
      }
    }

    // ────────────────────────────────────────────
    // STEP 1: Pull recent uploads via playlistItems.list
    // ────────────────────────────────────────────
    const results = await Promise.allSettled(
      CHANNELS.map(ch => fetchChannelUploads(ch, YT_KEY, cutoff))
    );

    let allVideos = [];
    const channelStatus = [];

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

    // Dedup (a video could in theory appear in two playlists if a channel re-uploads)
    const seen = new Set();
    allVideos = allVideos.filter(v => {
      if (seen.has(v.videoId)) return false;
      seen.add(v.videoId);
      return true;
    });

    // ────────────────────────────────────────────
    // STEP 2: Enrich with duration + views
    // ────────────────────────────────────────────
    let enrichmentStatus = 'skipped';
    if (allVideos.length > 0) {
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
    }

    // ────────────────────────────────────────────
    // STEP 3: Sort & return
    // ────────────────────────────────────────────
    allVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

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
      channelStatus,
    };

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

// For any standard YouTube channel, the uploads playlist ID is just
// the channel ID with "UC" swapped for "UU". This saves a channels.list
// call (1 quota unit per channel) and works for every channel in our list.
function uploadsPlaylistId(channelId) {
  if (!channelId || !channelId.startsWith('UC')) {
    throw new Error(`Invalid channel ID format: ${channelId}`);
  }
  return 'UU' + channelId.slice(2);
}

async function fetchChannelUploads(channel, apiKey, cutoff) {
  const playlistId = uploadsPlaylistId(channel.channelId);
  const url = `https://www.googleapis.com/youtube/v3/playlistItems` +
    `?part=snippet&playlistId=${playlistId}&maxResults=${MAX_PER_CHANNEL}&key=${apiKey}`;

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

  return items
    .map(item => {
      const s = item.snippet || {};
      const videoId = s.resourceId?.videoId;
      const thumb =
        s.thumbnails?.maxres?.url ||
        s.thumbnails?.standard?.url ||
        s.thumbnails?.high?.url ||
        (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null);

      return {
        videoId,
        title:           s.title,
        channel:         channel.name,
        channelId:       channel.channelId,
        thumbnail:       thumb,
        publishedAt:     s.publishedAt,
        duration:        null,
        views:           null,
        durationSeconds: 0,
      };
    })
    .filter(v => v.videoId && v.publishedAt && new Date(v.publishedAt) >= cutoff);
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
