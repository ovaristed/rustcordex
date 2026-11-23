const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.warn('⚠️ Внимание: Переменная DATABASE_URL не задана. База данных не подключена.');
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.NODE_ENV === 'production' || (databaseUrl && databaseUrl.includes('render.com'))
    ? { rejectUnauthorized: false }
    : false
});

async function initDb() {
  if (!databaseUrl) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Таблица пользователей
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        nickname TEXT,
        avatar_url TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));`);

    // Таблица дружбы / запросов в друзья
    await client.query(`
      CREATE TABLE IF NOT EXISTS friendships (
        id SERIAL PRIMARY KEY,
        user_a TEXT NOT NULL,
        user_b TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(user_a, user_b)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_friendships_users ON friendships (user_a, user_b);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_friendships_incoming ON friendships (user_b, status);`);

    // Таблица личных сообщений
    await client.query(`
      CREATE TABLE IF NOT EXISTS direct_messages (
        id SERIAL PRIMARY KEY,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages(sender, recipient, id);`);

    // Таблица групповых чатов
    await client.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Таблица участников групп
    await client.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        PRIMARY KEY (group_id, username)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(username);`);

    // Таблица сообщений в группах
    await client.query(`
      CREATE TABLE IF NOT EXISTS group_messages (
        id SERIAL PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id, id);`);

    await client.query('COMMIT');
    console.log('✅ База данных успешно инициализирована');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Ошибка инициализации таблиц БД:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initDb
};
