const https = require('https');

function fetchJson(url) {
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

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('GIF API timeout'));
    });

    req.on('error', reject);
  });
}

async function searchGiphy(query, apiKey, limit = 24) {
  const q = String(query || '').trim();
  const isTrending = !q || q.toLowerCase() === 'trending';
  const endpoint = isTrending
    ? `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(apiKey)}&limit=${limit}&rating=pg-13`
    : `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(q)}&limit=${limit}&rating=pg-13`;

  const data = await fetchJson(endpoint);
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

async function searchTenor(query, apiKey, limit = 24) {
  const q = String(query || '').trim();
  const clientKey = process.env.TENOR_CLIENT_KEY || 'rustcord_web';
  const isTrending = !q || q.toLowerCase() === 'trending';
  const endpoint = isTrending
    ? `https://tenor.googleapis.com/v2/featured?key=${encodeURIComponent(apiKey)}&client_key=${encodeURIComponent(clientKey)}&limit=${limit}&media_filter=gif,tinygif`
    : `https://tenor.googleapis.com/v2/search?key=${encodeURIComponent(apiKey)}&client_key=${encodeURIComponent(clientKey)}&q=${encodeURIComponent(q)}&limit=${limit}&media_filter=gif,tinygif`;

  const data = await fetchJson(endpoint);
  const items = Array.isArray(data.results) ? data.results : [];

  return items
    .map((item) => {
      const formats = item && item.media_formats ? item.media_formats : {};
      const full = (formats.gif && formats.gif.url) || (formats.mediumgif && formats.mediumgif.url) || '';
      const preview = (formats.tinygif && formats.tinygif.url) || (formats.nanogif && formats.nanogif.url) || full;

      return {
        title: String(item.content_description || item.title || 'GIF').trim(),
        preview,
        url: full
      };
    })
    .filter((g) => /^https?:\/\//i.test(g.url) && /^https?:\/\//i.test(g.preview));
}

async function handleGifsRequest(req, res) {
  try {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const query = (parsedUrl.searchParams.get('q') || 'trending').slice(0, 100);
    const limit = Math.min(36, Math.max(6, Number(parsedUrl.searchParams.get('limit')) || 24));

    const giphyKey = process.env.GIPHY_API_KEY || '';
    const tenorKey = process.env.TENOR_API_KEY || '';

    let results = [];

    if (giphyKey) {
      results = await searchGiphy(query, giphyKey, limit);
    } else if (tenorKey) {
      results = await searchTenor(query, tenorKey, limit);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          results: [],
          error: 'Не задан GIPHY_API_KEY или TENOR_API_KEY в переменных окружения сервера'
        })
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ results }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ results: [], error: err.message || 'Ошибка запроса к GIF API' }));
  }
}

module.exports = { handleGifsRequest };
