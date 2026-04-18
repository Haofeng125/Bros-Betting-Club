const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'db', 'game.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '无角色',
    balance INTEGER NOT NULL DEFAULT 10000,
    loan_amount INTEGER NOT NULL DEFAULT 0,
    harden_tokens INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_a TEXT NOT NULL,
    team_b TEXT NOT NULL,
    deadline TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    winner TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    team TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    is_hidden INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (game_id) REFERENCES games(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(game_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS cooldowns (
    user_id INTEGER NOT NULL,
    ability TEXT NOT NULL,
    games_remaining INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, ability)
  );

  CREATE TABLE IF NOT EXISTS seed_picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    seeder_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    UNIQUE(game_id, seeder_id)
  );

  CREATE TABLE IF NOT EXISTS chameleon_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    assigned_role TEXT,
    date TEXT NOT NULL,
    UNIQUE(user_id, date)
  );
`);

const adminExists = db.prepare('SELECT id FROM users WHERE is_admin = 1').get();
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`
    INSERT INTO users (username, password, role, is_admin)
    VALUES ('admin', ?, '管理员', 1)
  `).run(hash);
  console.log('默认管理员账户已创建 — 用户名: admin  密码: admin123');
}

module.exports = db;
