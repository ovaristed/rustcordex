const express = require('express');
const https = require('https');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const gifCache = new Map();
const GIF_CACHE_TTL_MS = 15 * 60 * 1000; // 15 минут

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Rustcord-Server/1.0',
          'Accept': 'application/json'
        }
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('GIF API timeout'));
    });

    req.on('error', reject);
  });
}

function getCachedGifs(key) {
  const entry = gifCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    gifCache.delete(key);
    return null;
  }
  return entry.results;
}

function setCachedGifs(key, results) {
  if (gifCache.size > 200) {
    const firstKey = gifCache.keys().next().value;
    if (firstKey) gifCache.delete(firstKey);
  }
  gifCache.set(key, {
    results,
    expiresAt: Date.now() + GIF_CACHE_TTL_MS
  });
}

function scoreGifRelevance(title, query) {
  const words = String(query || '')
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((w) => w.length >= 2 && w !== 'gif' && w !== 'trending');
  if (!words.length) return 1;
  const hay = String(title || '').toLowerCase();
  let hits = 0;
  for (const w of words) {
    if (hay.includes(w)) hits += 1;
  }
  return hits;
}

async function searchWikimediaGifs(query, limit = 16) {
  const cleanQ = String(query || '').trim();
  const isTrending = !cleanQ || cleanQ.toLowerCase() === 'trending';
  const searchTerm = isTrending
    ? 'funny animated gif'
    : (cleanQ.toLowerCase().includes('gif') ? cleanQ : `${cleanQ} gif`);

  const endpoint =
    `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6` +
    `&gsrsearch=${encodeURIComponent(searchTerm)}&gsrlimit=24` +
    `&prop=imageinfo&iiprop=url|mime&iiurlwidth=260&format=json&origin=*`;

  const data = await fetchJson(endpoint, 4500);
  const pages = data && data.query && data.query.pages ? Object.values(data.query.pages) : [];

  const scored = pages
    .map((p) => {
      const info = Array.isArray(p.imageinfo) && p.imageinfo[0] ? p.imageinfo[0] : null;
      if (!info || info.mime !== 'image/gif' || !info.url) return null;
      const title = String(p.title || 'GIF').replace(/^File:/i, '').replace(/\.gif$/i, '');
      const score = isTrending ? 1 : scoreGifRelevance(title, cleanQ);
      return {
        title,
        preview: info.thumburl || info.url,
        url: info.url,
        score
      };
    })
    .filter(Boolean);

  const matched = isTrending ? scored : scored.filter((item) => item.score > 0);
  const pool = matched.length ? matched : scored;

  return pool
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ title, preview, url }) => ({ title, preview, url }));
}

async function searchGiphy(query, apiKey, limit = 16) {
  const q = String(query || '').trim();
  const isTrending = !q || q.toLowerCase() === 'trending';
  const endpoint = isTrending
    ? `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(apiKey)}&limit=${limit}&rating=pg-13`
    : `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(q)}&limit=${limit}&rating=pg-13`;

  const data = await fetchJson(endpoint, 4500);
  const items = Array.isArray(data.data) ? data.data : [];

  return items
    .map((item) => {
      const imgs = item && item.images ? item.images : {};
      const full = (imgs.original && imgs.original.url) || (imgs.downsized && imgs.downsized.url) || '';
      const preview =
        (imgs.fixed_width_small && imgs.fixed_width_small.url) ||
        (imgs.fixed_width && imgs.fixed_width.url) ||
        (imgs.preview_gif && imgs.preview_gif.url) ||
        full;

      return {
        title: String(item.title || 'GIF').trim(),
        preview,
        url: full
      };
    })
    .filter((g) => /^https?:\/\//i.test(g.url) && /^https?:\/\//i.test(g.preview));
}

// Поиск GIF
router.get('/', async (req, res) => {
  try {
    const query = String(req.query.q || 'trending').trim().slice(0, 100);
    const limit = Math.min(32, Math.max(6, Number(req.query.limit) || 16));
    const giphyKey = process.env.GIPHY_API_KEY || '';
    const cacheKey = `${query.toLowerCase()}::${limit}::${giphyKey ? 'giphy' : 'wiki'}`;

    const cached = getCachedGifs(cacheKey);
    if (cached) {
      return res.json({ results: cached, cached: true });
    }

    const tasks = [searchWikimediaGifs(query, limit).catch(() => [])];
    if (giphyKey) {
      tasks.push(searchGiphy(query, giphyKey, limit).catch(() => []));
    }

    const groups = await Promise.all(tasks);
    const seen = new Set();
    const results = [];

    for (const group of groups) {
      for (const item of group) {
        if (!item || !item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        results.push(item);
      }
    }

    setCachedGifs(cacheKey, results);
    return res.json({ results });
  } catch (err) {
    console.error('Ошибка поиска GIF:', err);
    return res.status(502).json({ results: [], error: 'Ошибка загрузки GIF' });
  }
});

module.exports = router;
