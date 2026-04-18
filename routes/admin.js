const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');

const ROLES = ['赌徒', '嘴硬的数学老师', '操盘老哥', '怂蛋', '变色龙', '张哥', '种植', '哈登球迷', '无角色'];

module.exports = (JWT_SECRET) => {
  const router = express.Router();

  function requireAdmin(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: '未授权' });
    try {
      const user = jwt.verify(token, JWT_SECRET);
      if (!user.isAdmin) return res.status(403).json({ error: '无权限' });
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: '未授权' });
    }
  }

  // ── 玩家管理 ──

  router.get('/users', requireAdmin, (req, res) => {
    const users = db.prepare(`
      SELECT id, username, role, balance, loan_amount, harden_tokens, is_admin
      FROM users ORDER BY balance DESC
    `).all();
    res.json(users);
  });

  router.post('/users', requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password || !role)
      return res.json({ success: false, error: '请填写完整信息' });
    if (!ROLES.includes(role))
      return res.json({ success: false, error: '无效角色' });

    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) return res.json({ success: false, error: '用户名已存在' });

    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(username, hash, role);
    res.json({ success: true });
  });

  router.put('/users/:id', requireAdmin, (req, res) => {
    const { role, balance, password } = req.body;
    const id = parseInt(req.params.id);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.json({ success: false, error: '用户不存在' });

    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id);
    }
    if (role !== undefined && ROLES.includes(role))
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    if (balance !== undefined && !isNaN(balance))
      db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(parseInt(balance), id);

    res.json({ success: true });
  });

  router.delete('/users/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.json({ success: false, error: '用户不存在' });
    if (user.is_admin) return res.json({ success: false, error: '不能删除管理员账户' });
    db.prepare('DELETE FROM bets WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM cooldowns WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM seed_picks WHERE seeder_id = ? OR target_id = ?').run(id, id);
    db.prepare('DELETE FROM chameleon_log WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ success: true });
  });

  // ── 比赛管理 ──

  router.get('/games', requireAdmin, (req, res) => {
    const games = db.prepare('SELECT * FROM games ORDER BY created_at DESC LIMIT 30').all();
    res.json(games);
  });

  router.post('/games', requireAdmin, (req, res) => {
    const { team_a, team_b, deadline } = req.body;
    if (!team_a || !team_b || !deadline)
      return res.json({ success: false, error: '请填写完整比赛信息' });

    db.prepare(`
      INSERT INTO games (team_a, team_b, deadline, status) VALUES (?, ?, ?, 'pending')
    `).run(team_a, team_b, deadline);

    res.json({ success: true });
  });

  router.delete('/games/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!game) return res.json({ success: false, error: '比赛不存在' });
    if (game.status === 'settled') return res.json({ success: false, error: '已结算的比赛不能删除' });
    db.prepare('DELETE FROM bets WHERE game_id = ?').run(id);
    db.prepare('DELETE FROM seed_picks WHERE game_id = ?').run(id);
    db.prepare('DELETE FROM games WHERE id = ?').run(id);
    res.json({ success: true });
  });

  return router;
};
