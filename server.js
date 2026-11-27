const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    // Без заданного секрета токены можно подделать. Генерируем случайный (сессии сбросятся при перезапуске).
    JWT_SECRET = crypto.randomBytes(48).toString('hex');
    console.warn('WARNING: JWT_SECRET не задан — использую случайный. Задай JWT_SECRET в переменных окружения.');
  } else {
    JWT_SECRET = 'dev-secret-change-me';
  }
}

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' || process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT,
      avatar_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_description TEXT NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_sticker_url TEXT NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_background TEXT NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_status TEXT NOT NULL DEFAULT 'auto';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_until TIMESTAMPTZ;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      id SERIAL PRIMARY KEY,
      user_a TEXT NOT NULL,
      user_b TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_a, user_b)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_messages (
      id SERIAL PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_reactions (
      id BIGSERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE (message_id, username, emoji)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_reactions (
      id BIGSERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE (message_id, username, emoji)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_pins (
      message_id INTEGER PRIMARY KEY REFERENCES direct_messages(id) ON DELETE CASCADE,
      pinned_by TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      PRIMARY KEY (group_id, username)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_messages (
      id SERIAL PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER;`);
  await pool.query(`ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id, id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages(sender, recipient, id);`);
}

const app = express();
app.set('trust proxy', 1); // Render стоит за прокси — иначе req.ip одинаковый для всех
app.use(express.json({ limit: '40mb' }));

// Простой in-memory лимитер: max попыток за окно на ключ (IP)
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'x';
    const now = Date.now();
    let e = hits.get(key);
    if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; hits.set(key, e); }
    e.count += 1;
    if (e.count > max) {
      res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      return res.status(429).json({ error: 'Слишком много попыток, попробуй позже' });
    }
    next();
  };
}
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const current = await pool.query('SELECT id, username, is_banned, ban_reason, ban_until FROM users WHERE id = $1 AND LOWER(username) = LOWER($2)', [decoded.id, decoded.username]);
    if (!current.rows.length) return res.status(401).json({ error: 'Аккаунт не найден' });
    const account = current.rows[0];
    if (account.is_banned && (!account.ban_until || new Date(account.ban_until).getTime() > Date.now())) {
      return res.status(403).json({ error: 'Аккаунт заблокирован', reason: account.ban_reason || 'Причина не указана', until: account.ban_until });
    }
    if (account.is_banned) await pool.query('UPDATE users SET is_banned = FALSE, ban_reason = \'\', ban_until = NULL WHERE id = $1', [account.id]);
    req.user = { id: account.id, username: account.username };
    return next();
  } catch {
    return res.status(401).json({ error: 'Сессия истекла' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || String(req.user.username).toLowerCase() !== 'ovarist') {
    return res.status(403).json({ error: 'Доступ только владельцу Auralis' });
  }
  return next();
}

function fetchJson(url, timeoutMs = 4500) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Rustcord-Server/1.0 (contact@rustcord.local)',
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

const gifCache = new Map();
const GIF_CACHE_TTL_MS = 10 * 60 * 1000;

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

async function searchWikimediaGifs(query, limit = 14) {
  const cleanQ = String(query || '').trim();
  const isTrending = !cleanQ || cleanQ.toLowerCase() === 'trending';
  const searchTerm = isTrending
    ? 'funny cat gif'
    : (cleanQ.toLowerCase().includes('gif') ? cleanQ : `${cleanQ} gif`);

  const endpoint =
    `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6` +
    `&gsrsearch=${encodeURIComponent(searchTerm)}&gsrlimit=20` +
    `&prop=imageinfo&iiprop=url|mime&iiurlwidth=200&format=json&origin=*`;

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

app.get('/api/gifs', authMiddleware, async (req, res) => {
  try {
    const query = String(req.query.q || 'trending').trim().slice(0, 100);
    const limit = Math.min(24, Math.max(6, Number(req.query.limit) || 14));
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
    console.error('GIF search error:', err);
    return res.status(502).json({ results: [], error: 'Ошибка загрузки GIF' });
  }
});

app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (username.length < 2 || username.length > 32) {
      return res.status(400).json({ error: 'Логин должен быть от 2 до 32 символов' });
    }
    if (password.length < 10) {
      return res.status(400).json({ error: 'Пароль должен быть минимум 10 символов' });
    }

    const exists = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'Такой логин уже занят' });
    }

    const hash = await bcrypt.hash(password, 10);
    const created = await pool.query(
      'INSERT INTO users (username, password_hash, nickname) VALUES ($1, $2, $1) RETURNING id, username, nickname, avatar_url',
      [username, hash]
    );
    const user = created.rows[0];
    return res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });

    const result = await pool.query(
      'SELECT id, username, password_hash, nickname, avatar_url, profile_description, profile_sticker_url, profile_background, is_banned, ban_reason, ban_until FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Неверный логин или пароль' });

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Неверный логин или пароль' });
    if (user.is_banned && (!user.ban_until || new Date(user.ban_until).getTime() > Date.now())) {
      return res.status(403).json({ error: 'Аккаунт заблокирован', reason: user.ban_reason || 'Причина не указана', until: user.ban_until });
    }
    if (user.is_banned) await pool.query('UPDATE users SET is_banned = FALSE, ban_reason = \'\', ban_until = NULL WHERE id = $1', [user.id]);

    return res.json({
      token: signToken(user),
      user: { id: user.id, username: user.username, nickname: user.nickname || '', avatar_url: user.avatar_url || '', profile_description: user.profile_description || '', profile_sticker_url: user.profile_sticker_url || '', profile_background: user.profile_background || '' }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
});


app.get('/api/admin/users', authMiddleware, adminOnly, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, nickname, profile_description, created_at, is_banned, ban_reason, ban_until
       FROM users ORDER BY created_at DESC NULLS LAST, id DESC`
    );
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Auralis-API-Version', '3.3.2');
    return res.json({ users: result.rows, apiVersion: '3.3.2' });
  } catch (err) {
    console.error('Admin users error:', err);
    return res.status(500).json({ error: 'Не удалось загрузить пользователей' });
  }
});

app.patch('/api/admin/users/:id/profile', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const nickname = String(req.body.nickname || '').trim();
    const thought = String(req.body.thought || '').trim();
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Некорректный пользователь' });
    if (nickname.length > 32 || thought.length > 50) return res.status(400).json({ error: 'Ник — до 32 символов, мысли — до 50' });
    const updated = await pool.query(
      'UPDATE users SET nickname = $1, profile_description = $2 WHERE id = $3 RETURNING id, username, nickname, profile_description',
      [nickname, thought, id]
    );
    if (!updated.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    const u = updated.rows[0];
    sendToUser(u.username, { type: 'profile-updated' });
    return res.json({ user: u });
  } catch (err) {
    console.error('Admin profile update error:', err);
    return res.status(500).json({ error: 'Не удалось изменить профиль' });
  }
});

app.post('/api/admin/users/:id/ban', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    const hoursRaw = req.body.hours;
    const hours = hoursRaw === null || hoursRaw === '' || hoursRaw === undefined ? null : Number(hoursRaw);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Некорректный пользователь' });
    if (!reason) return res.status(400).json({ error: 'Укажи причину блокировки' });
    if (hours !== null && (!Number.isFinite(hours) || hours < 1 || hours > 87600)) return res.status(400).json({ error: 'Срок — от 1 часа до 10 лет или пусто для бессрочной блокировки' });
    const until = hours === null ? null : new Date(Date.now() + hours * 3600000);
    const updated = await pool.query(
      'UPDATE users SET is_banned = TRUE, ban_reason = $1, ban_until = $2 WHERE id = $3 AND LOWER(username) <> \'ovarist\' RETURNING id, username, is_banned, ban_reason, ban_until',
      [reason, until, id]
    );
    if (!updated.rows.length) return res.status(404).json({ error: 'Пользователь не найден или это аккаунт владельца' });
    const u = updated.rows[0];
    for (const sock of (socketsByUser.get(u.username) || [])) { try { sock.close(4003, 'Аккаунт заблокирован'); } catch {} }
    return res.json({ user: u });
  } catch (err) {
    console.error('Admin ban error:', err);
    return res.status(500).json({ error: 'Не удалось заблокировать пользователя' });
  }
});

app.post('/api/admin/users/:id/unban', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Некорректный пользователь' });
    const updated = await pool.query(
      'UPDATE users SET is_banned = FALSE, ban_reason = \'\', ban_until = NULL WHERE id = $1 AND LOWER(username) <> \'ovarist\' RETURNING id, username',
      [id]
    );
    if (!updated.rows.length) return res.status(404).json({ error: 'Пользователь не найден или это аккаунт владельца' });
    sendToUser(updated.rows[0].username, { type: 'profile-updated' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Admin unban error:', err);
    return res.status(500).json({ error: 'Не удалось снять блокировку' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, username, nickname, avatar_url, profile_description, profile_sticker_url, profile_background FROM users WHERE id = $1', [req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/profile', authMiddleware, async (req, res) => {
  try {
    const nick = String(req.body.nickname || '').trim().slice(0, 32);
    const avatarUrl = String(req.body.avatar_url || '').trim();
    const description = String(req.body.profile_description || '').trim().slice(0, 120);
    const stickerUrl = String(req.body.profile_sticker_url || '').trim();
    const profileBackground = String(req.body.profile_background || '').trim();
    if (profileBackground.length > 480000 || (profileBackground && !(/^data:image\/(jpeg|png);base64,/i.test(profileBackground) || /^linear-gradient\(125deg,#[0-9a-f]{6},#[0-9a-f]{6}\)$/i.test(profileBackground)))) return res.status(400).json({ error: 'Некорректный фон профиля или файл слишком большой' });
    if (avatarUrl && !/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(avatarUrl)) {
      return res.status(400).json({ error: 'Некорректный формат аватарки' });
    }
    if (avatarUrl.length > 650000) {
      return res.status(400).json({ error: 'Аватарка слишком большая' });
    }
    if (stickerUrl) {
      const stickerMatches = stickerUrl.match(/(?:[\u2600-\u27BF\u2B50\u{1F300}-\u{1FAFF}])(?:\uFE0F|\u200D[\u2600-\u27BF\u2B50\u{1FAFF}])*/gu) || [];
      const numericSticker = /^(?:67|777|52|48)$/.test(stickerUrl);
      if (!numericSticker && (stickerMatches.length !== 1 || stickerMatches[0] !== stickerUrl)) {
        return res.status(400).json({ error: 'Выбери один стикер из набора' });
      }
      if (stickerUrl.length > 32) return res.status(400).json({ error: 'Слишком длинный стикер' });
    }
    const updated = await pool.query(
      'UPDATE users SET nickname = $1, avatar_url = $2, profile_description = $3, profile_sticker_url = $4, profile_background = $5 WHERE id = $6 RETURNING id, username, nickname, avatar_url, profile_description, profile_sticker_url, profile_background',
      [nick, avatarUrl, description, stickerUrl, profileBackground, req.user.id]
    );
    const user = updated.rows[0];
    res.json({ user });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Ошибка сохранения профиля' });
  }
});

app.get('/api/users/:username/profile', authMiddleware, async (req, res) => {
  try {
    const username = String(req.params.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Не указан логин пользователя' });
    const result = await pool.query('SELECT username, nickname, avatar_url, profile_description, profile_sticker_url, profile_background, presence_status FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (!result.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    const user = result.rows[0];
    const online = !!(socketsByUser.get(user.username)?.size);
    const presenceStatus = user.presence_status === 'ghost' ? 'ghost' : (online ? 'online' : 'offline');
    return res.json({ user: { ...user, online, presence_status: presenceStatus } });
  } catch (err) {
    console.error('Public profile error:', err);
    return res.status(500).json({ error: 'Ошибка загрузки профиля' });
  }
});

app.patch('/api/presence', authMiddleware, async (req, res) => {
  try {
    const status = req.body && req.body.status === 'ghost' ? 'ghost' : 'auto';
    await pool.query('UPDATE users SET presence_status = $1 WHERE id = $2', [status, req.user.id]);
    return res.json({ ok: true, presence_status: status });
  } catch (err) {
    console.error('Presence update error:', err);
    return res.status(500).json({ error: 'Не удалось обновить статус' });
  }
});
function setPrivateRevalidation(res) {
  // Cache only in the signed-in browser and revalidate before reuse.
  res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
  res.setHeader('Vary', 'Authorization');
}

app.get('/api/friends', authMiddleware, async (req, res) => {
  setPrivateRevalidation(res);
  try {
    const meName = req.user.username;
    const rows = await pool.query(
      `SELECT user_a, user_b FROM friendships WHERE status = 'accepted' AND (user_a = $1 OR user_b = $1)`,
      [meName]
    );
    const friendNames = rows.rows.map((r) => (r.user_a === meName ? r.user_b : r.user_a));
    if (!friendNames.length) return res.json({ friends: [], chats: [] });

    const profRows = await pool.query(
      'SELECT username, nickname, avatar_url, profile_description, profile_sticker_url, profile_background, presence_status FROM users WHERE username = ANY($1::text[])',
      [friendNames]
    );
    const profByName = new Map(profRows.rows.map((r) => [r.username, r]));

    const lastRows = await pool.query(
      `SELECT DISTINCT ON (peer) peer,
              CASE
                WHEN left(text, 9) = '__FILE__:' THEN '📎 Файл'
                WHEN left(text, 10) = '__VOICE__:' THEN 'Голосовое сообщение'
                WHEN left(text, 9) = '__CALL__:' THEN 'Звонок'
                ELSE left(text, 120)
              END AS text
       FROM (
         SELECT CASE WHEN sender = $1 THEN recipient ELSE sender END AS peer, text, id
         FROM direct_messages
         WHERE (sender = $1 AND recipient = ANY($2::text[])) OR (recipient = $1 AND sender = ANY($2::text[]))
       ) t ORDER BY peer, id DESC`,
      [meName, friendNames]
    );
    const lastByName = new Map(lastRows.rows.map((r) => [r.peer, r.text]));

    const friends = friendNames.map((name) => {
      const prof = profByName.get(name) || {};
      return {
        username: name,
        nickname: prof.nickname || '',
        avatar_url: prof.avatar_url || '',
        profile_description: prof.profile_description || '',
        profile_sticker_url: prof.profile_sticker_url || '', profile_background: prof.profile_background || '',
        presence_status: prof.presence_status === 'ghost' ? 'ghost' : (socketsByUser.get(name)?.size ? 'online' : 'offline'),
        lastMessage: lastByName.get(name) || ''
      };
    });
    res.json({ friends, chats: friends });
  } catch (err) {
    console.error('Friends error:', err);
    res.status(500).json({ error: 'Ошибка загрузки друзей' });
  }
});

app.get('/api/friends/requests', authMiddleware, async (req, res) => {
  try {
    const meName = req.user.username;
    const inc = await pool.query(
      `SELECT f.user_a, u.nickname, u.avatar_url
       FROM friendships f
       LEFT JOIN users u ON u.username = f.user_a
       WHERE f.status = 'pending' AND f.user_b = $1`,
      [meName]
    );
    res.json({
      incoming: inc.rows.map((r) => ({
        username: r.user_a,
        nickname: r.nickname || '',
        avatar_url: r.avatar_url || ''
      }))
    });
  } catch (err) {
    console.error('Requests error:', err);
    res.status(500).json({ error: 'Ошибка загрузки запросов' });
  }
});

app.post('/api/friends/request', authMiddleware, async (req, res) => {
  try {
    const meName = req.user.username;
    const targetName = String(req.body.username || '').trim();
    if (!targetName) return res.status(400).json({ error: 'Введите логин' });
    if (targetName.toLowerCase() === meName.toLowerCase()) {
      return res.status(400).json({ error: 'Нельзя добавить самого себя' });
    }

    const uRes = await pool.query('SELECT username FROM users WHERE LOWER(username) = LOWER($1)', [targetName]);
    if (!uRes.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    const realTarget = uRes.rows[0].username;

    const existing = await pool.query(
      `SELECT id, status FROM friendships
       WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)`,
      [meName, realTarget]
    );
    if (existing.rows.length) {
      const st = existing.rows[0].status;
      return res.status(400).json({ error: st === 'accepted' ? 'Уже в друзьях' : 'Запрос уже существует' });
    }

    await pool.query(
      `INSERT INTO friendships (user_a, user_b, status) VALUES ($1, $2, 'pending')`,
      [meName, realTarget]
    );
    sendToUser(realTarget, { type: 'friend-update' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Friend request error:', err);
    res.status(500).json({ error: 'Ошибка отправки запроса' });
  }
});

app.post('/api/friends/respond', authMiddleware, async (req, res) => {
  try {
    const meName = req.user.username;
    const fromUser = String(req.body.username || '').trim();
    const action = req.body.action;

    if (action === 'accept') {
      await pool.query(
        `UPDATE friendships SET status = 'accepted' WHERE user_a = $1 AND user_b = $2 AND status = 'pending'`,
        [fromUser, meName]
      );
    } else {
      await pool.query(
        `DELETE FROM friendships WHERE user_a = $1 AND user_b = $2 AND status = 'pending'`,
        [fromUser, meName]
      );
    }
    sendToUser(fromUser, { type: 'friend-update' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Respond error:', err);
    res.status(500).json({ error: 'Ошибка ответа на запрос' });
  }
});

app.post('/api/friends/remove', authMiddleware, async (req, res) => {
  try {
    const meName = req.user.username;
    const other = String(req.body.username || '').trim();
    await pool.query(
      `DELETE FROM friendships WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)`,
      [meName, other]
    );
    sendToUser(other, { type: 'friend-update' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Remove friend error:', err);
    res.status(500).json({ error: 'Ошибка удаления из друзей' });
  }
});

app.delete('/api/dm', authMiddleware, async (req, res) => {
  try {
    const meName = req.user.username;
    const peer = String(req.query.peer || '').trim();
    if (!peer || peer.toLowerCase() === meName.toLowerCase()) return res.status(400).json({ error: 'Некорректный собеседник' });
    const exists = await pool.query('SELECT username FROM users WHERE LOWER(username) = LOWER($1)', [peer]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    const realPeer = exists.rows[0].username;
    const deleted = await pool.query('DELETE FROM direct_messages WHERE (sender = $1 AND recipient = $2) OR (sender = $2 AND recipient = $1)', [meName, realPeer]);
    return res.json({ ok: true, deleted: deleted.rowCount || 0 });
  } catch (err) {
    console.error('DM clear error:', err);
    return res.status(500).json({ error: 'Не удалось очистить переписку' });
  }
});

app.get('/api/dm/pins', authMiddleware, async (req, res) => {
  setPrivateRevalidation(res);
  try {
    const meName = req.user.username;
    const peer = String(req.query.peer || '').trim();
    if (!peer || !(await canContact(meName, peer))) return res.status(403).json({ error: 'Нет доступа к этой переписке' });
    const r = await pool.query(
      `SELECT dm.id, dm.sender, dm.recipient, dm.text, dm.created_at, dp.pinned_by, dp.created_at AS pinned_at
       FROM dm_pins dp JOIN direct_messages dm ON dm.id = dp.message_id
       WHERE (dm.sender = $1 AND dm.recipient = $2) OR (dm.sender = $2 AND dm.recipient = $1)
       ORDER BY dp.created_at DESC LIMIT 30`,
      [meName, peer]
    );
    return res.json(r.rows);
  } catch (err) {
    console.error('DM pins error:', err);
    return res.status(500).json({ error: 'Не удалось загрузить закреплённые сообщения' });
  }
});

app.get('/api/dm', authMiddleware, async (req, res) => {
  setPrivateRevalidation(res);
  try {
    const meName = req.user.username;
    const peer = String(req.query.peer || '').trim();
    const r = await pool.query(
      `SELECT t.id, t.sender, t.recipient, t.text, t.created_at, t.edited_at, t.reply_to_id,
              rp.sender AS reply_sender,
              CASE
                WHEN rp.text IS NULL THEN NULL
                WHEN left(rp.text, 9) = '__FILE__:' THEN '📎 Файл'
                WHEN left(rp.text, 10) = '__VOICE__:' THEN 'Голосовое сообщение'
                WHEN left(rp.text, 9) = '__CALL__:' THEN 'Звонок'
                ELSE left(rp.text, 120)
              END AS reply_text,
              COALESCE((
                SELECT json_agg(json_build_object('emoji', x.emoji, 'count', x.reaction_count, 'mine', x.mine))
                FROM (
                  SELECT emoji, COUNT(*)::int AS reaction_count, bool_or(username = $1) AS mine
                  FROM dm_reactions WHERE message_id = t.id GROUP BY emoji
                ) x
              ), '[]'::json) AS reactions,
              EXISTS (SELECT 1 FROM dm_pins dp WHERE dp.message_id = t.id) AS pinned
       FROM (
         SELECT id, sender, recipient, text, created_at, edited_at, reply_to_id FROM direct_messages
         WHERE (sender = $1 AND recipient = $2) OR (sender = $2 AND recipient = $1)
         ORDER BY id DESC LIMIT 100
       ) t LEFT JOIN direct_messages rp ON rp.id = t.reply_to_id
       ORDER BY t.id ASC`,
      [meName, peer]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('DM fetch error:', err);
    res.status(500).json({ error: 'Ошибка загрузки сообщений' });
  }
});

// ---------- ICE (STUN/TURN) для звонков и демонстрации экрана ----------
// Только STUN не работает у многих пользователей (мобильный интернет, строгий NAT, VPN).
// Для надёжности задай на Render переменные TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL.
app.get('/api/ice', authMiddleware, (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const turnUrls = String(process.env.TURN_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ iceServers });
});

// ---------- Группы ----------
async function loadGroup(groupId) {
  const g = await pool.query('SELECT id, title, owner FROM groups WHERE id = $1', [groupId]);
  if (!g.rows.length) return null;
  const m = await pool.query(
    `SELECT gm.username, u.nickname, u.avatar_url
     FROM group_members gm LEFT JOIN users u ON u.username = gm.username
     WHERE gm.group_id = $1 ORDER BY gm.username`,
    [groupId]
  );
  const last = await pool.query(
    `SELECT CASE
       WHEN left(text, 9) = '__FILE__:' THEN '📎 Файл'
       WHEN left(text, 10) = '__VOICE__:' THEN 'Голосовое сообщение'
       WHEN left(text, 9) = '__CALL__:' THEN 'Звонок'
       ELSE left(text, 120)
     END AS text
     FROM group_messages WHERE group_id = $1 ORDER BY id DESC LIMIT 1`,
    [groupId]
  );
  const profiles = {};
  for (const r of m.rows) profiles[r.username] = { nickname: r.nickname || '', avatar_url: r.avatar_url || '' };
  return {
    id: g.rows[0].id,
    title: g.rows[0].title,
    owner: g.rows[0].owner,
    members: m.rows.map((r) => r.username),
    profiles,
    lastMessage: last.rows.length ? last.rows[0].text : ''
  };
}

async function isGroupMember(groupId, username) {
  const r = await pool.query('SELECT 1 FROM group_members WHERE group_id = $1 AND username = $2', [groupId, username]);
  return r.rows.length > 0;
}

async function existingUsernames(names) {
  const clean = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))].slice(0, 50);
  if (!clean.length) return [];
  const r = await pool.query('SELECT username FROM users WHERE LOWER(username) = ANY($1::text[])', [clean.map((n) => n.toLowerCase())]);
  return r.rows.map((x) => x.username);
}

app.get('/api/groups', authMiddleware, async (req, res) => {
  setPrivateRevalidation(res);
  try {
    const ids = await pool.query('SELECT group_id FROM group_members WHERE username = $1', [req.user.username]);
    const groups = [];
    for (const row of ids.rows) {
      const g = await loadGroup(row.group_id);
      if (g) groups.push(g);
    }
    res.json({ groups });
  } catch (err) {
    console.error('Groups list error:', err);
    res.status(500).json({ error: 'Ошибка загрузки групп' });
  }
});

app.post('/api/groups', authMiddleware, async (req, res) => {
  try {
    const me = req.user.username;
    const title = String(req.body.title || '').trim().slice(0, 60);
    const members = await existingUsernames(Array.isArray(req.body.members) ? req.body.members : []);
    const others = members.filter((u) => u !== me);
    if (!others.length) return res.status(400).json({ error: 'Добавь хотя бы одного участника' });

    const id = 'grp_' + crypto.randomBytes(8).toString('hex');
    await pool.query('INSERT INTO groups (id, title, owner) VALUES ($1, $2, $3)', [id, title, me]);
    for (const u of [me, ...others]) {
      await pool.query('INSERT INTO group_members (group_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, u]);
    }
    const group = await loadGroup(id);
    for (const u of others) sendToUser(u, { type: 'group-created', group });
    res.status(201).json({ group });
  } catch (err) {
    console.error('Group create error:', err);
    res.status(500).json({ error: 'Не удалось создать группу' });
  }
});

app.post('/api/groups/:id/invite', authMiddleware, async (req, res) => {
  try {
    const groupId = String(req.params.id);
    if (!(await isGroupMember(groupId, req.user.username))) {
      return res.status(403).json({ error: 'Ты не участник этой группы' });
    }
    const members = await existingUsernames(Array.isArray(req.body.members) ? req.body.members : []);
    if (!members.length) return res.status(400).json({ error: 'Некого добавлять' });
    const newcomers = [];
    for (const u of members) {
      const r = await pool.query(
        'INSERT INTO group_members (group_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING username',
        [groupId, u]
      );
      if (r.rows.length) newcomers.push(u);
    }
    if (newcomers.length) {
      const auditText = '__SYSTEM__:' + JSON.stringify({ actor: req.user.username, targets: newcomers, action: 'member-added', at: new Date().toISOString() });
      const saved = await pool.query(
        'INSERT INTO group_messages (group_id, sender, text) VALUES ($1, $2, $3) RETURNING id, group_id AS "groupId", sender, text, created_at',
        [groupId, req.user.username, auditText]
      );
      const recipients = await pool.query('SELECT username FROM group_members WHERE group_id = $1', [groupId]);
      for (const row of recipients.rows) sendToUser(row.username, { type: 'group-dm', groupId, message: saved.rows[0] });
    }
    const group = await loadGroup(groupId);
    for (const u of group.members) {
      sendToUser(u, { type: newcomers.includes(u) ? 'group-invited' : 'group-update', group });
    }
    res.json({ group });
  } catch (err) {
    console.error('Group invite error:', err);
    res.status(500).json({ error: 'Не удалось добавить участников' });
  }
});

app.get('/api/groups/:id/messages', authMiddleware, async (req, res) => {
  setPrivateRevalidation(res);
  try {
    const groupId = String(req.params.id);
    if (!(await isGroupMember(groupId, req.user.username))) {
      return res.status(403).json({ error: 'Нет доступа' });
    }
    const r = await pool.query(
      `SELECT t.id, t.group_id AS "groupId", t.sender, t.text, t.created_at, t.edited_at, t.reply_to_id,
              rp.sender AS reply_sender,
              CASE
                WHEN rp.text IS NULL THEN NULL
                WHEN left(rp.text, 9) = '__FILE__:' THEN '📎 Файл'
                WHEN left(rp.text, 10) = '__VOICE__:' THEN 'Голосовое сообщение'
                WHEN left(rp.text, 9) = '__CALL__:' THEN 'Звонок'
                ELSE left(rp.text, 120)
              END AS reply_text,
              COALESCE(gr.reactions, '[]'::json) AS reactions
       FROM (
         SELECT * FROM group_messages WHERE group_id = $1 ORDER BY id DESC LIMIT 100
       ) t LEFT JOIN group_messages rp ON rp.id = t.reply_to_id AND rp.group_id = t.group_id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('emoji', x.emoji, 'count', x.cnt, 'mine', x.mine) ORDER BY x.first_at) AS reactions
         FROM (
           SELECT emoji, COUNT(*)::int AS cnt, bool_or(username = $2) AS mine, MIN(created_at) AS first_at
           FROM group_reactions WHERE message_id = t.id GROUP BY emoji
         ) x
       ) gr ON TRUE
       ORDER BY t.id ASC`,
      [groupId, req.user.username]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('Group messages error:', err);
    res.status(500).json({ error: 'Ошибка загрузки сообщений' });
  }
});

// Журнал действий над участниками в истории группового чата.
app.post('/api/groups/:id/audit', authMiddleware, async (req, res) => {
  // Friend/block actions are intentionally not written into group chat history.
  res.json({ ok: true });
});

// Удаление участника группы с обязательной системной записью в истории.
app.post('/api/groups/:id/members/:username/remove', authMiddleware, async (req, res) => {
  try {
    const groupId = String(req.params.id);
    const actor = req.user.username;
    const targetParam = decodeURIComponent(String(req.params.username || '')).trim();
    const groupRow = await pool.query('SELECT owner FROM groups WHERE id = $1', [groupId]);
    if (!groupRow.rows.length) return res.status(404).json({ error: 'Группа не найдена' });
    if (groupRow.rows[0].owner !== actor) return res.status(403).json({ error: 'Удалять участников может только создатель группы' });
    const targetRow = await pool.query('SELECT username FROM group_members WHERE group_id = $1 AND LOWER(username) = LOWER($2)', [groupId, targetParam]);
    if (!targetRow.rows.length) return res.status(404).json({ error: 'Участник не найден в группе' });
    const target = targetRow.rows[0].username;
    if (target === actor) return res.status(400).json({ error: 'Создателя нельзя удалить из группы' });
    await pool.query('DELETE FROM group_members WHERE group_id = $1 AND username = $2', [groupId, target]);
    const auditText = '__SYSTEM__:' + JSON.stringify({ actor, target, action: 'member-removed', at: new Date().toISOString() });
    const saved = await pool.query(
      'INSERT INTO group_messages (group_id, sender, text) VALUES ($1, $2, $3) RETURNING id, group_id AS "groupId", sender, text, created_at',
      [groupId, actor, auditText]
    );
    const remaining = await pool.query('SELECT username FROM group_members WHERE group_id = $1', [groupId]);
    const members = remaining.rows.map(r => r.username);
    for (const username of members) sendToUser(username, { type: 'group-dm', groupId, message: saved.rows[0] });
    sendToUser(target, { type: 'group-removed', groupId, actor, target });
    const group = await loadGroup(groupId);
    for (const username of members) sendToUser(username, { type: 'group-update', group });
    res.json({ ok: true, group, removed: target });
  } catch (err) {
    console.error('Group member remove error:', err);
    res.status(500).json({ error: 'Не удалось удалить участника' });
  }
});

// Переименование группы — только создатель; рассылаем обновлённое название всем участникам.
app.patch('/api/groups/:id', authMiddleware, async (req, res) => {
  try {
    const groupId = String(req.params.id);
    const title = String(req.body.title || '').trim().slice(0, 60);
    if (!title) return res.status(400).json({ error: 'Название группы не может быть пустым' });
    const g = await pool.query('SELECT owner FROM groups WHERE id = $1', [groupId]);
    if (!g.rows.length) return res.status(404).json({ error: 'Группа не найдена' });
    if (g.rows[0].owner !== req.user.username) {
      return res.status(403).json({ error: 'Изменить название может только создатель группы' });
    }
    await pool.query('UPDATE groups SET title = $1 WHERE id = $2', [title, groupId]);
    const group = await loadGroup(groupId);
    for (const username of group.members) {
      sendToUser(username, { type: 'group-update', group });
    }
    return res.json({ group });
  } catch (err) {
    console.error('Group rename error:', err);
    return res.status(500).json({ error: 'Не удалось изменить название группы' });
  }
});

// Удаление группы — только создатель
app.delete('/api/groups/:id', authMiddleware, async (req, res) => {
  try {
    const groupId = String(req.params.id);
    const g = await pool.query('SELECT owner FROM groups WHERE id = $1', [groupId]);
    if (!g.rows.length) return res.status(404).json({ error: 'Группа не найдена' });
    if (g.rows[0].owner !== req.user.username) {
      return res.status(403).json({ error: 'Удалить группу может только её создатель' });
    }
    const members = await pool.query('SELECT username FROM group_members WHERE group_id = $1', [groupId]);
    await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
    for (const m of members.rows) sendToUser(m.username, { type: 'group-deleted', groupId });
    res.json({ ok: true });
  } catch (err) {
    console.error('Group delete error:', err);
    res.status(500).json({ error: 'Не удалось удалить группу' });
  }
});

// Выход из группы. Если после выхода остался только создатель — группа удаляется.
app.post('/api/groups/:id/leave', authMiddleware, async (req, res) => {
  try {
    const me = req.user.username;
    const groupId = String(req.params.id);
    const g = await pool.query('SELECT owner FROM groups WHERE id = $1', [groupId]);
    if (!g.rows.length) return res.status(404).json({ error: 'Группа не найдена' });
    if (!(await isGroupMember(groupId, me))) return res.status(403).json({ error: 'Ты не участник этой группы' });
    if (g.rows[0].owner === me) {
      return res.status(400).json({ error: 'Создатель не может выйти из группы — удали её' });
    }

    await pool.query('DELETE FROM group_members WHERE group_id = $1 AND username = $2', [groupId, me]);
    const left = await pool.query('SELECT username FROM group_members WHERE group_id = $1', [groupId]);
    const remaining = left.rows.map((r) => r.username);
    const onlyOwnerLeft = remaining.length <= 1;

    sendToUser(me, { type: 'group-deleted', groupId });
    if (onlyOwnerLeft) {
      await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
      for (const u of remaining) sendToUser(u, { type: 'group-deleted', groupId });
      return res.json({ ok: true, deleted: true });
    }

    const group = await loadGroup(groupId);
    for (const u of remaining) sendToUser(u, { type: 'group-update', group });
    res.json({ ok: true, deleted: false });
  } catch (err) {
    console.error('Group leave error:', err);
    res.status(500).json({ error: 'Не удалось выйти из группы' });
  }
});

// Неизвестные /api/* должны отдавать JSON 404, а не index.html (иначе клиент ловит «Unexpected token <»)
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

// Explicit health check for the deployed web process.
app.get('/healthz', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({ ok: true, service: 'rustcord' });
});

// Serve the app shell explicitly before express.static so browser/CDN caches
// cannot keep an older index.html after a successful deployment.
app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('X-Rustcord-Entry', 'server-root-v2');
  res.sendFile(INDEX_FILE);
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
}));

app.use((_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(INDEX_FILE);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 40 * 1024 * 1024 });
const socketsByUser = new Map();

function sendToUser(username, payload) {
  const set = socketsByUser.get(username);
  if (!set) return;
  const raw = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(raw); } catch (err) { console.warn('WebSocket send failed:', err.message); } }
  }
}

// Можно ли писать/звонить: друзья или общая группа. Кэш на 30 с, т.к. signal шлёт много сообщений.
const contactCache = new Map();
async function canContact(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const key = a < b ? a + '\u0000' + b : b + '\u0000' + a;
  const hit = contactCache.get(key);
  if (hit && Date.now() < hit.exp) return hit.ok;
  const r = await pool.query(
    `SELECT 1 FROM friendships WHERE status = 'accepted'
       AND ((user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1))
     UNION ALL
     SELECT 1 FROM group_members g1 JOIN group_members g2 ON g1.group_id = g2.group_id
       WHERE g1.username = $1 AND g2.username = $2
     LIMIT 1`,
    [a, b]
  );
  const ok = r.rows.length > 0;
  if (contactCache.size > 5000) contactCache.clear();
  contactCache.set(key, { ok, exp: Date.now() + 30000 });
  return ok;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function isValidMessagePayload(rawText) {
  if (!rawText) return false;
  if (/^__VOICE__:data:audio\/[a-zA-Z0-9.+-]+;base64,/.test(rawText)) {
    return rawText.length <= 2000000;
  }
  if (rawText.startsWith('__FILE__:')) {
    const jsonPart = rawText.slice('__FILE__:'.length);
    if (jsonPart.length > 36 * 1024 * 1024) return false;
    try {
      const obj = JSON.parse(jsonPart);
      if (!obj || typeof obj.name !== 'string' || typeof obj.dataUrl !== 'string') return false;
      const isDataUrl = /^data:/i.test(obj.dataUrl);
      const isHttpUrl = /^https?:\/\//i.test(obj.dataUrl) && obj.dataUrl.length <= 2048;
      if (!isDataUrl && !isHttpUrl) return false;
      if (Number(obj.size || 0) > MAX_FILE_BYTES) return false;
      return true;
    } catch {
      return false;
    }
  }
  return rawText.length <= 4000;
}

function isValidEditText(t) {
  return !!t && t.length <= 4000 && !/^__(VOICE|FILE|CALL)__:/.test(t);
}

// Heartbeat: без него прокси Render/провайдеры тихо рвут «молчащие» WebSocket-соединения
const HEARTBEAT_MS = 25000;
const heartbeat = setInterval(() => {
  for (const sock of wss.clients) {
    if (sock.isAlive === false) { sock.terminate(); continue; }
    sock.isAlive = false;
    try { sock.ping(); } catch {}
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

wss.on('connection', (ws) => {
  ws.username = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});

  ws.on('message', async (buf) => {
    let data;
    try { data = JSON.parse(buf.toString()); } catch { return; }
    if (!data || typeof data.type !== 'string') return;

    if (data.type === 'auth-token') {
      try {
        const decoded = jwt.verify(String(data.token || ''), JWT_SECRET);
        if (!decoded || !decoded.username) throw new Error('Invalid token');
        const account = await pool.query('SELECT id, username, is_banned, ban_reason, ban_until FROM users WHERE id = $1 AND LOWER(username) = LOWER($2)', [decoded.id, decoded.username]);
        if (!account.rows.length) throw new Error('Account not found');
        const currentUser = account.rows[0];
        if (currentUser.is_banned && (!currentUser.ban_until || new Date(currentUser.ban_until).getTime() > Date.now())) {
          try { ws.send(JSON.stringify({ type: 'auth-error', error: 'Аккаунт заблокирован: ' + (currentUser.ban_reason || 'причина не указана') })); } catch {}
          return;
        }
        if (currentUser.is_banned) await pool.query('UPDATE users SET is_banned = FALSE, ban_reason = $1, ban_until = NULL WHERE id = $2', ['', currentUser.id]);
        if (ws.username && socketsByUser.has(ws.username)) {
          const oldSockets = socketsByUser.get(ws.username);
          oldSockets.delete(ws);
          if (!oldSockets.size) socketsByUser.delete(ws.username);
        }
        ws.username = String(decoded.username);
        if (!socketsByUser.has(ws.username)) socketsByUser.set(ws.username, new Set());
        socketsByUser.get(ws.username).add(ws);
        ws.send(JSON.stringify({ type: 'auth-ok' }));
      } catch {
        try { ws.send(JSON.stringify({ type: 'auth-error', error: 'Сессия истекла. Войди снова.' })); } catch {}
      }
      return;
    }

    if (!ws.username) return;

    if (data.type === 'dm') {
      const to = String(data.to || '').trim();
      const rawText = String(data.text || '').trim();
      const replyToId = data.replyToId == null ? null : Number(data.replyToId);
      if (!to || !isValidMessagePayload(rawText) || (replyToId !== null && (!Number.isInteger(replyToId) || replyToId < 1))) return;
      try {
        if (!(await canContact(ws.username, to))) return;
        if (replyToId !== null) {
          const target = await pool.query(
            `SELECT id FROM direct_messages WHERE id = $1
             AND ((sender = $2 AND recipient = $3) OR (sender = $3 AND recipient = $2))`,
            [replyToId, ws.username, to]
          );
          if (!target.rows.length) return;
        }
        const saved = await pool.query(
          `INSERT INTO direct_messages (sender, recipient, text, reply_to_id) VALUES ($1, $2, $3, $4)
           RETURNING id, sender, recipient, text, created_at, reply_to_id`,
          [ws.username, to, rawText, replyToId]
        );
        const quoted = await pool.query(
          `SELECT dm.id, dm.sender, dm.recipient, dm.text, dm.created_at, dm.reply_to_id,
                  rp.sender AS reply_sender, rp.text AS reply_text
           FROM direct_messages dm LEFT JOIN direct_messages rp ON rp.id = dm.reply_to_id
           WHERE dm.id = $1`,
          [saved.rows[0].id]
        );
        const msgObj = quoted.rows[0] || saved.rows[0];
        sendToUser(ws.username, { type: 'dm', message: msgObj });
        sendToUser(to, { type: 'dm', message: msgObj });
      } catch (err) {
        console.error('DM error:', err);
      }
      return;
    }

    if (data.type === 'group-dm') {
      const groupId = String(data.groupId || '').trim();
      const rawText = String(data.text || '').trim();
      const replyToId = data.replyToId == null ? null : Number(data.replyToId);
      if (!groupId || !isValidMessagePayload(rawText) || (replyToId !== null && (!Number.isInteger(replyToId) || replyToId < 1))) return;
      try {
        if (!(await isGroupMember(groupId, ws.username))) return;
        if (replyToId !== null) {
          const target = await pool.query('SELECT id FROM group_messages WHERE id = $1 AND group_id = $2', [replyToId, groupId]);
          if (!target.rows.length) return;
        }
        const saved = await pool.query(
          `INSERT INTO group_messages (group_id, sender, text, reply_to_id) VALUES ($1, $2, $3, $4)
           RETURNING id, group_id AS "groupId", sender, text, created_at, reply_to_id`,
          [groupId, ws.username, rawText, replyToId]
        );
        const quoted = await pool.query(
          `SELECT gm.id, gm.group_id AS "groupId", gm.sender, gm.text, gm.created_at, gm.reply_to_id,
                  rp.sender AS reply_sender, rp.text AS reply_text
           FROM group_messages gm LEFT JOIN group_messages rp
             ON rp.id = gm.reply_to_id AND rp.group_id = gm.group_id
           WHERE gm.id = $1`,
          [saved.rows[0].id]
        );
        const members = await pool.query('SELECT username FROM group_members WHERE group_id = $1', [groupId]);
        const payload = { type: 'group-dm', groupId, message: quoted.rows[0] || saved.rows[0] };
        for (const m of members.rows) sendToUser(m.username, payload);
      } catch (err) {
        console.error('Group DM error:', err);
      }
      return;
    }

    // Реакции в личных сообщениях: только участники переписки, whitelist эмодзи.
    if (data.type === 'dm-reaction') {
      const id = Number(data.id);
      const emoji = String(data.emoji || '');
      const allowed = new Set(['👍','❤️','😂','🔥','😮','😢','👏','🎉','🤔','👀']);
      if (!Number.isInteger(id) || id < 1 || !allowed.has(emoji)) return;
      try {
        const msg = await pool.query(
          'SELECT sender, recipient FROM direct_messages WHERE id = $1 AND (sender = $2 OR recipient = $2)',
          [id, ws.username]
        );
        if (!msg.rows.length) return;
        const { sender, recipient } = msg.rows[0];
        const existing = await pool.query(
          'SELECT id FROM dm_reactions WHERE message_id = $1 AND username = $2 AND emoji = $3',
          [id, ws.username, emoji]
        );
        if (existing.rows.length) {
          await pool.query('DELETE FROM dm_reactions WHERE message_id = $1 AND username = $2 AND emoji = $3', [id, ws.username, emoji]);
        } else {
          await pool.query('INSERT INTO dm_reactions (message_id, username, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, ws.username, emoji]);
        }
        const grouped = await pool.query(
          `SELECT emoji, COUNT(*)::int AS count, bool_or(username = $2) AS mine
           FROM dm_reactions WHERE message_id = $1 GROUP BY emoji ORDER BY MIN(created_at)`,
          [id, ws.username]
        );
        const payload = { type: 'dm-reaction-updated', id, reactions: grouped.rows };
        sendToUser(sender, payload);
        sendToUser(recipient, payload);
      } catch (err) { console.error('DM reaction error:', err); }
      return;
    }

    // Реакции в групповых сообщениях.
    if (data.type === 'group-reaction') {
      const id = Number(data.id);
      const groupId = String(data.groupId || '').trim();
      const emoji = String(data.emoji || '');
      const allowed = new Set(['👍','❤️','😂','🔥','😮','😢','👏','🎉','🤔','👀']);
      if (!Number.isInteger(id) || id < 1 || !groupId || !allowed.has(emoji)) return;
      try {
        if (!(await isGroupMember(groupId, ws.username))) return;
        const msg = await pool.query('SELECT id FROM group_messages WHERE id = $1 AND group_id = $2', [id, groupId]);
        if (!msg.rows.length) return;
        const existing = await pool.query('SELECT id FROM group_reactions WHERE message_id = $1 AND username = $2 AND emoji = $3', [id, ws.username, emoji]);
        if (existing.rows.length) await pool.query('DELETE FROM group_reactions WHERE message_id = $1 AND username = $2 AND emoji = $3', [id, ws.username, emoji]);
        else await pool.query('INSERT INTO group_reactions (message_id, username, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, ws.username, emoji]);
        const members = await pool.query('SELECT username FROM group_members WHERE group_id = $1', [groupId]);
        const grouped = await pool.query(
          `SELECT emoji, COUNT(*)::int AS count, bool_or(username = $2) AS mine
           FROM group_reactions WHERE message_id = $1 GROUP BY emoji ORDER BY MIN(created_at)`,
          [id, ws.username]
        );
        const payload = { type: 'group-reaction-updated', groupId, id, reactions: grouped.rows };
        for (const member of members.rows) sendToUser(member.username, payload);
      } catch (err) { console.error('Group reaction error:', err); }
      return;
    }

    // Закрепление сообщения в личном чате — доступно обоим участникам.
    if (data.type === 'dm-pin') {
      const id = Number(data.id);
      const pinned = !!data.pinned;
      if (!Number.isInteger(id) || id < 1) return;
      try {
        const msg = await pool.query(
          'SELECT sender, recipient FROM direct_messages WHERE id = $1 AND (sender = $2 OR recipient = $2)',
          [id, ws.username]
        );
        if (!msg.rows.length) return;
        const { sender, recipient } = msg.rows[0];
        if (pinned) {
          await pool.query(
            'INSERT INTO dm_pins (message_id, pinned_by) VALUES ($1, $2) ON CONFLICT (message_id) DO NOTHING',
            [id, ws.username]
          );
        } else {
          await pool.query('DELETE FROM dm_pins WHERE message_id = $1', [id]);
        }
        const pinInfo = await pool.query(
          'SELECT pinned_by, created_at FROM dm_pins WHERE message_id = $1',
          [id]
        );
        const payload = { type: 'dm-pin-updated', id, pinned: pinInfo.rows.length > 0, pin: pinInfo.rows[0] || null };
        sendToUser(sender, payload);
        sendToUser(recipient, payload);
      } catch (err) { console.error('DM pin error:', err); }
      return;
    }

    // Редактирование своих текстовых сообщений (не файлов, не голосовых, не записей о звонках)
    if (data.type === 'edit-dm') {
      const id = Number(data.id);
      const rawText = String(data.text || '').trim();
      if (!Number.isInteger(id) || !isValidEditText(rawText)) return;
      try {
        const r = await pool.query(
          `UPDATE direct_messages SET text = $1, edited_at = NOW()
           WHERE id = $2 AND sender = $3 AND text !~ '^__(VOICE|FILE|CALL)__:'
           RETURNING id, sender, recipient, text, created_at, edited_at`,
          [rawText, id, ws.username]
        );
        if (!r.rows.length) return;
        const payload = { type: 'message-edited', scope: 'dm', message: r.rows[0] };
        sendToUser(r.rows[0].sender, payload);
        sendToUser(r.rows[0].recipient, payload);
      } catch (err) {
        console.error('Edit DM error:', err);
      }
      return;
    }

    if (data.type === 'edit-group') {
      const id = Number(data.id);
      const groupId = String(data.groupId || '').trim();
      const rawText = String(data.text || '').trim();
      if (!Number.isInteger(id) || !groupId || !isValidEditText(rawText)) return;
      try {
        if (!(await isGroupMember(groupId, ws.username))) return;
        const r = await pool.query(
          `UPDATE group_messages SET text = $1, edited_at = NOW()
           WHERE id = $2 AND group_id = $3 AND sender = $4 AND text !~ '^__(VOICE|FILE|CALL)__:'
           RETURNING id, group_id AS "groupId", sender, text, created_at, edited_at`,
          [rawText, id, groupId, ws.username]
        );
        if (!r.rows.length) return;
        const members = await pool.query('SELECT username FROM group_members WHERE group_id = $1', [groupId]);
        const payload = { type: 'message-edited', scope: 'group', groupId, message: r.rows[0] };
        for (const m of members.rows) sendToUser(m.username, payload);
      } catch (err) {
        console.error('Edit group message error:', err);
      }
      return;
    }

    // Удаление своих сообщений (кроме записей о звонках)
    if (data.type === 'delete-dm') {
      const id = Number(data.id);
      if (!Number.isInteger(id)) return;
      try {
        const r = await pool.query(
          `DELETE FROM direct_messages WHERE id = $1 AND sender = $2 AND text !~ '^__CALL__:'
           RETURNING id, sender, recipient`,
          [id, ws.username]
        );
        if (!r.rows.length) return;
        const payload = { type: 'message-deleted', scope: 'dm', id: r.rows[0].id };
        sendToUser(r.rows[0].sender, payload);
        sendToUser(r.rows[0].recipient, payload);
      } catch (err) {
        console.error('Delete DM error:', err);
      }
      return;
    }

    if (data.type === 'delete-group') {
      const id = Number(data.id);
      const groupId = String(data.groupId || '').trim();
      if (!Number.isInteger(id) || !groupId) return;
      try {
        if (!(await isGroupMember(groupId, ws.username))) return;
        const r = await pool.query(
          `DELETE FROM group_messages WHERE id = $1 AND group_id = $2 AND sender = $3 AND text !~ '^__CALL__:'
           RETURNING id`,
          [id, groupId, ws.username]
        );
        if (!r.rows.length) return;
        const members = await pool.query('SELECT username FROM group_members WHERE group_id = $1', [groupId]);
        const payload = { type: 'message-deleted', scope: 'group', groupId, id: r.rows[0].id };
        for (const m of members.rows) sendToUser(m.username, payload);
      } catch (err) {
        console.error('Delete group message error:', err);
      }
      return;
    }

    if (data.type === 'call-end' && data.callContext && data.callContext.kind === 'group' && data.callId) {
      // Group call termination is authoritative on the server: use the live
      // membership table instead of the caller's possibly stale local cache.
      const groupId = String(data.callContext.id || '');
      if (!groupId) return;
      try {
        const membership = await pool.query(
          'SELECT 1 FROM group_members WHERE group_id = $1 AND username = $2',
          [groupId, ws.username]
        );
        if (!membership.rows.length) return;
        const members = await pool.query(
          'SELECT username FROM group_members WHERE group_id = $1 AND username <> $2',
          [groupId, ws.username]
        );
        const payload = {
          type: 'call-end',
          from: ws.username,
          callContext: { kind: 'group', id: groupId },
          callId: String(data.callId)
        };
        for (const member of members.rows) sendToUser(member.username, payload);
      } catch (err) {
        console.error('Group call termination error:', err);
      }
      return;
    }

    if (data.type === 'call-invite' || data.type === 'call-accept' || data.type === 'call-reject' || data.type === 'call-end') {
      if (data.to && data.callId) {
        const target = String(data.to);
        const ctx = data.callContext || null;
        try {
          if (!(await canContact(ws.username, target))) return;
          if (ctx && ctx.kind === 'group') {
            if (!(await isGroupMember(String(ctx.id), ws.username)) || !(await isGroupMember(String(ctx.id), target))) return;
          }
        } catch { return; }
        sendToUser(target, { type: data.type, from: ws.username, callContext: ctx, callId: String(data.callId) });
      }
      return;
    }

    if (data.type === 'call-state' && data.to && data.callId && data.callContext) {
      try {
        if (!(await canContact(ws.username, String(data.to)))) return;
        if (data.callContext.kind === 'group' &&
            (!(await isGroupMember(String(data.callContext.id), ws.username)) ||
             !(await isGroupMember(String(data.callContext.id), String(data.to))))) return;
      } catch { return; }
      sendToUser(String(data.to), {
        type: 'call-state',
        from: ws.username,
        callContext: data.callContext,
        callId: String(data.callId),
        state: { micMuted: !!(data.state && data.state.micMuted), deafened: !!(data.state && data.state.deafened) }
      });
      return;
    }

    if (data.type === 'signal' && data.to) {
      try {
        if (!(await canContact(ws.username, String(data.to)))) return;
        if (data.callContext && data.callContext.kind === 'group' &&
            (!(await isGroupMember(String(data.callContext.id), ws.username)) ||
             !(await isGroupMember(String(data.callContext.id), String(data.to))))) return;
      } catch { return; }
      sendToUser(String(data.to), {
        type: 'signal',
        from: ws.username,
        callContext: data.callContext || null,
        callId: data.callId ? String(data.callId) : null,
        signal: data.signal
      });
    }
  });

  ws.on('close', () => {
    if (ws.username && socketsByUser.has(ws.username)) {
      const set = socketsByUser.get(ws.username);
      set.delete(ws);
      if (set.size === 0) socketsByUser.delete(ws.username);
    }
  });
});

initDb()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log('Rustcord server started on port ' + PORT);
    });
  })
  .catch((err) => {
    console.error('DB init error:', err);
    process.exit(1);
  });
