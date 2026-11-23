const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { sendToUser } = require('../ws');

const router = express.Router();
router.use(authMiddleware);

async function loadGroup(groupId) {
  const g = await pool.query('SELECT id, title, owner FROM groups WHERE id = $1', [groupId]);
  if (!g.rows.length) return null;

  const m = await pool.query(
    `SELECT gm.username, u.nickname, u.avatar_url
     FROM group_members gm
     LEFT JOIN users u ON u.username = gm.username
     WHERE gm.group_id = $1 ORDER BY gm.username`,
    [groupId]
  );

  const last = await pool.query(
    'SELECT text FROM group_messages WHERE group_id = $1 ORDER BY id DESC LIMIT 1',
    [groupId]
  );

  const profiles = {};
  for (const r of m.rows) {
    profiles[r.username] = {
      nickname: r.nickname || r.username,
      avatar_url: r.avatar_url || ''
    };
  }

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

// Список групп текущего пользователя
router.get('/', async (req, res) => {
  try {
    const ids = await pool.query('SELECT group_id FROM group_members WHERE username = $1', [req.user.username]);
    const groups = [];
    for (const row of ids.rows) {
      const g = await loadGroup(row.group_id);
      if (g) groups.push(g);
    }
    res.json({ groups });
  } catch (err) {
    console.error('Ошибка получения списка групп:', err);
    res.status(500).json({ error: 'Ошибка загрузки групп' });
  }
});

// Создать новую группу
router.post('/', async (req, res) => {
  try {
    const me = req.user.username;
    const title = String(req.body.title || '').trim().slice(0, 60);
    const members = await existingUsernames(Array.isArray(req.body.members) ? req.body.members : []);
    const others = members.filter((u) => u !== me);

    if (!others.length) {
      return res.status(400).json({ error: 'Добавьте хотя бы одного участника' });
    }

    const id = 'grp_' + crypto.randomBytes(8).toString('hex');
    await pool.query('INSERT INTO groups (id, title, owner) VALUES ($1, $2, $3)', [id, title, me]);

    for (const u of [me, ...others]) {
      await pool.query('INSERT INTO group_members (group_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, u]);
    }

    const group = await loadGroup(id);
    for (const u of others) {
      sendToUser(u, { type: 'group-created', group });
    }

    res.status(201).json({ group });
  } catch (err) {
    console.error('Ошибка создания группы:', err);
    res.status(500).json({ error: 'Не удалось создать группу' });
  }
});

// Добавить участников в существующую группу
router.post('/:id/invite', async (req, res) => {
  try {
    const groupId = String(req.params.id);
    if (!(await isGroupMember(groupId, req.user.username))) {
      return res.status(403).json({ error: 'Вы не являетесь участником этой группы' });
    }

    const members = await existingUsernames(Array.isArray(req.body.members) ? req.body.members : []);
    if (!members.length) {
      return res.status(400).json({ error: 'Не выбраны пользователи для добавления' });
    }

    const newcomers = [];
    for (const u of members) {
      const r = await pool.query(
        'INSERT INTO group_members (group_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING username',
        [groupId, u]
      );
      if (r.rows.length) newcomers.push(u);
    }

    const group = await loadGroup(groupId);
    for (const u of group.members) {
      sendToUser(u, { type: newcomers.includes(u) ? 'group-invited' : 'group-update', group });
    }

    res.json({ group });
  } catch (err) {
    console.error('Ошибка добавления участников:', err);
    res.status(500).json({ error: 'Не удалось добавить участников' });
  }
});

// Получить историю сообщений группы
router.get('/:id/messages', async (req, res) => {
  try {
    const groupId = String(req.params.id);
    if (!(await isGroupMember(groupId, req.user.username))) {
      return res.status(403).json({ error: 'Нет доступа к сообщениям этой группы' });
    }

    const r = await pool.query(
      `SELECT id, group_id AS "groupId", sender, text, created_at FROM (
         SELECT * FROM group_messages WHERE group_id = $1 ORDER BY id DESC LIMIT 100
       ) t ORDER BY id ASC`,
      [groupId]
    );

    res.json(r.rows);
  } catch (err) {
    console.error('Ошибка загрузки сообщений группы:', err);
    res.status(500).json({ error: 'Ошибка загрузки сообщений' });
  }
});

// Удалить группу (только владелец)
router.delete('/:id', async (req, res) => {
  try {
    const groupId = String(req.params.id);
    const g = await pool.query('SELECT owner FROM groups WHERE id = $1', [groupId]);
    if (!g.rows.length) return res.status(404).json({ error: 'Группа не найдена' });

    if (g.rows[0].owner !== req.user.username) {
      return res.status(403).json({ error: 'Удалить группу может только её создатель' });
    }

    const members = await pool.query('SELECT username FROM group_members WHERE group_id = $1', [groupId]);
    await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);

    for (const m of members.rows) {
      sendToUser(m.username, { type: 'group-deleted', groupId });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка удаления группы:', err);
    res.status(500).json({ error: 'Не удалось удалить группу' });
  }
});

// Покинуть группу
router.post('/:id/leave', async (req, res) => {
  try {
    const me = req.user.username;
    const groupId = String(req.params.id);
    const g = await pool.query('SELECT owner FROM groups WHERE id = $1', [groupId]);
    if (!g.rows.length) return res.status(404).json({ error: 'Группа не найдена' });

    if (!(await isGroupMember(groupId, me))) {
      return res.status(403).json({ error: 'Вы не являетесь участником этой группы' });
    }

    if (g.rows[0].owner === me) {
      return res.status(400).json({ error: 'Создатель не может просто покинуть группу — удалите её' });
    }

    await pool.query('DELETE FROM group_members WHERE group_id = $1 AND username = $2', [groupId, me]);
    const left = await pool.query('SELECT username FROM group_members WHERE group_id = $1', [groupId]);
    const remaining = left.rows.map((r) => r.username);
    const onlyOwnerLeft = remaining.length <= 1;

    sendToUser(me, { type: 'group-deleted', groupId });

    if (onlyOwnerLeft) {
      await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
      for (const u of remaining) {
        sendToUser(u, { type: 'group-deleted', groupId });
      }
      return res.json({ ok: true, deleted: true });
    }

    const group = await loadGroup(groupId);
    for (const u of remaining) {
      sendToUser(u, { type: 'group-update', group });
    }

    res.json({ ok: true, deleted: false });
  } catch (err) {
    console.error('Ошибка выхода из группы:', err);
    res.status(500).json({ error: 'Не удалось выйти из группы' });
  }
});

module.exports = {
  router,
  loadGroup,
  isGroupMember
};
