// api/hot-takes.js — Shared "19th Hole" Birdie/Bogey vote pool. NO AI, no cost beyond the free DB.
//
// Stores vote tallies in Upstash Redis (the Vercel Marketplace database that replaced Vercel KV).
// Talks to it over its REST API with plain fetch, so there are NO npm packages to install —
// same dependency-free style as caddie-take.js.
//
// SETUP (one time): in the Vercel project that serves themulliganreport.com, add the
// "Upstash for Redis" Marketplace integration (Storage tab). It auto-injects the two env vars
// this file reads, KV_REST_API_URL and KV_REST_API_TOKEN. Then redeploy.
//
// DATA MODEL (Redis keys):
//   ht:<id>:b   -> count of Birdie (agree) votes for take <id>   (id = 0..4)
//   ht:<id>:g   -> count of Bogey (disagree) votes for take <id>
//   ht:played:<YYYY-MM-DD> -> how many people finished all 5 today

const URL_  = process.env.KV_REST_API_URL  || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const N = 5; // number of takes — must match the takes array in index.html

function today(){ return new Date().toISOString().slice(0, 10); }

async function redis(path){
  const r = await fetch(URL_ + path, { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (!r.ok) throw new Error('redis ' + r.status);
  const j = await r.json();
  return j.result;
}

async function readAll(){
  const keys = [];
  for (let i = 0; i < N; i++){ keys.push('ht:' + i + ':b', 'ht:' + i + ':g'); }
  keys.push('ht:played:' + today());
  const vals = await redis('/mget/' + keys.map(encodeURIComponent).join('/'));
  const takes = [];
  for (let i = 0; i < N; i++){
    takes.push({ b: parseInt(vals[i*2] || 0, 10), g: parseInt(vals[i*2 + 1] || 0, 10) });
  }
  return { takes: takes, playedToday: parseInt(vals[N*2] || 0, 10) };
}

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!URL_ || !TOKEN){
    return res.status(500).json({ error: 'Vote database not configured' });
  }

  try {
    if (req.method === 'GET'){
      return res.status(200).json(await readAll());
    }

    if (req.method === 'POST'){
      const body = req.body || {};

      // Mark one completed run (for the "played today" stat)
      if (body.complete){
        await redis('/incr/ht:played:' + today());
        return res.status(200).json(await readAll());
      }

      // Cast one vote
      const id = parseInt(body.id, 10);
      const choice = body.choice;
      if (!(id >= 0 && id < N) || (choice !== 'b' && choice !== 'g')){
        return res.status(400).json({ error: 'Invalid vote' });
      }
      await redis('/incr/ht:' + id + ':' + choice);
      return res.status(200).json(await readAll());
    }

    return res.status(405).json({ error: 'GET or POST only' });

  } catch (e){
    console.error('hot-takes error:', e);
    return res.status(500).json({ error: 'Vote pool temporarily unavailable' });
  }
};
