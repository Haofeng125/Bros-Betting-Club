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
    balance INTEGER NOT NULL DEFAULT 10000,
    loan_amount INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_a TEXT NOT NULL,
    team_b TEXT NOT NULL,
    deadline TEXT NOT NULL,
    odds_a REAL NOT NULL DEFAULT 1.0,
    odds_b REAL NOT NULL DEFAULT 1.0,
    status TEXT NOT NULL DEFAULT 'open',
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
    FOREIGN KEY (game_id) REFERENCES games(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(game_id, user_id)
  );
`);

// Migrations for existing databases
try { db.exec(`ALTER TABLE games ADD COLUMN odds_a REAL DEFAULT 1.0`); } catch (_) {}
try { db.exec(`ALTER TABLE games ADD COLUMN odds_b REAL DEFAULT 1.0`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN weekly_profit INTEGER NOT NULL DEFAULT 0`); } catch (_) {}

// Rename legacy admin username
try { db.prepare(`UPDATE users SET username = '宋昊峰' WHERE username = 'admin' AND is_admin = 1`).run(); } catch (_) {}

const adminExists = db.prepare('SELECT id FROM users WHERE is_admin = 1').get();
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`INSERT INTO users (username, password, is_admin) VALUES ('宋昊峰', ?, 1)`).run(hash);
  console.log('默认管理员账户已创建 — 用户名: 宋昊峰  密码: admin123');
}

module.exports = db;
