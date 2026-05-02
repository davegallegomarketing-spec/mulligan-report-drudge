/* ════════════════════════════════════════════════════════════════════
   THE CADDIE'S PICK / CLUBHOUSE TV — Loader
   Fetches videos.json and renders the section into #caddiesPickRoot
   ════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  var ROOT_ID    = 'caddiesPickRoot';
  var DATA_URL   = 'videos.json';
  var YT_WATCH   = 'https://www.youtube.com/watch?v=';
  var YT_THUMB   = 'https://i.ytimg.com/vi/';
  var ARCHIVE_URL = '#archives';

  /* HTML escape helper — never trust JSON on a page */
  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  /* maxres URL with hqdefault fallback (handled inline via onerror) */
  function thumbHTML(id, alt){
    var maxres = YT_THUMB + encodeURIComponent(id) + '/maxresdefault.jpg';
    var hq     = YT_THUMB + encodeURIComponent(id) + '/hqdefault.jpg';
    return '<img src="'+maxres+'" alt="'+esc(alt)+'" '+
           'onerror="if(this.dataset.f!==\'1\'){this.dataset.f=\'1\';this.src=\''+hq+'\';}">';
  }

  function watchURL(id){ return YT_WATCH + encodeURIComponent(id); }

  /* ── Hero card ─────────────────────────────────────────────────── */
  function renderHero(h){
    return ''+
    '<div class="cp-hero">'+
      '<a href="'+watchURL(h.youtube_id)+'" class="cp-card" target="_blank" rel="noopener">'+
        thumbHTML(h.youtube_id, h.title)+
        '<span class="cp-badge">Caddie\u2019s Pick</span>'+
        '<span class="cp-views">'+esc(h.views)+'</span>'+
        '<span class="cp-play"></span>'+
        '<div class="cp-overlay">'+
          '<div class="cp-overlay-title">'+esc(h.title)+'</div>'+
          '<div class="cp-overlay-meta">'+
            '<span class="cp-channel">'+esc(h.channel)+'</span>'+
            '<span class="cp-dur">'+esc(h.duration)+'</span>'+
          '</div>'+
        '</div>'+
      '</a>'+
    '</div>'+

    '<div class="cp-headline">'+
      '<a href="'+watchURL(h.youtube_id)+'" target="_blank" rel="noopener">'+esc(h.title)+'</a>'+
      '<div class="cp-meta-line">'+
        '<span class="cp-channel">'+esc(h.channel)+'</span>'+
        '<span class="sep">\u00b7</span>'+esc(h.views)+' views'+
        '<span class="sep">\u00b7</span>'+esc(h.duration)+
        '<span class="sep">\u00b7</span>YouTube'+
      '</div>'+
    '</div>'+

    '<blockquote class="cp-quote">'+
      '<p>'+esc(h.caddie_quote)+'</p>'+
      '<span class="cp-attr">\u2014 The Caddie</span>'+
    '</blockquote>';
  }

  /* ── Carousel mini-cards ───────────────────────────────────────── */
  function renderMini(v){
    return ''+
    '<a href="'+watchURL(v.youtube_id)+'" class="cp-card-mini" target="_blank" rel="noopener">'+
      '<div class="cp-thumb">'+
        thumbHTML(v.youtube_id, v.title)+
        '<span class="cp-thumb-dur">'+esc(v.duration)+'</span>'+
      '</div>'+
      '<div class="cp-mini-title">'+esc(v.title)+'</div>'+
      '<div class="cp-mini-meta">'+
        '<span class="cp-channel">'+esc(v.channel)+'</span> \u00b7 '+esc(v.views)+
      '</div>'+
    '</a>';
  }

  /* ── Full section ──────────────────────────────────────────────── */
  function renderSection(data){
    var miniHTML = '';
    for (var i = 0; i < data.carousel.length; i++){
      miniHTML += renderMini(data.carousel[i]);
    }

    return ''+
    '<section class="cp-section">'+

      '<div class="cp-header">'+
        '<div class="cp-wordmark">'+
          '<span class="cp-logo"></span>'+
          '<span class="cp-wordmark-text">CLUBHOUSE TV</span>'+
        '</div>'+
        '<div class="cp-sub">Caddie\u2019s Pick \u00b7 Curated daily</div>'+
      '</div>'+

      renderHero(data.hero)+

      '<div class="cp-more">'+
        '<div class="cp-more-head">'+
          '<span class="cp-more-label">More from the Caddie</span>'+
          '<span class="cp-more-curated">Curated daily</span>'+
        '</div>'+
        '<div class="cp-grid">'+miniHTML+'</div>'+
        '<div class="cp-cta">'+
          '<a href="'+ARCHIVE_URL+'" rel="noopener">Browse the Archives \u2192</a>'+
        '</div>'+
      '</div>'+

    '</section>';
  }

  /* ── Init ──────────────────────────────────────────────────────── */
  function init(){
    var root = document.getElementById(ROOT_ID);
    if (!root) return;

    fetch(DATA_URL, { cache: 'no-store' })
      .then(function(r){
        if (!r.ok) throw new Error('HTTP '+r.status);
        return r.json();
      })
      .then(function(data){
        if (!data || !data.hero || !Array.isArray(data.carousel)){
          throw new Error('Bad schema');
        }
        root.innerHTML = renderSection(data);
      })
      .catch(function(err){
        /* Fail silently — section just won't render. Logged for debugging. */
        if (window.console) console.warn('[Caddie\u2019s Pick] load failed:', err);
        root.innerHTML = '';
      });
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
