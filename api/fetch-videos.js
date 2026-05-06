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
// QUOTA IMPACT: ~3 units per run vs 600+ with Search API
// ═══════════════════════════════════════════════════════════════

const { parseStringPromise } = require('xml2js');

// ── Aaron's Channels (23 total) ──
// RSS feeds require channel IDs (UC...), not handles (@name).
// If a channel ID is wrong, the feed returns 404 and gets skipped.
// To find a channel ID: youtube.com/@handle → View Source → search "channelId"
//
// ⚠️  REPLACE the PLACEHOLDER_* values below with real UC... IDs!
//     View Source method: youtube.com/@handle → Right-click → View Page Source
//     → Ctrl+F "channelId" → copy the UC... value
const CHANNELS = [
  // ── Original 6 (confirmed working) ──
  { name: 'Good Good',           channelId: 'UCfi-mPMOmche6WI-jkvnGXw' },
  { name: 'Grant Horvat',        channelId: 'UCgUueMmSpcl-aCTt5CuCKQw' },
  { name: 'Bryan Bros',          channelId: 'UCdCxaD8rWfAj12rloIYS6jQ' },
  { name: 'Rick Shiels',         channelId: 'UCFHZHhZaH7Rc_FOMIzUziJA' },
  { name: 'Bryson DeChambeau',   channelId: 'UCCxF55adGXOscJ3L8qdKnrQ' },
  { name: 'Luke Kwon',           channelId: 'UCJcc1x6emfrQquiV8Oe_pug' },

  // ── New 5 (from Aaron's PDF, page 7) ──
  { name: 'Phil Mickelson / HyFlyers', channelId: 'UC3jFoA7_6BTV90hsRSVHoaw' },     // youtube.com/@HyFlyersGC
  { name: 'Ryan Ruffels',              channelId: 'UCmGSpvkyiQdFgW9BmymcXbw' },     // youtube.com/@RyanRuffelsGolf
  { name: 'The Lads',                  channelId: 'UCsazhBmAVDUL_WYcARQEFQA' },     // youtube.com/@TheLadsGolf
  { name: 'Brad Dalke',                channelId: 'UCjchle1bmH0acutqK15_XSA' },     // youtube.com/@braddalkegolf
  { name: 'Good Good Pros',            channelId: 'UC2kHinOLqebNyh78zXpSCBg' },     // youtube.com/@GoodGoodpros

  // ── High-volume channels (post 2-4x/week, ensures fresh content daily) ──
  // Bob Does Sports ID confirmed. Other 3 may need View Source verification.
  // If any show 0 videos, go to youtube.com/@handle → View Source → Ctrl+F "channelId"
  { name: 'Bob Does Sports',           channelId: 'UCqr4sONkmFEOPc3rfoVLEvg' },     // youtube.com/@bobdoessports — CONFIRMED
  { name: 'No Laying Up',              channelId: 'UCHr0bLJVR8RqMzEdIhwNJaw' },     // youtube.com/@NoLayingUp — VERIFY IF 0 VIDEOS
  { name: 'Brodie Smith',              channelId: 'UCaHT88aobpcvRFEuy4t5Ezw' },     // youtube.com/@BrodieSmithGolf — VERIFY IF 0 VIDEOS
  { name: 'GM Golf',                   channelId: 'UCIh2wARyB4Gr1E3mTmKKIeg' },     // youtube.com/@GMGolf — VERIFY IF 0 VIDEOS

  // ── Engagement boosters (post 2-5x/week, massive audiences) ──
  { name: 'PGA Tour',                  channelId: 'UCKwGZZMrh_sTmfNqVRqdKRg' },     // youtube.com/@PGATOUR
  { name: 'Fore Play',                 channelId: 'UCwpbGAECmJOjact0arFTKxw' },     // youtube.com/@ForePlayPod — VERIFY IF 0 VIDEOS
  { name: 'Peter Finch',               channelId: 'UCFoez1XjcSLKm8MvEzJJIxQ' },     // youtube.com/@PeterFinchGolf
  { name: 'Scratch Golf Academy',      channelId: 'UCgz5RwEa7GOUOI34pJfBJHA' },     // youtube.com/@ScratchGolfAcademy — VERIFY IF 0 VIDEOS

  // ── New 4 (Session 4 — entertainment + instruction mix) ──
  { name: 'Danny Maude',               channelId: 'UCSwdmDQhAi_-ICkAvNBLEBw' },     // youtube.com/@danielmaude — top instructor, 1.6M subs
  { name: 'Golf Sidekick',             channelId: 'UCaeGjmOiTxekbGUDPKhoU-A' },     // youtube.com/@golfsidekick — course strategy, 355K subs
  { name: 'Not A Scratch Golfer',      channelId: 'UC3hrq3HFzlLv4z_Y_kQqmrw' },     // youtube.com/@NotAScratchGolfer — relatable course vlogs
  { name: 'Me and My Golf',            channelId: 'UCTwywdg9Sw5xs4wdN-qz7yw' },     // youtube.com/@meandmygolf — biggest instruction channel, 1M subs
];

const HOURS_FILTER = 336;  // Show videos from last 14 days (was 96h — too tight for weekly posters)

// ── CORS (caddie-manager needs to call this from the browser) ──
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
};

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).end();
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  try {
    const YT_KEY = process.env.YT_API_KEY || null;
    const cutoff = new Date(Date.now() - HOURS_FILTER * 60 * 60 * 1000);

    // ────────────────────────────────────────────
    // STEP 1: Fetch RSS feeds (FREE, no quota)
    // Each feed returns the channel's last ~15 videos.
    // Broken feeds are caught individually and skipped.
    // ────────────────────────────────────────────
    const results = await Promise.allSettled(
      CHANNELS.map(ch => fetchRSS(ch, cutoff))
    );

    let allVideos = [];
    const errors = [];
    const successChannels = [];

    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.length >= 0) {
        allVideos.push(...r.value);
        if (r.value.length > 0) successChannels.push(CHANNELS[i].name);
      } else {
        const msg = r.status === 'rejected' 
          ? r.reason?.message || 'Unknown error'
          : 'Empty feed';
        errors.push({ channel: CHANNELS[i].name, error: msg });
      }
    });

    // Deduplicate (some videos might appear in multiple channels via collabs)
    const seen = new Set();
    allVideos = allVideos.filter(v => {
      if (seen.has(v.videoId)) return false;
      seen.add(v.videoId);
      return true;
    });

    // ────────────────────────────────────────────
    // STEP 2: Enrich with YouTube API (duration + views)
    // videos.list costs 1 unit per batch of up to 50 IDs.
    // ~100 videos = 2 API calls = 2 quota units.
    // Without API key, videos still show — just no duration/views.
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

        // Filter out Shorts (under 90 seconds)
        allVideos = allVideos.filter(v => !v.durationSeconds || v.durationSeconds >= 90);
      }
    } else if (!YT_KEY) {
      enrichmentStatus = 'no_api_key';
    }

    // ────────────────────────────────────────────
    // STEP 3: Sort newest first and return
    // ────────────────────────────────────────────
    allVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    const payload = {
      videos: allVideos,
      lastUpdated: new Date().toISOString(),
      videoCount: allVideos.length,
      channelCount: successChannels.length,
      channels: successChannels,
      enrichment: enrichmentStatus,
      errors: errors.length > 0 ? errors : undefined,
    };

    // Try Vercel KV if available (for persistent cache between cron runs)
    try {
      const kv = require('@vercel/kv');
      await kv.set('tmr:video-cache', JSON.stringify(payload), { ex: 86400 });
    } catch (_) {
      // KV not set up yet — fine, we return JSON directly
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
  // Skip placeholder channels that haven't been configured yet
  if (channel.channelId.startsWith('PLACEHOLDER')) {
    return [];
  }

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
    throw new Error(`HTTP ${response.status} for ${channel.name} (ID may be wrong)`);
  }

  const xml = await response.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });

  const entries = parsed?.feed?.entry;
  if (!entries) return [];

  const list = Array.isArray(entries) ? entries : [entries];

  return list
    .map(entry => ({
      videoId:     entry['yt:videoId'],
      title:       entry.title,
      channel:     channel.name,
      channelId:   channel.channelId,
      thumbnail:   `https://i.ytimg.com/vi/${entry['yt:videoId']}/hqdefault.jpg`,
      publishedAt: entry.published,
      duration:    null,
      views:       null,
      durationSeconds: 0,
    }))
    .filter(v => v.videoId && new Date(v.publishedAt) >= cutoff);
}


async function enrichVideos(videoIds, apiKey) {
  const map = {};

  // Batch 50 IDs per API call (YouTube limit)
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${batch.join(',')}&key=${apiKey}`;

    try {
      const r = await fetch(url);
      const data = await r.json();

      if (data.error) {
        console.error('[TMR] API error:', JSON.stringify(data.error));
        break; // Stop enrichment if quota exceeded — videos still work without it
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
      // Continue — partial enrichment is better than none
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
