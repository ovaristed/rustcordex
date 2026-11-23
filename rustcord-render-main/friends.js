const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { sendToUser } = require('../ws');

const router = express.Router();
router.use(authMiddleware);

// Список подтвержденных друзей
router.get('/', async (req, res) => {
  try {
    const meName = req.user.username;
    const rows = await pool.query(
      `SELECT user_a, user_b FROM friendships WHERE status = 'accepted' AND (user_a = $1 OR user_b = $1)`,
      [meName]
    );

    const friendNames = rows.rows.map((r) => (r.user_a === meName ? r.user_b : r.user_a));
    const friends = [];

    for (const name of friendNames) {
      const uRow = await pool.query('SELECT nickname, avatar_url FROM users WHERE username = $1', [name]);
      const prof = uRow.rows[0] || {};
      const last = await pool.query(
        `SELECT text FROM direct_messages
         WHERE (sender = $1 AND recipient = $2) OR (sender = $2 AND recipient = $1)
         ORDER BY id DESC LIMIT 1`,
        [meName, name]
      );

      friends.push({
        username: name,
        nickname: prof.nickname || name,
        avatar_url: prof.avatar_url || '',
        lastMessage: last.rows.length ? last.rows[0].text : ''
      });
    }

    res.json({ friends, chats: friends });
  } catch (err) {
    console.error('Ошибка загрузки списка друзей:', err);
    res.status(500).json({ error: 'Ошибка загрузки друзей' });
  }
});

// Список входящих заявок в друзья
router.get('/requests', async (req, res) => {
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
        nickname: r.nickname || r.user_a,
        avatar_url: r.avatar_url || ''
      }))
    });
  } catch (err) {
    console.error('Ошибка получения заявок:', err);
    res.status(500).json({ error: 'Ошибка загрузки запросов' });
  }
});

// Отправить заявку в друзья
router.post('/request', async (req, res) => {
  try {
    const meName = req.user.username;
    const targetName = String(req.body.username || '').trim();

    if (!targetName) return res.status(400).json({ error: 'Введите логин пользователя' });
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
    console.error('Ошибка создания запроса в друзья:', err);
    res.status(500).json({ error: 'Ошибка отправки запроса' });
  }
});

// Принять или отклонить заявку в друзья
router.post('/respond', async (req, res) => {
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
    sendToUser(meName, { type: 'friend-update' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка ответа на запрос:', err);
    res.status(500).json({ error: 'Ошибка ответа на запрос' });
  }
});

// Удалить из друзей
router.post('/remove', async (req, res) => {
  try {
    const meName = req.user.username;
    const other = String(req.body.username || '').trim();

    await pool.query(
      `DELETE FROM friendships WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)`,
      [meName, other]
    );

    sendToUser(other, { type: 'friend-update' });
    sendToUser(meName, { type: 'friend-update' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка удаления друга:', err);
    res.status(500).json({ error: 'Ошибка удаления из друзей' });
  }
});

module.exports = router;
