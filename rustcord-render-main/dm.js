const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Получить историю личных сообщений
router.get('/', async (req, res) => {
  try {
    const meName = req.user.username;
    const peer = String(req.query.peer || '').trim();

    if (!peer) {
      return res.status(400).json({ error: 'Не указан собеседник (peer)' });
    }

    const r = await pool.query(
      `SELECT id, sender, recipient, text, created_at FROM (
         SELECT id, sender, recipient, text, created_at FROM direct_messages
         WHERE (sender = $1 AND recipient = $2) OR (sender = $2 AND recipient = $1)
         ORDER BY id DESC LIMIT 100
       ) t ORDER BY id ASC`,
      [meName, peer]
    );

    res.json(r.rows);
  } catch (err) {
    console.error('Ошибка загрузки сообщений DM:', err);
    res.status(500).json({ error: 'Ошибка загрузки сообщений' });
  }
});

module.exports = router;
