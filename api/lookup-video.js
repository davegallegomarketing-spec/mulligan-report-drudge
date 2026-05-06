// /api/lookup-video.js
// ═══════════════════════════════════════════════════════════════
// THE MULLIGAN REPORT — Single Video Lookup
//
// Called when Aaron pastes a YouTube URL in the Caddie Manager
// and the video isn't in the cached feed.
//
// Cost: 1 quota unit per lookup (videos.list)
// API key stays server-side — not exposed in HTML.
// ═══════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).end();
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const videoId = req.query.id;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  const apiKey = process.env.YT_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'YT_API_KEY not configured' });
  }

  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoId}&key=${apiKey}`;
    const r = await fetch(url);
    const data = await r.json();

    if (data.error) {
      return res.status(502).json({ error: data.error.message });
    }

    if (!data.items || data.items.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const item = data.items[0];
    const dur = parseDuration(item.contentDetails.duration);

    return res.status(200).json({
      videoId: videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.high?.url
        || item.snippet.thumbnails.medium?.url
        || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: dur.formatted,
      durationSeconds: dur.seconds,
      views: formatViews(parseInt(item.statistics?.viewCount || '0')),
      publishedAt: item.snippet.publishedAt,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};


function parseDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return { formatted: '0:00', seconds: 0 };
  const h = parseInt(m[1] || 0);
  const min = parseInt(m[2] || 0);
  const sec = parseInt(m[3] || 0);
  const total = h * 3600 + min * 60 + sec;
  const fmt = h > 0
    ? `${h}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${min}:${String(sec).padStart(2, '0')}`;
  return { formatted: fmt, seconds: total };
}

function formatViews(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n);
}
